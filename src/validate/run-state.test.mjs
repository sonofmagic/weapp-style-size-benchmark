import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertEvidenceMatches, assertLatestRun, assertReadyState, portablePaths, publishPortableEvidence, runGates } from './run-state.mjs'
import { classesForRoute } from './headless.mjs'
import { rowKey } from './contract.mjs'

function ready() {
  const rows = ['weapp', 'web'].map(target => ({ scheme: 'reference', profile: 'standard', scenario: 'gallery', target, validation: { status: 'passed' } }))
  return { status: 'validated', environment: { generatedAt: 'current-run', inputs: { sha256: 'inputs' } }, rows, validation: Object.fromEntries(['headless', 'web', 'ide'].map(name => [name, name === 'ide' ? { status: 'pending' } : { status: 'passed', artifacts: [{ key: rowKey(rows[name === 'web' ? 1 : 0]), status: 'passed', routes: [] }], resources: [{ kind: 'test-resource', closed: true }], report: `reports/evidence/${name}/report.json` }])) }
}

test('validation invalidates old passes on disk before verifying artifacts', async () => {
  const state = ready()
  const saved = []
  await assert.rejects(runGates(state, ['headless', 'web'].map(name => ({ name, run: () => assert.fail('must not run after manifest failure') })), {
    save: async state => saved.push(structuredClone(state)), validateRows: true,
    verify: async () => { assert.equal(saved[0].validation.web.status, 'pending'); throw new Error('artifact changed') },
  }), /artifact changed/)
  assert.ok(saved[0].rows.every(row => row.validation.status === 'pending'))
  assert.equal(saved.at(-1).status, 'failed')
  assert.equal(saved.at(-1).validation.web.status, 'failed')
  assert.throws(() => assertReadyState(saved.at(-1)), /latest run failed/)
})

test('a failed web retry cannot retain passed row validation or a stale report pointer', async () => {
  const state = ready()
  const saved = []
  await assert.rejects(runGates(state, [
    { name: 'headless', run: async () => ({ status: 'passed' }) },
    { name: 'web', run: async () => { throw new Error('pixel mismatch') } },
  ], { save: async state => saved.push(structuredClone(state)), validateRows: true }), /pixel mismatch/)
  assert.equal(saved.at(-1).validation.headless.status, 'passed')
  assert.equal(saved.at(-1).validation.web.status, 'failed')
  assert.equal(saved.at(-1).validation.web.report, undefined)
  assert.ok(saved.at(-1).rows.every(row => row.validation.status === 'pending'))
})

test('successful validation restores row passes only after both required gates finish', async () => {
  const state = ready()
  await runGates(state, ['headless', 'web'].map(name => ({ name, run: async () => ({ status: 'passed' }) })), { save: async () => {}, validateRows: true })
  assert.equal(state.status, 'validated')
  assert.equal(state.rows[0].validation.gate, 'headless')
  assert.equal(state.rows[1].validation.gate, 'web')
  assertReadyState(state)
})

test('CI may leave IDE pending, but failed IDE acceptance blocks publication', async () => {
  const state = ready()
  assertReadyState(state)
  await assert.rejects(runGates(state, [{ name: 'ide', run: async () => { throw new Error('native style mismatch') } }], { save: async () => {} }), /native style mismatch/)
  assert.equal(state.validation.ide.status, 'failed')
  assert.throws(() => assertReadyState(state), /latest run failed/)
  state.status = 'validated'
  assert.throws(() => assertReadyState(state), /IDE validation is failed/)
})

test('report evidence must match persisted state, cover every row and close owned resources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'style-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = ready()
  async function saveEvidence(name) {
    const { report, ...evidence } = state.validation[name]
    await mkdir(path.dirname(path.join(root, report)), { recursive: true })
    await writeFile(path.join(root, report), JSON.stringify(evidence))
  }
  await saveEvidence('headless'); await saveEvidence('web')
  await assertEvidenceMatches(state, { root })
  const reportPath = path.join(root, state.validation.web.report)
  await writeFile(reportPath, JSON.stringify({ status: 'failed' }))
  await assert.rejects(assertEvidenceMatches(state, { root }), /evidence differs/)
  state.validation.web.artifacts = []
  await saveEvidence('web')
  await assert.rejects(assertEvidenceMatches(state, { root }), /does not cover the current matrix/)
  state.validation.web = ready().validation.web
  state.validation.web.resources[0].closed = false
  await saveEvidence('web')
  await assert.rejects(assertEvidenceMatches(state, { root }), /resource open/)
})

test('report check rejects earlier successful reports after a later failed or different run', () => {
  const published = ready()
  const latest = ready()
  assertLatestRun(published, latest)
  latest.status = 'failed'
  assert.throws(() => assertLatestRun(published, latest), /latest run failed/)
  latest.status = 'validated'
  latest.environment.generatedAt = 'next-run'
  assert.throws(() => assertLatestRun(published, latest), /earlier run/)
})

