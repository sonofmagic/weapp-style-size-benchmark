import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { artifactFromProject, createTestProject } from '@mpcore/test'
import { launch } from '@mpcore/simulator'
import { loadFixture, rowKey, saveEvidence } from './contract.mjs'

export function classesForRoute(stylesheets, route, packages) {
  const filename = route.replace(/^\//, '')
  const owner = packages.find(pkg => filename.startsWith(`${pkg.root}/`))
  const classes = new Set()
  for (const stylesheet of stylesheets) {
    const styleOwner = packages.find(pkg => stylesheet.path.startsWith(`${pkg.root}/`))
    if (owner?.independent ? styleOwner?.root !== owner.root : styleOwner && styleOwner.root !== owner?.root) continue
    for (const match of stylesheet.css.matchAll(/\.([_a-zA-Z][\w-]*)/g)) classes.add(match[1])
  }
  return classes
}

async function readStyles(directory) {
  const files = []
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Validation does not follow symlinks')
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (file.endsWith('.wxss')) files.push({ path: path.relative(directory, file), css: await readFile(file, 'utf8') })
    }
  }
  await visit(directory)
  return files
}

function verifyNode(page, element, styled, classes, label) {
  const node = page.screen.getByTestId(element.id)
  assert.ok(node, `${label}: missing #${element.id}`)
  const attributes = node.attributes
  if (styled && Object.keys(element.styles).length) {
    const names = String(attributes.class ?? '').split(/\s+/).filter(Boolean)
    assert.ok(names.length || attributes.style, `${label}: #${element.id} has no generated style binding`)
    for (const name of names) assert.ok(classes.has(name), `${label}: unresolved WXSS class ${name} on #${element.id}`)
  }
  return { class: attributes.class ?? '', style: attributes.style ?? '' }
}

async function validateNavigation(row, fixture, resources) {
  const routes = fixture.routes.filter(route => route.navigation?.length)
  if (!routes.length) return []
  const resource = { key: rowKey(row), kind: 'mpcore-navigation-session', closed: false }
  resources.push(resource)
  const session = await launch({ projectPath: row.directory })
  const checked = []
  try {
    for (const route of routes) {
      for (const navigation of route.navigation) {
        const page = await session.reLaunch(route.path)
        const nodes = await page.$$(`[id="${navigation.id}"]`)
        assert.equal(nodes.length, 1, `${rowKey(row)}: missing navigation control ${navigation.id}`)
        await nodes[0].tap()
        const destination = await session.waitForCurrentPage(navigation.path, { timeout: 10000 })
        assert.equal(destination.path.replace(/^\//, ''), navigation.path.replace(/^\//, ''))
        checked.push({ from: route.path, ...navigation, status: 'passed' })
      }
    }
  } finally { await session.close(); resource.closed = true }
  return checked
}

export async function validateHeadless(rows, { root, evidenceDirectory }) {
  const selected = rows.filter(row => row.target === 'weapp')
  assert.ok(selected.length, 'No native artifacts to validate')
  const report = { status: 'running', provider: '@mpcore/test', semantics: 'logical WXML and state; not native visual rendering', artifacts: [], resources: [] }
  let failure
  try {
    for (const row of selected) {
      const fixture = await loadFixture(row)
      const stylesheets = await readStyles(row.directory)
      assert.ok(stylesheets.length, `${rowKey(row)}: no native stylesheets`)
      const app = JSON.parse(await readFile(path.join(row.directory, 'app.json'), 'utf8'))
      const packages = app.subPackages ?? app.subpackages ?? []
      for (const stylesheet of stylesheets) {
        assert.doesNotMatch(stylesheet.css, /@layer\b/, `${rowKey(row)}: unresolved CSS layer in ${stylesheet.path}`)
      }
      const resource = { key: rowKey(row), kind: 'mpcore-project', closed: false }
      report.resources.push(resource)
      const project = createTestProject({ artifact: artifactFromProject(row.directory), failOnConsoleError: true })
      const record = { key: rowKey(row), status: 'running', stylesheets: stylesheets.map(file => file.path), routes: [] }
      report.artifacts.push(record)
      try {
        for (const route of fixture.routes) {
          const classes = classesForRoute(stylesheets, route.path, packages)
          const page = await project.renderPage(route.path)
          const before = {}
          for (const element of route.elements) before[element.id] = verifyNode(page, element, row.scheme !== 'unstyled', classes, `${rowKey(row)} ${route.path}`)
          const routeRecord = { path: route.path, elements: route.elements.length, actions: [] }
          record.routes.push(routeRecord)
          for (const action of route.actions ?? []) {
            await page.user.tap(page.screen.getByTestId(action.id))
            await page.screen.refresh()
            let changedBindings = 0
            for (const check of action.checks) {
              const after = verifyNode(page, check, row.scheme !== 'unstyled', classes, `${rowKey(row)} ${action.state}`)
              if (JSON.stringify(after) !== JSON.stringify(before[check.id])) changedBindings++
              before[check.id] = after
            }
            // Each action changes a class/style binding even in the unstyled
            // baseline (theme/variant glue is shared, styles are omitted).
            if (row.scheme !== 'unstyled') assert.ok(changedBindings > 0, `${rowKey(row)} ${action.state}: no observable binding changed`)
            if (action.data) {
              const data = await page.page.data()
              for (const [key, expected] of Object.entries(action.data)) assert.deepEqual(data[key], expected, `${rowKey(row)} ${action.state}: ${key}`)
            }
            routeRecord.actions.push({ state: action.state, changedBindings })
          }
        }
        record.navigation = await validateNavigation(row, fixture, report.resources)
        record.status = 'passed'
      } finally {
        await project.close()
        resource.closed = true
      }
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack ?? String(error)
    failure = error
  } finally {
    report.evidence = path.relative(root, evidenceDirectory).split(path.sep).join('/')
    await saveEvidence(evidenceDirectory, 'report.json', report)
  }
  if (failure) throw failure
  return report
}
