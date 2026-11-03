import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { csv, fileCsv, validateReport, writeReports } from './index.mjs'
import { readme } from './readme.mjs'
import { profiles, scenarios, schemes, targets } from './validate.mjs'

function fixture() {
  return { schemaVersion: 1, environment: { node: '24.22.1', packages: { panda: '2.2.0' } }, protocol: { gzipLevel: 9 }, validation: { web: { status: 'passed' }, headless: { status: 'passed' }, ide: { status: 'pending' } }, rows: schemes.flatMap((scheme, index) => profiles.flatMap(profile => scenarios.flatMap(scenario => targets.map(target => {
    const raw = 100 + index * 10
    const zero = { files: 0, raw: 0, gzip: 0, brotli: 0 }
    const group = { files: 1, raw, gzip: 50, brotli: 40 }
    return { scheme, profile, scenario, target, repeatable: true, validation: { status: 'passed' }, referenceValidation: { status: 'passed' }, cssMinification: target === 'weapp' ? { tool: 'lightningcss@1.33.0', files: [], before: 0, after: 0 } : undefined, measurement: { files: [{ path: 'index.html', kind: 'template', package: target === 'web' ? 'web' : 'main', raw, gzip: 50, brotli: 40, sha256: 'fixture' }], excluded: [], totals: { raw, gzip: 50, brotli: 40 }, byKind: { style: zero, script: zero, template: group, json: zero, asset: zero }, byPackage: { [target === 'web' ? 'web' : 'main']: group } } }
  })))) }
}

test('requires complete, unique, validated, repeatable matrix with matching totals', () => {
  const report = fixture()
  assert.equal(validateReport(report), report)
  for (const change of [value => value.rows.pop(), value => value.rows.push(value.rows[0]), value => value.rows[0].repeatable = false, value => value.validation.web.status = 'failed', value => value.validation.headless.status = 'pending', value => value.rows[0].validation.status = 'pending', value => delete value.rows[0].validation.status, value => delete value.rows[0].referenceValidation, value => value.rows[0].referenceValidation.status = 'pending', value => delete value.rows[0].cssMinification, value => value.rows[0].cssMinification.after++, value => value.rows[0].measurement.totals.raw++, value => value.rows[0].measurement.byPackage.main.raw++]) {
    const altered = structuredClone(report)
    change(altered)
    assert.throws(() => validateReport(altered))
  }
})

test('writes data, CSV, curves and README from a single report without claiming IDE completion', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'style-size-report-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const report = fixture()
  const output = await writeReports(report, { directory: path.join(directory, 'reports'), readmePath: path.join(directory, 'README.md') })
  assert.deepEqual(JSON.parse(await readFile(output.json, 'utf8')), JSON.parse(JSON.stringify(report)))
  const markdown = await readFile(output.readme, 'utf8')
  assert.match(markdown, /微信 IDE 验证\*\*待完成/)
  assert.match(markdown, /hash: \{ className: true \}/)
  assert.match(markdown, /不是未经统一压缩的适配器裸输出/)
  assert.match(markdown, /压缩前 WXSS/)
  assert.match(markdown, /weapp-tailwindcss\/postcss/)
  assert.doesNotMatch(markdown, /WeappTailwindcssWeb/)
  assert.match(markdown, /camelCase/)
  assert.match(markdown, /独立分包冷启动实机证据/)
  for (const command of ['bench:build', 'test:equivalence', 'bench:measure', 'bench:report', 'test:ide', 'WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH', 'BENCHMARK_WECHAT_APPID', 'BENCHMARK_RUN_IDE=1']) assert.ok(markdown.includes(command))
  assert.match(markdown, /不等于微信官方上传包体积/)
  assert.match(markdown, /reports\/results.json/)
  assert.equal((await readFile(output.csv, 'utf8')).trim().split('\n').length, 161)
  const filesCsv = await readFile(output.filesCsv, 'utf8')
  assert.equal(filesCsv, fileCsv(report))
  assert.equal(filesCsv.trim().split('\n').length, report.rows.reduce((count, row) => count + row.measurement.files.length, 1))
  assert.match(filesCsv, /path,kind,package,raw,gzip,brotli,sha256/)
  assert.match(markdown, /reports\/files.csv/)
  assert.match(markdown, /JSON \| 资源/)
  assert.match(await readFile(output.chart, 'utf8'), /<svg/)
  assert.match(csv(report), /deltaUnstyledRaw/)
})

test('reports optimization and growth, embeds real screenshots, and omits source manifests from the summary', () => {
  const report = fixture()
  report.environment.sourceManifest = [{ path: 'SOURCE_MANIFEST_MUST_STAY_IN_JSON', sha256: 'x' }]
  report.protocol.sourceFiles = ['SOURCE_FILES_MUST_STAY_IN_JSON']
  report.validation.web.artifacts = [{ key: 'reference/standard/gallery/web', routes: [{ width: 375, state: 'initial', screenshot: 'reports/evidence/web/gallery.png' }] }]
  const optimized = report.rows.find(row => row.scheme === 'panda' && row.profile === 'optimized' && row.scenario === 'application' && row.target === 'weapp')
  optimized.measurement.totals.raw = 80
  optimized.measurement.files[0].raw = 80
  optimized.measurement.byKind.template.raw = 80
  const markdown = readme(report)
  assert.match(markdown, /27.27%/)
  assert.match(markdown, /gzip 最小为/)
  assert.match(markdown, /Brotli 最小为/)
  assert.match(markdown, /与 raw 最小方案不同/)
  assert.match(markdown, /不能泛化为普遍优势/)
  assert.match(markdown, /Panda 类名哈希的实际收益/)
  assert.match(markdown, /复用样式增长/)
  assert.match(markdown, /同规模独特−复用总量/)
  assert.match(markdown, /样式文件字节不变/)
  assert.match(markdown, /reports\/evidence\/web\/gallery.png/)
  assert.doesNotMatch(markdown, /SOURCE_MANIFEST_MUST_STAY_IN_JSON|SOURCE_FILES_MUST_STAY_IN_JSON/)
  assert.match(markdown, /"panda": "2.2.0"/)
})

test('uses measured dependency versions and keeps old findings scoped to their historical versions', () => {
  const report = fixture()
  report.environment.packages = { 'weapp-vite': '7.8.0', 'weapp-tailwindcss': '5.6.4', lightningcss: '1.34.0', pixelmatch: '8.0.0' }
  const markdown = readme(report)
  assert.match(markdown, /weapp-vite@7\.8\.0/)
  assert.match(markdown, /weapp-tailwindcss@5\.6\.4/)
  assert.match(markdown, /lightningcss@1\.34\.0/)
  assert.match(markdown, /pixelmatch@8\.0\.0/)
  assert.doesNotMatch(markdown, /weapp-vite@7\.7\.0|weapp-tailwindcss@5\.6\.3/)
  assert.match(markdown, /历史 `weapp-stylex@0\.3\.1`/)
  assert.match(markdown, /不能把跨工具版本的像素差异计数/)
  assert.match(markdown, /reports\/release-comparison\/README\.md/)
})