test('published gate evidence remains verifiable after cloning into a different root', async t => {
  const originalRoot = await mkdtemp(path.join(os.tmpdir(), 'style-publish-original-'))
  const cloneRoot = await mkdtemp(path.join(os.tmpdir(), 'style-publish-clone-'))
  t.after(() => Promise.all([originalRoot, cloneRoot].map(root => rm(root, { recursive: true, force: true }))))
  const state = ready()
  state.rows[0].directory = path.join(originalRoot, '.bench/fixtures/reference/standard/gallery/weapp/dist')
  state.validation.web.resources[0].projectPath = path.join(originalRoot, '.bench/ide-projects/owned-project')
  state.validation.web.resources[0].cliPath = '/Applications/devtools/cli'
  for (const name of ['headless', 'web']) {
    const { report, ...evidence } = state.validation[name]
    await mkdir(path.dirname(path.join(originalRoot, report)), { recursive: true })
    await writeFile(path.join(originalRoot, report), JSON.stringify(evidence))
  }
  let saved
  await publishPortableEvidence(state, { root: originalRoot, save: async value => { saved = structuredClone(value) } })
  assert.equal(saved.rows[0].directory, state.rows[0].directory)
  assert.equal(saved.validation.web.resources[0].projectPath, '.bench/ide-projects/owned-project')
  assert.equal(saved.validation.web.resources[0].cliPath, '/Applications/devtools/cli')
  await assertEvidenceMatches(saved, { root: originalRoot })
  await cp(path.join(originalRoot, 'reports'), path.join(cloneRoot, 'reports'), { recursive: true })
  const published = portablePaths(saved, originalRoot)
  await assertEvidenceMatches(published, { root: cloneRoot, transform: value => portablePaths(value, cloneRoot) })
  const written = await readFile(path.join(cloneRoot, published.validation.web.report), 'utf8')
  assert.ok(!written.includes(originalRoot))
})

test('portable publication refuses altered evidence before rewriting any cached pass', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'style-publish-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = ready()
  const filename = path.join(root, state.validation.headless.report)
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, JSON.stringify({ status: 'failed' }))
  let saved = false
  await assert.rejects(publishPortableEvidence(state, { root, save: async () => { saved = true } }), /evidence differs/)
  assert.equal(saved, false)
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).status, 'failed')
})

test('passed IDE evidence requires a passed reference calibration bound to its measured files and screenshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'style-state-calibration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = ready()
  const measurementFiles = [{ path: 'app.wxss', raw: 4, sha256: 'a'.repeat(64) }]
  state.rows[0].measurement = { files: measurementFiles }
  const files = measurementFiles.map(file => ({ path: file.path, bytes: file.raw, sha256: file.sha256 }))
  const calibration = {
    key: 'reference/standard/gallery/weapp', status: 'passed',
    reference: { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') },
    routes: [{ path: '/pages/gallery/index', screenshot: 'reports/evidence/ide/reference-rpx.png' }],
  }
  state.validation.ide = { status: 'passed', report: 'reports/evidence/ide/report.json', artifacts: [], calibrations: [calibration], resources: [{ closed: true }] }
  async function saveGates() {
    for (const name of ['headless', 'web', 'ide']) {
      const { report, ...evidence } = state.validation[name]
      await mkdir(path.dirname(path.join(root, report)), { recursive: true })
      await writeFile(path.join(root, report), JSON.stringify(evidence))
    }
  }
  await saveGates()
  await assert.rejects(assertEvidenceMatches(state, { root }), error => error.code === 'ENOENT' && error.path.endsWith('reference-rpx.png'))
  await writeFile(path.join(root, calibration.routes[0].screenshot), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  await assertEvidenceMatches(state, { root })
  for (const [alter, pattern] of [
    [() => { state.validation.ide.calibrations = [] }, /exactly one/],
    [() => { state.validation.ide.calibrations[0].key = 'tailwind/standard/gallery/weapp' }, /must use the handwritten/],
    [() => { state.validation.ide.calibrations[0].status = 'failed' }, /calibration did not pass/],
    [() => { state.validation.ide.calibrations[0].reference.files[0].sha256 = 'b'.repeat(64) }, /reference files differ/],
    [() => { state.validation.ide.calibrations[0].reference.sha256 = 'b'.repeat(64) }, /manifest hash differs/],
  ]) {
    state.validation.ide.calibrations = [structuredClone(calibration)]
    alter()
    await saveGates()
    await assert.rejects(assertEvidenceMatches(state, { root }), pattern)
  }
})

test('headless class visibility respects independent and ordinary package boundaries', () => {
  const stylesheets = [{ path: 'app.wxss', css: '.main{}' }, { path: 'ordinary/page.wxss', css: '.ordinary{}' }, { path: 'independent/page.wxss', css: '.independent{}' }]
  const packages = [{ root: 'ordinary' }, { root: 'independent', independent: true }]
  assert.deepEqual([...classesForRoute(stylesheets, '/pages/home/index', packages)], ['main'])
  assert.deepEqual([...classesForRoute(stylesheets, '/ordinary/page', packages)], ['main', 'ordinary'])
  assert.deepEqual([...classesForRoute(stylesheets, '/independent/page', packages)], ['independent'])
})
