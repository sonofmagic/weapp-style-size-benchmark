import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { rowKey } from './contract.mjs'

const message = error => error.stack ?? String(error)

// Persist invalidation before doing any work: an unsuccessful retry must never
// leave the previous run's successful gates available to the report command.
export async function runGates(state, gates, { save, verify, validateRows = false }) {
  state.validation ??= {}
  state.status = 'validating'
  delete state.error
  for (const gate of gates) state.validation[gate.name] = { status: 'pending' }
  if (validateRows) for (const row of state.rows) row.validation = { status: 'pending' }
  await save(state)
  let active
  try {
    await verify?.()
    for (const gate of gates) {
      active = gate.name
      state.validation[active] = { status: 'running' }
      await save(state)
      const result = await gate.run()
      assert.equal(result?.status, 'passed', `${active} validation did not pass`)
      state.validation[active] = { ...result, report: `reports/evidence/${active}/report.json` }
      await save(state)
    }
    if (validateRows) for (const row of state.rows) row.validation = { status: 'passed', gate: row.target === 'web' ? 'web' : 'headless' }
    state.status = ['web', 'headless'].every(name => state.validation[name]?.status === 'passed') ? 'validated' : 'built'
    await save(state)
    return state
  } catch (error) {
    state.status = 'failed'
    state.error = message(error)
    const failed = active ? [active] : gates.map(gate => gate.name)
    for (const name of failed) state.validation[name] = { status: 'failed', error: message(error) }
    await save(state)
    throw error
  }
}

export function assertReadyState(state) {
  assert.notEqual(state.status, 'failed', 'The latest run failed; rerun its validation before generating a report')
  for (const name of ['web', 'headless']) assert.equal(state.validation?.[name]?.status, 'passed', `Required validation gate has not passed: ${name}`)
  const ide = state.validation?.ide?.status ?? 'pending'
  assert.ok(['passed', 'pending'].includes(ide), `IDE validation is ${ide}; failed or incomplete acceptance cannot be published`)
  for (const row of state.rows ?? []) assert.equal(row.validation?.status, 'passed', `${rowKey(row)} validation has not passed`)
}

export async function assertEvidenceMatches(state, { root, transform = value => value } = {}) {
  assertReadyState(state)
  for (const name of ['headless', 'web', 'ide']) {
    const gate = state.validation[name]
    if (gate?.status !== 'passed') continue
    const relative = `reports/evidence/${name}/report.json`
    assert.equal(gate.report, relative, `${name} evidence must identify the current report`)
    const evidence = transform(JSON.parse(await readFile(path.join(root, relative), 'utf8')))
    const { report: _, ...recorded } = gate
    assert.deepEqual(evidence, recorded, `${name} evidence differs from the validated run state`)
    assert.equal(evidence.status, 'passed', `${name} evidence has not passed`)
    const rows = state.rows.filter(row => name === 'web' ? row.target === 'web' : name === 'headless' ? row.target === 'weapp' : row.target === 'weapp' && ['tailwind', 'panda', 'stylex'].includes(row.scheme) && ['gallery', 'application'].includes(row.scenario) && (row.profile === 'standard' || row.scheme === 'panda'))
    const expected = rows.map(rowKey).sort()
    const actual = (evidence.artifacts ?? []).map(artifact => artifact.key).sort()
    assert.deepEqual(actual, expected, `${name} evidence does not cover the current matrix`)
    for (const artifact of evidence.artifacts) assert.equal(artifact.status, 'passed', `${name} artifact ${artifact.key} did not pass`)
    if (name === 'ide') {
      assert.ok(Array.isArray(evidence.calibrations) && evidence.calibrations.length === 1, 'IDE evidence requires exactly one handwritten native rpx calibration')
      const calibration = evidence.calibrations[0]
      assert.equal(calibration.key, 'reference/standard/gallery/weapp', 'IDE calibration must use the handwritten standard native gallery')
      assert.equal(calibration.status, 'passed', 'IDE handwritten rpx calibration did not pass')
      const referenceRows = state.rows.filter(row => rowKey(row) === calibration.key)
      assert.equal(referenceRows.length, 1, 'IDE calibration reference is absent or duplicated in the matrix')
      assert.ok(referenceRows[0].measurement?.files?.length, 'IDE calibration reference lacks a measured file manifest')
      const files = referenceRows[0].measurement.files.map(file => ({ path: file.path, bytes: file.raw, sha256: file.sha256 }))
      assert.deepEqual(calibration.reference?.files, files, 'IDE calibration reference files differ from the measured manifest')
      assert.equal(calibration.reference.sha256, createHash('sha256').update(JSON.stringify(files)).digest('hex'), 'IDE calibration reference manifest hash differs from the measured manifest')
    }
    for (const resource of evidence.resources ?? []) assert.equal(resource.closed, true, `${name} left an owned ${resource.kind ?? resource.name} resource open`)
    for (const artifact of [...evidence.artifacts, ...(evidence.calibrations ?? [])]) for (const route of artifact.routes ?? []) {
      if (!route.screenshot) continue
      const file = path.resolve(root, route.screenshot)
      assert.ok(file.startsWith(`${path.resolve(root, 'reports/evidence')}${path.sep}`), `${name} screenshot is outside the evidence directory`)
      const bytes = await readFile(file)
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${name} screenshot is missing or is not a PNG: ${route.screenshot}`)
    }
  }
}

export function portablePaths(value, root) {
  if (typeof value === 'string') return value.replaceAll(`${root}${path.sep}`, '').replaceAll(root, '.').split(path.sep).join('/')
  if (Array.isArray(value)) return value.map(item => portablePaths(item, root))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, portablePaths(item, root)]))
  return value
}

export async function publishPortableEvidence(state, { root, save }) {
  // Check the original evidence before rewriting it. Publishing must not turn
  // a missing or failed evidence file into a successful file from cached data.
  await assertEvidenceMatches(state, { root })
  for (const name of ['headless', 'web', 'ide']) {
    const gate = state.validation[name]
    if (gate?.status !== 'passed') continue
    const normalized = portablePaths(gate, root)
    const { report, ...evidence } = normalized
    await writeFile(path.join(root, report), `${JSON.stringify(evidence, null, 2)}\n`)
    state.validation[name] = normalized
  }
  // Keep rows' local artifact directories: later local commands still verify
  // the measured physical files. Only published gate evidence is normalized.
  await save(state)
  await assertEvidenceMatches(state, { root })
}

export function assertLatestRun(published, latest) {
  assertReadyState(latest)
  assert.equal(latest.environment?.generatedAt, published.environment?.generatedAt, 'Published report belongs to an earlier run')
  assert.equal(latest.environment?.inputs?.sha256, published.environment?.inputs?.sha256, 'Published report has different build inputs from the latest run')
  for (const name of ['headless', 'web', 'ide']) assert.equal(latest.validation?.[name]?.status, published.validation?.[name]?.status, `${name} status changed after report generation`)
}
