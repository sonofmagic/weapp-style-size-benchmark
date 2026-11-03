import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inputFingerprint } from '../build/environment.mjs'
import { manifest } from '../measure/index.mjs'
import { renderPageGrowthReport, stylexDelivery, validatePageGrowthReport, writePageGrowthReport } from './report-page-growth.mjs'
import { pageFilesCsv, pageRowsCsv } from './page-growth.mjs'

const counts = [1, 5, 10, 20, 50]
const kinds = ['style', 'script', 'template', 'json', 'asset']
const sha256 = 'a'.repeat(64)
const pageRoute = index => `/pages/bench-page-${String(index).padStart(3, '0')}/index`
function validReport() {
  const rows = []
  for (const scheme of ['tailwind', 'panda', 'stylex']) for (const target of ['weapp', 'web']) for (const mode of ['reuse', 'unique']) for (const pageCount of counts) {
    const files = kinds.map((kind, index) => ({ path: `${kind}.${index}`, kind, package: target === 'weapp' ? 'main' : 'web', raw: 1024 * pageCount, gzip: 100 * pageCount, brotli: 80 * pageCount, sha256 }))
    const byKind = Object.fromEntries(files.map(file => [file.kind, { files: 1, raw: file.raw, gzip: file.gzip, brotli: file.brotli }]))
    const totals = { raw: 5120 * pageCount, gzip: 500 * pageCount, brotli: 400 * pageCount }
    const measurement = { files, totals, byKind, byPackage: { [target === 'weapp' ? 'main' : 'web']: { files: 5, ...totals } } }
    rows.push({ scheme, target, mode, pageCount, profile: 'standard', scenario: `pages-${mode}-${String(pageCount).padStart(3, '0')}`, nodesPerPage: 20, styleUsePoints: pageCount * 20, distinctStyleDefinitions: mode === 'reuse' ? 20 : pageCount * 20, measurement, roundManifests: [manifest(measurement), manifest(measurement)], repeatable: true, referenceValidation: { status: 'passed' }, validation: { status: 'passed', visual: target === 'web' ? 'passed' : 'not-run' } })
  }
  const artifacts = target => rows.filter(row => row.target === target).map(row => ({
    key: `${row.scheme}/standard/${row.scenario}/${row.target}`, status: 'passed',
    routes: target === 'weapp' ? Array.from({ length: row.pageCount }, (_, index) => ({ path: pageRoute(index + 1), elements: 22 })) : [...new Set([1, Math.floor((row.pageCount - 1) / 2) + 1, row.pageCount])].flatMap(index => [375, 768].map(width => ({ route: pageRoute(index), width, state: 'initial', elements: 22, snapshotSha256: sha256, ...(width === 375 ? { screenshot: 'reports/page-growth/evidence/web/mock.png', pixels: { differentPixels: 0 } } : {}) }))),
  }))
  return {
    schemaVersion: 1, status: 'validated', environment: { node: '24.22.1', pnpm: 'pnpm@12.16.1', packages: {} },
    protocol: { buildRounds: 2, production: true, minify: true, sourcemap: false, profile: 'standard', pageCounts: counts, nodesPerPage: 20, gzipLevel: 9, brotliQuality: 11, compressionScope: 'per-file' }, rows,
    validation: {
      headless: { status: 'passed', resources: [{ kind: 'mpcore-project', closed: true }], report: 'reports/page-growth/evidence/headless/report.json', artifacts: artifacts('weapp') },
      web: { status: 'passed', resources: [{ kind: 'browser', closed: true }], report: 'reports/page-growth/evidence/web/report.json', artifacts: [...artifacts('web'), ...['reuse', 'unique'].flatMap(mode => counts.map(pageCount => ({ key: `reference/standard/pages-${mode}-${String(pageCount).padStart(3, '0')}/web`, status: 'passed', routes: [] })))] },
    },
  }
}

