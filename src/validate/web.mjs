import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { assertEquivalent, assertSnapshot, expectedStyles, loadFixture, poll, rowKey, saveEvidence, VISUAL_PROPERTIES } from './contract.mjs'
import { createArtifactServer } from './server.mjs'

async function readSnapshot(page, elements, width) {
  const requests = elements.map(element => ({ id: element.id, properties: [...new Set([...VISUAL_PROPERTIES, ...Object.keys(expectedStyles(element, width))])] }))
  // One browser round trip even for the 1000-use fixtures. Native components
  // render in Shadow DOM, so ordinary document.querySelector is insufficient.
  return page.evaluate((items) => {
    const ids = new Map()
    const visit = (scope) => {
      for (const node of scope.querySelectorAll('*')) {
        if (node.id && !ids.has(node.id)) ids.set(node.id, node)
        if (node.shadowRoot) visit(node.shadowRoot)
      }
    }
    visit(document)
    return Object.fromEntries(items.flatMap(({ id, properties }) => {
      const node = ids.get(id)
      if (!node) return []
      const styles = getComputedStyle(node)
      const box = node.getBoundingClientRect()
      return [[id, { styles: Object.fromEntries(properties.map(key => [key, styles[key]])), box: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height } }]]
    }))
  }, requests)
}

async function launchRoute(page, origin, route) {
  const response = await page.goto(`${origin}/`, { waitUntil: 'load' })
  assert.ok(response?.ok(), `H5 entry returned HTTP ${response?.status()}; serve the actual directory containing index.html`)
  await page.waitForFunction(() => typeof globalThis.wx?.reLaunch === 'function' && globalThis.getCurrentPages?.().length > 0)
  await page.evaluate(async (url) => {
    try { await globalThis.wx.reLaunch({ url }) }
    catch (error) { throw new Error(`reLaunch ${url}: ${error?.errMsg ?? String(error)}`) }
  }, route.path)
  await page.locator(`[id="${route.rootId}"]`).waitFor({ state: 'attached' })
  await page.evaluate(async () => { await document.fonts.ready })
}

async function compareImage(buffer, reference, filename, directory) {
  const image = PNG.sync.read(buffer)
  const baseline = PNG.sync.read(reference)
  assert.equal(image.width, baseline.width, `${filename}: screenshot widths differ`)
  assert.equal(image.height, baseline.height, `${filename}: screenshot heights differ`)
  const diff = new PNG({ width: image.width, height: image.height })
  const count = pixelmatch(baseline.data, image.data, diff.data, image.width, image.height, { threshold: 0.1, includeAA: false })
  const ratio = count / (image.width * image.height)
  if (count) await writeFile(path.join(directory, `${filename}.diff.png`), PNG.sync.write(diff))
  assert.ok(ratio <= 0.005, `${filename}: ${(ratio * 100).toFixed(3)}% pixels differ from handwritten CSS (maximum 0.5%)`)
  return { differentPixels: count, totalPixels: image.width * image.height, ratio }
}

export async function closeWebBrowser({ context, browser, resource }) {
  const errors = []
  try { await context?.close() } catch (error) { errors.push(error) }
  // A failed context close must still release this task's browser process.
  try { await browser?.close(); if (resource) resource.closed = true }
  catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'H5 browser cleanup failed')
}

