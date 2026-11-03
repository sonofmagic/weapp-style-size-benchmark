import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inputFingerprint } from '../build/environment.mjs'
import { compareRows, comparisonCsv, validateCurrentComparisonInputs } from './release-comparison.mjs'

function row({ style = 100, script = 30, template = 20 } = {}) {
  const metrics = raw => ({ raw, gzip: Math.ceil(raw / 2), brotli: Math.ceil(raw / 3) })
  const byKind = Object.fromEntries(Object.entries({ style, script, template, json: 0, asset: 0 }).map(([kind, raw]) => [kind, metrics(raw)]))
  const totals = Object.fromEntries(['raw', 'gzip', 'brotli'].map(metric => [metric, Object.values(byKind).reduce((sum, group) => sum + group[metric], 0)]))
  return { scheme: 'stylex', target: 'weapp', profile: 'standard', scenario: 'pages-reuse-050', mode: 'reuse', pageCount: 50, byKind, totals }
}

test('compares complete matching identities and preserves positive and negative category changes', () => {
  const before = row({ style: 5100, script: 30, template: 20 })
  const after = row({ style: 100, script: 60, template: 40 })
  const result = compareRows([before], [after], 'pages')
  assert.equal(result[0].before.totals.raw, 5150)
  assert.equal(result[0].after.totals.raw, 200)
  assert.equal(result[0].delta.totals.raw, -4950)
  assert.equal(result[0].delta.byKind.style.raw, -5000)
  assert.equal(result[0].delta.byKind.script.raw, 30)
  assert.equal(result[0].delta.byKind.template.raw, 20)
  const csv = comparisonCsv({ rows: result })
  const [headers, values] = csv.trim().split('\n').map(line => line.split(','))
  const record = Object.fromEntries(headers.map((name, index) => [name, values[index]]))
  assert.equal(record.style_raw_delta, '-5000')
  assert.equal(record.total_raw_delta, '-4950')
  assert.equal(record.pageCount, '50')
})

test('refuses missing rows, duplicate identities and corrupt totals instead of joining a partial result', () => {
  assert.throws(() => compareRows([row()], [], 'pages'), /matrices differ/)
  assert.throws(() => compareRows([row(), row()], [row()], 'pages'), /duplicate/)
  assert.throws(() => compareRows([row()], [row(), row()], 'pages'), /duplicate/)
  const invalid = row(); invalid.totals.raw++
  assert.throws(() => compareRows([row()], [invalid], 'pages'), /kind totals differ/)
  const other = row(); other.profile = 'optimized'
  assert.throws(() => compareRows([row()], [other], 'pages'), /matrices differ/)
})

test('rejects stale inputs, mixed package versions and edited page experiment sources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-comparison-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const directory of ['src/build', 'src/fixtures', 'src/experiments']) await mkdir(path.join(root, directory), { recursive: true })
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc']) await writeFile(path.join(root, file), '{}')
  const source = '// fixture source\n'
  for (const file of ['page-growth.mjs', 'validate-page-growth.mjs']) await writeFile(path.join(root, 'src/experiments', file), source)
  const fingerprint = await inputFingerprint(root)
  const digest = createHash('sha256').update(source).digest('hex')
  const report = { environment: { inputs: fingerprint, packages: { 'weapp-stylex': '0.3.2' }, experimentSourceSha256: digest, validationSourceSha256: digest } }
  await validateCurrentComparisonInputs(root, report, report)
  const stale = structuredClone(report); stale.environment.inputs.sha256 = '0'.repeat(64)
  await assert.rejects(validateCurrentComparisonInputs(root, stale, report), /inputs are stale/)
  const mixed = structuredClone(report); mixed.environment.packages['weapp-stylex'] = '0.3.1'
  await assert.rejects(validateCurrentComparisonInputs(root, report, mixed), /dependency versions differ/)
  await writeFile(path.join(root, 'src/experiments/page-growth.mjs'), '// changed\n')
  await assert.rejects(validateCurrentComparisonInputs(root, report, report), /page-growth.mjs is stale/)
})