test('accepts a complete validated matrix and renders totals and slope from data', () => {
  const report = validReport()
  assert.equal(validatePageGrowthReport(report).size, 60)
  const rendered = renderPageGrowthReport(report)
  assert.ok(rendered.includes('| 50 | 250.00 | 250.00 | 250.00 |'))
  assert.ok(rendered.includes('| 微信原生 | 跨页复用 | Tailwind | 5.00 | 250.00 | 245.00 | 5.00 |'))
  assert.ok(rendered.includes('768 px 保留计算样式/尺寸快照摘要，没有单独保存截图'))
  assert.ok(rendered.includes('没有新增微信开发者工具验收'))
})

test('distinguishes copied global styles from one shared output without reusing an old version diagnosis', () => {
  const report = validReport()
  report.environment.packages = { 'weapp-stylex': '0.3.2', 'weapp-vite': '7.8.0' }
  const rows = new Map(report.rows.map(row => [[row.scheme, row.target, row.mode, row.pageCount].join('/'), row]))
  for (const mode of ['reuse', 'unique']) {
    const row = rows.get(`stylex/weapp/${mode}/50`)
    row.measurement.files = [{ path: 'common/stylex.wxss', kind: 'style', raw: 100, sha256 }]
    row.measurement.byKind.style.raw = 100
  }
  const shared = stylexDelivery(report, rows)
  assert.match(shared, /weapp-stylex@0\.3\.2 \/ weapp-vite@7\.8\.0/)
  assert.match(shared, /只检测到 1 个/)
  assert.doesNotMatch(shared, /两组均检测到根目录及每页/)
  for (const mode of ['reuse', 'unique']) {
    const row = rows.get(`stylex/weapp/${mode}/50`)
    row.measurement.files = Array.from({ length: 51 }, (_, index) => ({ path: `page-${index}/stylex.wxss`, kind: 'style', raw: 100, sha256 }))
    row.measurement.byKind.style.raw = 5100
  }
  const copied = stylexDelivery(report, rows)
  assert.match(copied, /51 个同内容 StyleX 文件/)
  assert.match(copied, /4\.98/)
  assert.doesNotMatch(copied, /只检测到 1 个/)
})

test('rejects missing, duplicated and unexpected matrix rows', () => {
  for (const mutate of [report => report.rows.pop(), report => { report.rows[59] = structuredClone(report.rows[0]) }, report => { report.rows[0].pageCount = 2 }]) {
    const report = validReport(); mutate(report)
    assert.throws(() => validatePageGrowthReport(report))
  }
})

test('rejects unfinished gates and does not substitute native headless for visual acceptance', () => {
  for (const mutate of [
    report => { report.status = 'built' },
    report => { report.rows[0].repeatable = false },
    report => { report.rows[0].referenceValidation.status = 'pending' },
    report => { report.rows[0].validation.status = 'pending' },
    report => { report.rows[0].validation.visual = 'passed' },
    report => { report.rows.find(row => row.target === 'web').validation.visual = 'pending' },
    report => { report.validation.web.status = 'pending' },
    report => { report.validation.headless.status = 'failed' },
    report => { report.validation.headless.resources = [] },
    report => { report.validation.web.resources[0].closed = false },
    report => { report.validation.headless.artifacts[0].routes = [] },
    report => { report.validation.web.artifacts[0].routes[0].pixels.differentPixels = 1 },
    report => { report.validation.web.artifacts[0].routes.pop() },
    report => { report.validation.web.artifacts[39].key = 'unknown' },
  ]) {
    const report = validReport(); mutate(report)
    assert.throws(() => validatePageGrowthReport(report))
  }
})

test('rejects wrong physical totals, repeated paths and unstable manifests', () => {
  for (const mutate of [
    report => { report.rows[0].measurement.totals.raw++ },
    report => { report.rows[0].measurement.byKind.style.gzip++ },
    report => { report.rows[0].measurement.byPackage.main.brotli++ },
    report => { report.rows[0].measurement.files[1].path = report.rows[0].measurement.files[0].path },
    report => { report.rows[0].roundManifests[1].sha256 = 'b'.repeat(64) },
    report => { report.protocol.compressionScope = 'concatenated' },
  ]) {
    const report = validReport(); mutate(report)
    assert.throws(() => validatePageGrowthReport(report))
  }
})