export async function validateWeb(rows, { root, evidenceDirectory }) {
  const selected = rows.filter(row => row.target === 'web').sort((a, b) => Number(b.scheme === 'reference') - Number(a.scheme === 'reference') || rowKey(a).localeCompare(rowKey(b)))
  assert.ok(selected.length, 'No H5 artifacts to validate')
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const report = { status: 'running', headless: true, browser: null, viewports: [375, 768], pixelComparison: { package: `pixelmatch@${pkg.devDependencies.pixelmatch}`, threshold: 0.1, includeAA: false }, maximumPixelDifference: 0.005, geometryTolerancePx: 0.75, artifacts: [], resources: [] }
  const references = new Map()
  const server = await createArtifactServer()
  const serverResource = { kind: 'static-server', origin: server.origin, closed: false }
  report.resources.push(serverResource)
  let browser
  let context
  let failure
  try {
    await mkdir(evidenceDirectory, { recursive: true })
    browser = await chromium.launch({ headless: true })
    report.browser = { name: 'chromium', version: browser.version() }
    const browserResource = { kind: 'browser', headless: true, closed: false }
    report.resources.push(browserResource)
    context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', reducedMotion: 'reduce' })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    for (const row of selected) {
      const fixture = await loadFixture(row)
      const label = rowKey(row)
      const record = { key: label, status: 'running', routes: [] }
      report.artifacts.push(record)
      server.select(row.directory)
      pageErrors.length = 0
      for (const width of report.viewports) {
        await page.setViewportSize({ width, height: 900 })
        for (const route of fixture.routes) {
          await launchRoute(page, server.origin, route)
          const rpxWidth = await page.evaluate(() => document.querySelector('#app')?.getBoundingClientRect().width ?? innerWidth)
          const states = [{ name: 'initial', checks: route.elements }, ...(route.actions ?? []).map(action => ({ name: action.state, checks: action.checks, action }))]
          const checks = new Map(route.elements.map(element => [element.id, element]))
          for (const state of states) {
            if (state.action) {
              await page.locator(`[id="${state.action.id}"]`).click()
              for (const check of state.checks) checks.set(check.id, { ...checks.get(check.id), ...check, styles: { ...checks.get(check.id)?.styles, ...check.styles } })
              if (state.action.data) {
                await poll(async () => {
                  const data = await page.evaluate(() => globalThis.getCurrentPages().at(-1).data)
                  for (const [key, value] of Object.entries(state.action.data)) assert.deepEqual(data[key], value, `${label}: state data ${key}`)
                }, `${label}: ${state.name} data`)
              }
            }
            const elements = [...checks.values()]
            const snapshot = await poll(async () => {
              assert.deepEqual(pageErrors, [], `${label}: browser runtime errors`)
              const actual = await readSnapshot(page, elements, width)
              assertSnapshot(actual, elements, { width, rpxWidth, label: `${label} ${route.path} ${state.name}` })
              return actual
            }, `${label}: ${state.name} computed styles`)
            const baselineKey = [row.profile, row.scenario, width, route.path, state.name].join('/')
            const filename = [row.scheme, row.profile, row.scenario, width, route.path.replaceAll('/', '-'), state.name].join('_')
            const capture = row.scenario === 'gallery' || row.scenario === 'application' || (width === 375 && state.name === 'initial')
            let screenshot
            if (capture) screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: row.scenario === 'gallery' || row.scenario === 'application' })
            const stateRecord = { route: route.path, width, state: state.name, elements: elements.length, snapshotSha256: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') }
            if (row.scheme === 'reference') references.set(baselineKey, { snapshot, screenshot })
            else if (row.scheme !== 'unstyled') {
              const reference = references.get(baselineKey)
              assert.ok(reference, `${label}: missing handwritten CSS reference ${baselineKey}`)
              assertEquivalent(snapshot, reference.snapshot, { label: `${label} ${state.name} ${width}` })
              if (capture) stateRecord.pixels = await compareImage(screenshot, reference.screenshot, filename, evidenceDirectory)
            }
            if (capture) {
              await writeFile(path.join(evidenceDirectory, `${filename}.png`), screenshot)
              stateRecord.screenshot = path.relative(root, path.join(evidenceDirectory, `${filename}.png`)).split(path.sep).join('/')
            }
            if (row.scenario === 'gallery' || row.scenario === 'application') {
              await saveEvidence(evidenceDirectory, `${filename}.computed.json`, snapshot)
            }
            record.routes.push(stateRecord)
          }
          for (const navigation of route.navigation ?? []) {
            await launchRoute(page, server.origin, route)
            await page.locator(`[id="${navigation.id}"]`).click()
            await poll(async () => {
              const actual = await page.evaluate(() => globalThis.getCurrentPages().at(-1).route)
              assert.equal(actual.replace(/^\//, ''), navigation.path.replace(/^\//, ''), `${label}: navigation ${navigation.id}`)
            }, `${label}: ${navigation.method} ${navigation.path}`)
            record.routes.push({ route: route.path, width, navigation: navigation.id, method: navigation.method, destination: navigation.path, status: 'passed' })
          }
        }
      }
      record.status = 'passed'
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack ?? String(error)
    failure = error
  } finally {
    try {
      const owned = report.resources.find(item => item.kind === 'browser')
      await closeWebBrowser({ context, browser, resource: owned })
    } catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'H5 browser cleanup failed'); report.status = 'failed' }
    try { await server.close(); serverResource.closed = true }
    catch (error) { failure = new AggregateError([failure, error].filter(Boolean), 'H5 static server cleanup failed'); report.status = 'failed' }
    await saveEvidence(evidenceDirectory, 'report.json', report)
  }
  if (failure) throw failure
  return report
}
