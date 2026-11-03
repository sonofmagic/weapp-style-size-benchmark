import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateFixture } from '../fixtures/index.mjs'
import { classFor, renderNodes } from '../fixtures/render.mjs'
import { PANDA_THEME, STYLE_SPEC, TOKENS, rgb, scaleStyle } from '../fixtures/spec.mjs'
import { referenceCss, styleModule } from '../fixtures/styles.mjs'
import { configureFixture } from '../build/config.mjs'
import { environment, protocol } from '../build/environment.mjs'
import { minifyNativeStyles } from '../build/minify.mjs'
import { runNode } from '../build/process.mjs'
import { assertRepeatable, collect, manifest } from '../measure/index.mjs'
import { validateReferences } from '../validate/references.mjs'

export const PAGE_COUNTS = [1, 5, 10, 20, 50]
export const NODES_PER_PAGE = 20
export const PAGE_SCHEMES = ['tailwind', 'panda', 'stylex']
export const PAGE_MODES = ['reuse', 'unique']
export const PAGE_TARGETS = ['weapp', 'web']
export const pageScenario = (mode, pageCount) => `pages-${mode}-${String(pageCount).padStart(3, '0')}`
export const pageId = row => [row.scheme, row.mode, String(row.pageCount).padStart(3, '0'), row.target].join('/')

export function pageMatrix(filters = {}) {
  const counts = filters.pages ?? PAGE_COUNTS
  assert.ok(Array.isArray(counts) && counts.length && counts.every(count => Number.isInteger(count) && count > 0 && count <= 100), 'Page counts must be integers from 1 to 100')
  assert.equal(new Set(counts).size, counts.length, 'Duplicate page counts would write the same fixture directory')
  return PAGE_SCHEMES.flatMap(scheme => PAGE_MODES.flatMap(mode => counts.flatMap(pageCount => PAGE_TARGETS.map(target => ({ scheme, mode, pageCount, target, profile: 'standard', scenario: pageScenario(mode, pageCount) })))))
    .filter(row => ['scheme', 'mode', 'target'].every(key => !filters[key] || row[key] === filters[key]))
}

