import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPageGrowth, pageId, pageMatrix, pageFilesCsv, pageRowsCsv, settlePageBuilds } from './page-growth.mjs'
import { inputFingerprint } from '../build/environment.mjs'
import { collect } from '../measure/index.mjs'
import { validateHeadless } from '../validate/headless.mjs'
import { validateWeb } from '../validate/web.mjs'

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const stateFile = path.join(root, '.bench/page-growth/run.json')
const publicFile = path.join(root, 'reports/page-growth/results.json')
const evidenceDirectory = path.join(root, 'reports/page-growth/evidence')
const portable = value => Array.isArray(value) ? value.map(portable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['directory', 'fixtureDirectory'].includes(key)).map(([key, item]) => [key, portable(item)]))
  : typeof value === 'string' ? value.replaceAll(`${root}${path.sep}`, '').split(path.sep).join('/') : value
async function save(file, value) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n') }
async function persist(state) {
  await writeFile(path.join(root, 'reports/page-growth/results.csv'), pageRowsCsv(state.rows))
  await writeFile(path.join(root, 'reports/page-growth/files.csv'), pageFilesCsv(state.rows))
  await save(stateFile, state)
  await save(publicFile, portable(state))
}
export function assertPageGrowthMatrix(rows) {
  const expected = pageMatrix()
  assert.equal(rows.length, expected.length, 'Validation requires the complete 60-project page matrix')
  const keys = rows.map(pageId)
  assert.equal(new Set(keys).size, expected.length, 'Duplicate page-growth matrix rows')
  assert.deepEqual([...keys].sort(), expected.map(pageId).sort(), 'Missing or unexpected page-growth matrix rows')
  for (const row of rows) {
    const spec = expected.find(item => pageId(item) === pageId(row))
    for (const key of ['profile', 'scenario']) assert.equal(row[key], spec[key], `${pageId(row)}: ${key}`)
    assert.equal(row.nodesPerPage, 20, `${pageId(row)}: style probes per page`)
    assert.equal(row.repeatable, true, `${pageId(row)}: unstable output`)
    assert.equal(row.referenceValidation?.status, 'passed', `${pageId(row)}: artifact references`)
    assert.equal(row.roundManifests?.length, 2, `${pageId(row)}: missing build rounds`)
    assert.deepEqual(row.roundManifests[0], row.roundManifests[1], `${pageId(row)}: build rounds disagree`)
  }
}
export async function verifyPageGrowthArtifacts(rows) {
  for (const row of rows) {
    const current = await collect(row.directory, { target: row.target })
    assert.deepEqual(current, row.measurement, `${pageId(row)}: complete artifact files or measurements changed`)
  }
}
async function representativeRoutes(row) {
  const fixture = JSON.parse(await readFile(path.join(row.fixtureDirectory, 'fixture.json'), 'utf8'))
  const indices = [...new Set([0, Math.floor((fixture.routes.length - 1) / 2), fixture.routes.length - 1])]
  const directory = path.join(root, '.bench/page-growth/visual-contracts', pageId(row))
  await save(path.join(directory, 'fixture.json'), { ...fixture, routes: indices.map(index => fixture.routes[index]) })
  return { ...row, fixtureDirectory: directory }
}

export async function validatePageGrowth() {
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  state.status = 'validating'
  delete state.error
  state.validation = { preflight: { status: 'running' }, reference: { status: 'pending' }, headless: { status: 'pending' }, web: { status: 'pending' }, ide: { status: 'not-run' } }
  for (const row of state.rows) row.validation = { status: 'structural-passed', visual: 'pending' }
  await persist(state)
  let active = 'preflight'
  try {
    assertPageGrowthMatrix(state.rows)
    assert.deepEqual(await inputFingerprint(root), state.environment.inputs, 'Core build inputs changed; rebuild the page experiment')
    const sourceSha = createHash('sha256').update(await readFile(new URL('./page-growth.mjs', import.meta.url))).digest('hex')
    assert.equal(sourceSha, state.environment.experimentSourceSha256, 'Page experiment source changed; rebuild the page experiment')
    state.environment.validationSourceSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
    await verifyPageGrowthArtifacts(state.rows)
    state.validation.preflight = { status: 'passed', checks: 'Complete unique matrix, current build/experiment inputs, all physical deployable files and measurements' }
    active = 'reference'
    state.validation.reference = { status: 'running' }
    await persist(state)
    const referenceJobs = state.rows.filter(row => row.scheme === 'tailwind' && row.target === 'web')
    const references = await settlePageBuilds(referenceJobs, 3, async (row, index) => {
      const { mode, pageCount, target, profile, scenario } = row
      process.stdout.write(`Reference ${index + 1}/${referenceJobs.length}: ${mode}/${pageCount}\n`)
      return buildPageGrowth(root, { scheme: 'reference', mode, pageCount, target, profile, scenario })
    })
    await save(path.join(root, '.bench/page-growth/references.json'), references)
    state.validation.reference = { status: 'passed', projects: references.length, buildRounds: 2 }
    active = 'headless'
    state.validation.headless = { status: 'running' }
    await persist(state)
    state.validation.headless = await validateHeadless(state.rows, { root, evidenceDirectory: path.join(evidenceDirectory, 'headless') })
    state.validation.headless.report = 'reports/page-growth/evidence/headless/report.json'
    active = 'web'
    state.validation.web = { status: 'running' }
    await persist(state)
    const selected = await Promise.all([...state.rows.filter(row => row.target === 'web'), ...references].map(representativeRoutes))
    state.validation.web = await validateWeb(selected, { root, evidenceDirectory: path.join(evidenceDirectory, 'web') })
    state.validation.web.report = 'reports/page-growth/evidence/web/report.json'
    for (const row of state.rows) row.validation = { status: 'passed', visual: row.target === 'web' ? 'passed' : 'not-run', scope: row.target === 'web' ? 'First/middle/last page: computed styles and geometry at 375px/768px; screenshot pixels at 375px; handwritten CSS production reference' : 'All pages in the native headless runtime: logical structure, classes and expected state; no native visual or additional IDE acceptance' }
    state.protocol.visualValidation = 'Native: every page logical structure/state via headless, not native visual rendering. H5: first/middle/last page of every project against real handwritten CSS production artifacts; computed styles and geometry at 375/768px, screenshot pixels at 375px. No new IDE run for this supplement.'
    for (const gate of ['headless', 'web']) {
      const file = path.join(evidenceDirectory, gate, 'report.json')
      await save(file, portable(JSON.parse(await readFile(file, 'utf8'))))
      state.validation[gate] = portable(state.validation[gate])
    }
    state.status = 'validated'
    await persist(state)
    process.stdout.write('Page-growth native headless and representative H5 equivalence passed.\n')
    return state
  } catch (error) {
    state.status = 'failed'
    state.error = error.stack ?? String(error)
    state.validation[active] = { ...state.validation[active], status: 'failed', error: state.error }
    await persist(state)
    throw error
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validatePageGrowth().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