test('--check rejects stale README, generator, validator and benchmark inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'page-growth-report-'))
  try {
    for (const directory of ['src/fixtures', 'src/build', 'src/experiments', 'reports/page-growth/evidence/headless', 'reports/page-growth/evidence/web']) await mkdir(path.join(root, directory), { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc']) await writeFile(path.join(root, file), '{}')
    const digest = createHash('sha256').update('// fixture source\n').digest('hex')
    for (const file of ['page-growth.mjs', 'validate-page-growth.mjs']) await writeFile(path.join(root, 'src/experiments', file), '// fixture source\n')
    const report = validReport()
    report.environment.inputs = await inputFingerprint(root)
    report.environment.experimentSourceSha256 = digest
    report.environment.validationSourceSha256 = digest
    await persistReport(root, report)
    await writeFile(path.join(root, 'reports/page-growth/evidence/web/mock.png'), 'mock screenshot')
    await writePageGrowthReport({ root })
    await writePageGrowthReport({ root, check: true })
    await writeFile(path.join(root, 'reports/page-growth/README.md'), 'stale')
    await assert.rejects(writePageGrowthReport({ root, check: true }), /README is stale/)
    await writePageGrowthReport({ root })
    for (const file of ['src/experiments/page-growth.mjs', 'src/experiments/validate-page-growth.mjs', 'package.json']) {
      await writeFile(path.join(root, file), 'changed')
      await assert.rejects(writePageGrowthReport({ root, check: true }), /stale/)
      await writeFile(path.join(root, file), file === 'package.json' ? '{}' : '// fixture source\n')
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

async function persistReport(root, report) {
  const directory = path.join(root, 'reports/page-growth')
  await writeFile(path.join(directory, 'results.json'), JSON.stringify(report))
  await writeFile(path.join(directory, 'results.csv'), pageRowsCsv(report.rows))
  await writeFile(path.join(directory, 'files.csv'), pageFilesCsv(report.rows))
  for (const gate of ['headless', 'web']) {
    const { report: reportPath, ...evidence } = report.validation[gate]
    await writeFile(path.join(root, reportPath), JSON.stringify(evidence))
  }
}

test('requires matching CSV, persisted validation evidence and nonempty contained screenshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'page-growth-evidence-'))
  try {
    for (const directory of ['src/fixtures', 'src/build', 'src/experiments', 'reports/page-growth/evidence/headless', 'reports/page-growth/evidence/web']) await mkdir(path.join(root, directory), { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc']) await writeFile(path.join(root, file), '{}')
    for (const file of ['page-growth.mjs', 'validate-page-growth.mjs']) await writeFile(path.join(root, 'src/experiments', file), '// source\n')
    const report = validReport()
    report.environment.inputs = await inputFingerprint(root)
    report.environment.experimentSourceSha256 = report.environment.validationSourceSha256 = createHash('sha256').update('// source\n').digest('hex')
    await persistReport(root, report)
    const screenshot = path.join(root, 'reports/page-growth/evidence/web/mock.png')
    await writeFile(screenshot, 'mock screenshot')
    await writePageGrowthReport({ root })
    for (const file of ['results.csv', 'files.csv']) {
      await writeFile(path.join(root, 'reports/page-growth', file), 'stale')
      await assert.rejects(writePageGrowthReport({ root, check: true }), /differs from results.json/)
      await persistReport(root, report)
    }
    for (const gate of ['headless', 'web']) {
      await writeFile(path.join(root, report.validation[gate].report), '{}')
      await assert.rejects(writePageGrowthReport({ root, check: true }), /persisted evidence differs/)
      await persistReport(root, report)
    }
    await writeFile(screenshot, '')
    await assert.rejects(writePageGrowthReport({ root, check: true }), /Screenshot evidence is empty/)
    await rm(screenshot)
    await assert.rejects(writePageGrowthReport({ root, check: true }), /ENOENT/)
    report.validation.web.artifacts[0].routes[0].screenshot = 'reports/page-growth/results.json'
    await persistReport(root, report)
    await assert.rejects(writePageGrowthReport({ root, check: true }), /outside page-growth evidence/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