async function save(directory, relative, content) {
  const file = path.join(directory, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

/** Actual routes, each with 20 compile-time nodes. Shared styles are imported. */
export async function generatePageGrowthFixture({ directory, scheme, mode, pageCount, target, profile = 'standard' }) {
  assert.ok([...PAGE_SCHEMES, 'reference'].includes(scheme), `Unknown page scheme: ${scheme}`)
  assert.ok(PAGE_MODES.includes(mode), `Unknown page mode: ${mode}`)
  assert.ok(PAGE_TARGETS.includes(target), `Unknown target: ${target}`)
  assert.ok(Number.isInteger(pageCount) && pageCount > 0 && pageCount <= 100, 'Invalid page count')
  assert.equal(profile, 'standard', 'The page-growth supplement uses standard production settings')
  await generateFixture({ directory, scheme, scenario: 'unique-10', profile, target })
  // Remove every original page and style definition, not only its route entry:
  // scanning dead benchmark sources could manufacture extra generated rules.
  await rm(path.join(directory, 'src/pages'), { recursive: true, force: true })
  const contract = { version: 1, scheme, scenario: pageScenario(mode, pageCount), profile, target, styled: true, mode, pageCount, nodesPerPage: NODES_PER_PAGE, routes: [] }
  const routes = []
  const bindings = ['panda', 'stylex'].includes(scheme)
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
    const route = `pages/bench-page-${String(pageIndex + 1).padStart(3, '0')}/index`
    routes.push(route)
    const styles = { ...STYLE_SPEC }
    const nodes = [{ id: 'bench-title', tag: 'text', styles: ['title'], text: 'Page growth benchmark', children: [] }]
    for (let index = 0; index < NODES_PER_PAGE; index++) {
      const key = `probe${index}`
      styles[key] = scaleStyle((mode === 'unique' ? pageIndex * NODES_PER_PAGE : 0) + index, true)
      nodes.push({ id: `bench-node-${index}`, tag: 'view', styles: [key], text: `Node ${index + 1}`, children: [] })
    }
    const keys = new Set(['shell', 'stack', 'title', ...Array.from({ length: NODES_PER_PAGE }, (_, index) => `probe${index}`)])
    const classes = ['shell', 'stack'].map(key => classFor(key, scheme, styles)).join(' ')
    await save(directory, `src/${route}.wxml`, `<view id="bench-root" data-testid="bench-root" class="${classes}${scheme === 'stylex' ? '' : ' theme-light'}">\n${renderNodes(nodes, scheme, styles)}\n</view>\n`)
    await save(directory, `src/${route}.json`, '{}\n')
    const sharedModule = 'src/styles/shared-page.styles.ts'
    const styleFile = mode === 'reuse' ? sharedModule : `src/${route}.styles.ts`
    if (bindings && (mode === 'unique' || pageIndex === 0)) {
      await save(directory, styleFile, styleModule({ scheme, styles, keys, file: path.join(directory, styleFile), directory, independent: false }))
    }
    const moduleImport = mode === 'reuse' ? '../../styles/shared-page.styles' : './index.styles'
    await save(directory, `src/${route}.ts`, bindings ? `import {getStyles} from '${moduleImport}'\nPage({data:{classes:getStyles()}})\n` : 'Page({})\n')
    if (scheme === 'reference') await save(directory, `src/${route}.wxss`, referenceCss(styles, keys))
    contract.routes.push({ path: `/${route}`, rootId: 'bench-root', elements: [
      { id: 'bench-root', styles: { backgroundColor: rgb(TOKENS.light.surface), color: rgb(TOKENS.light.text), paddingTop: '24px' } },
      { id: 'bench-title', styles: { fontSize: '28px', fontWeight: '700', lineHeight: '36px' } },
      ...Array.from({ length: NODES_PER_PAGE }, (_, index) => {
        const style = styles[`probe${index}`]
        return { id: `bench-node-${index}`, styles: { width: style.width, height: style.height, paddingLeft: style.paddingLeft, backgroundColor: rgb(style.backgroundColor) } }
      }),
    ], actions: [] })
  }
  await save(directory, 'src/app.json', `${JSON.stringify({ pages: routes, window: { navigationBarTitleText: 'Page growth benchmark', navigationStyle: 'custom' } }, null, 2)}\n`)
  await save(directory, 'fixture.json', `${JSON.stringify(contract, null, 2)}\n`)
  return contract
}

export async function buildPageGrowth(root, row) {
  const fixtureDirectory = path.join(root, '.bench/page-growth/fixtures', pageId(row))
  const logs = path.join(root, '.bench/page-growth/logs', pageId(row))
  await rm(fixtureDirectory, { recursive: true, force: true })
  await generatePageGrowthFixture({ directory: fixtureDirectory, ...row })
  await configureFixture(fixtureDirectory, row, PANDA_THEME)
  const outputRoot = path.join(fixtureDirectory, 'dist')
  const directory = row.target === 'web' ? path.join(outputRoot, 'web') : outputRoot
  const rounds = []
  let cssMinification
  let referenceValidation
  for (let round = 1; round <= 2; round++) {
    await rm(outputRoot, { recursive: true, force: true })
    if (row.scheme === 'panda') {
      await rm(path.join(fixtureDirectory, 'styled-system'), { recursive: true, force: true })
      await runNode(path.join(root, 'node_modules/@pandacss/dev/bin.js'), ['codegen', '--config', 'panda.config.ts'], { cwd: fixtureDirectory, log: path.join(logs, `codegen-${round}.log`) })
    }
    await runNode(path.join(root, 'node_modules/weapp-vite/bin/weapp-vite.js'), ['build', '-p', row.target, '--outDir', 'dist'], { cwd: fixtureDirectory, log: path.join(logs, `build-${round}.log`) })
    if (row.target === 'weapp') {
      await save(directory, 'project.config.json', `${JSON.stringify({ appid: 'touristappid', projectname: 'page-growth-benchmark', miniprogramRoot: '.', setting: { es6: true, minified: false, urlCheck: false } }, null, 2)}\n`)
      cssMinification = await minifyNativeStyles(directory)
    }
    referenceValidation = await validateReferences(directory, { target: row.target })
    rounds.push(await collect(directory, { target: row.target }))
  }
  assertRepeatable(rounds[0], rounds[1])
  return { ...row, directory, fixtureDirectory, nodesPerPage: NODES_PER_PAGE, styleUsePoints: NODES_PER_PAGE * row.pageCount, distinctStyleDefinitions: row.mode === 'reuse' ? NODES_PER_PAGE : NODES_PER_PAGE * row.pageCount, measurement: rounds[1], roundManifests: rounds.map(manifest), cssMinification, referenceValidation, repeatable: true, validation: { status: 'structural-passed', visual: 'pending' } }
}

function portable(value, root) {
  if (Array.isArray(value)) return value.map(item => portable(item, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['directory', 'fixtureDirectory'].includes(key)).map(([key, item]) => [key, portable(item, root)]))
  return typeof value === 'string' ? value.replaceAll(`${root}${path.sep}`, '').split(path.sep).join('/') : value
}

const csvCell = value => /[",\r\n]/.test(String(value ?? '')) ? `"${String(value).replaceAll('"', '""')}"` : String(value ?? '')
export function pageRowsCsv(rows) {
  return [['scheme', 'mode', 'target', 'pageCount', 'nodesPerPage', 'raw', 'gzip', 'brotli', 'styleRaw', 'scriptRaw', 'templateRaw', 'jsonRaw', 'assetRaw'], ...rows.map(row => [row.scheme, row.mode, row.target, row.pageCount, row.nodesPerPage, ...['raw', 'gzip', 'brotli'].map(key => row.measurement.totals[key]), ...['style', 'script', 'template', 'json', 'asset'].map(key => row.measurement.byKind[key].raw)])].map(line => line.map(csvCell).join(',')).join('\n') + '\n'
}
export function pageFilesCsv(rows) {
  return [['scheme', 'mode', 'target', 'pageCount', 'path', 'kind', 'package', 'raw', 'gzip', 'brotli', 'sha256'], ...rows.flatMap(row => row.measurement.files.map(file => [row.scheme, row.mode, row.target, row.pageCount, ...['path', 'kind', 'package', 'raw', 'gzip', 'brotli', 'sha256'].map(key => file[key])]))].map(line => line.map(csvCell).join(',')).join('\n') + '\n'
}

export async function settlePageBuilds(jobs, concurrency, build) {
  const rows = new Array(jobs.length)
  let index = 0
  let failed = false
  const outcomes = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
    while (!failed && index < jobs.length) {
      const current = index++
      try { rows[current] = await build(jobs[current], current) }
      catch (error) { failed = true; throw error }
    }
  }))
  const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, `Page-growth builds failed: ${failures.map(error => error.message).join('\n')}`)
  return rows
}

export async function runPageGrowth(root, { filters = {}, concurrency = 3, output = 'reports/page-growth/results.json' } = {}) {
  const outputFile = path.resolve(root, output)
  assert.ok(outputFile.startsWith(`${path.join(root, 'reports/page-growth')}${path.sep}`), 'Page-growth output must stay inside reports/page-growth')
  await mkdir(path.dirname(outputFile), { recursive: true })
  const persistState = async report => {
    await save(root, '.bench/page-growth/run.json', `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(outputFile, `${JSON.stringify(portable(report, root), null, 2)}\n`)
  }
  let env
  try {
    // Invalidate both consumers before validating options or reading inputs.
    await persistState({ schemaVersion: 1, status: 'building', rows: [] })
    assert.ok(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8, 'Invalid concurrency')
    const jobs = pageMatrix(filters)
    assert.ok(jobs.length, 'No page-growth jobs match filters')
    env = await environment(root)
    env.experimentSourceSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
    await persistState({ schemaVersion: 1, status: 'building', environment: env, rows: [] })
    const rows = await settlePageBuilds(jobs, concurrency, (row, current) => {
      process.stdout.write(`[${current + 1}/${jobs.length}] page-growth ${pageId(row)}\n`)
      return buildPageGrowth(root, row)
    })
    const report = { schemaVersion: 1, status: 'built', environment: env, protocol: { ...protocol, experiment: 'actual-page-count-growth', profile: 'standard', pageCounts: filters.pages ?? PAGE_COUNTS, nodesPerPage: NODES_PER_PAGE, nodeAccounting: '20 variable style probes per page, plus a fixed title node and layout root; style definition counts exclude the fixed shell/stack/title styles', packageLayout: 'all pages in the main package; no subpackages', reuse: 'Same 20 style definitions in one shared imported module for Panda/StyleX; static WXML utilities for Tailwind', unique: '20 new style definitions per page in its local module; globally unique colors and partially reused numeric values', bindings: 'Each page has real Page code, WXML and JSON; no runtime loop substitutes compilation-time nodes', repeatability: 'Two clean production builds of each real page-count project; per-file path/SHA-256 equality', visualValidation: 'Pending separate validation; build/structure checks alone do not establish visual equivalence' }, rows }
    const stem = path.basename(outputFile, '.json')
    await writeFile(path.join(path.dirname(outputFile), stem === 'results' ? 'results.csv' : `${stem}.csv`), pageRowsCsv(rows))
    await writeFile(path.join(path.dirname(outputFile), stem === 'results' ? 'files.csv' : `${stem}-files.csv`), pageFilesCsv(rows))
    await persistState(report)
    return report
  } catch (error) {
    await persistState({ schemaVersion: 1, status: 'failed', environment: env, rows: [], error: String(error.stack ?? error) })
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const args = process.argv.slice(2)
  const option = key => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3)
  const filters = Object.fromEntries(['scheme', 'mode', 'target'].map(key => [key, option(key)]).filter(([, value]) => value))
  if (option('pages')) filters.pages = option('pages').split(',').map(Number)
  try {
    assert.equal(process.versions.node, '24.22.1', 'Use the pinned managed Node runtime via pnpm exec node')
    const result = await runPageGrowth(root, { filters, concurrency: Number(option('concurrency') ?? 3), output: option('output') ?? 'reports/page-growth/results.json' })
    process.stdout.write(`Page-growth supplement built ${result.rows.length} projects twice.\n`)
  } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 }
}
