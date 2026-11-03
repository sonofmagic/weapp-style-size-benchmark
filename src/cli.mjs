import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMatrix, matrix, verifyMeasurements } from './build/matrix.mjs'
import { environment, inputFingerprint, protocol } from './build/environment.mjs'
import { writeReports, validateReport, csv, fileCsv } from './report/index.mjs'
import { readme } from './report/readme.mjs'
import { scalingChart } from './report/chart.mjs'
import { assertEvidenceMatches, assertLatestRun, publishPortableEvidence, runGates } from './validate/run-state.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const stateFile = path.join(root, '.bench', 'run.json')
const rootReadme = path.join(root, 'README.md')
const reports = path.join(root, 'reports')
const evidenceDirectory = path.join(reports, 'evidence')
const args = process.argv.slice(3)
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const filters = Object.fromEntries(['scheme', 'profile', 'scenario', 'target'].map(key => [key, option(key)]).filter(([, value]) => value))

const saveState = async state => {
  await mkdir(path.dirname(stateFile), { recursive: true })
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)
}
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'))

function portable(value) {
  if (typeof value === 'string') return value.replaceAll(`${root}${path.sep}`, '').replaceAll(root, '.').split(path.sep).join('/')
  if (Array.isArray(value)) return value.map(portable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['directory', 'fixtureDirectory'].includes(key)).map(([key, item]) => [key, portable(item)]))
  return value
}

async function build() {
  await saveState({ status: 'building', rows: [], validation: {} })
  let env
  try {
    await rm(evidenceDirectory, { recursive: true, force: true })
    env = await environment(root)
    const concurrency = Number(option('concurrency') ?? 2)
    assert.ok(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 8, 'Build concurrency must be an integer from 1 to 8')
    await saveState({ status: 'building', environment: env, rows: [], validation: {} })
    const rows = await buildMatrix(root, filters, concurrency)
    const state = { schemaVersion: 1, status: 'built', environment: env, protocol, rows, validation: { web: { status: 'pending' }, headless: { status: 'pending' }, ide: { status: 'pending' } } }
    await saveState(state)
    return state
  } catch (error) {
    await saveState({ status: 'failed', environment: env, rows: [], validation: {}, error: error.stack ?? String(error) })
    throw error
  }
}

async function validate(state) {
  const { validateWeb } = await import('./validate/web.mjs')
  const { validateHeadless } = await import('./validate/headless.mjs')
  return runGates(state, [
    { name: 'headless', run: () => validateHeadless(state.rows, { root, evidenceDirectory: path.join(evidenceDirectory, 'headless') }) },
    { name: 'web', run: () => validateWeb(state.rows, { root, evidenceDirectory: path.join(evidenceDirectory, 'web') }) },
  ], { save: saveState, verify: () => verifyMeasurements(state.rows), validateRows: true })
}

async function ide(state) {
  const { validateIde } = await import('./validate/ide.mjs')
  return runGates(state, [{ name: 'ide', run: () => validateIde(state.rows, {
      root, evidenceDirectory: path.join(evidenceDirectory, 'ide'),
      cliPath: process.env.WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH,
      appid: process.env.BENCHMARK_WECHAT_APPID ?? 'wxb3d842a4a7e3440d',
    }) }], { save: saveState, verify: () => verifyMeasurements(state.rows) })
}

async function report(state) {
  assert.equal(state.rows.length, matrix().length, 'Partial smoke runs cannot publish a full report')
  assert.equal((await inputFingerprint(root)).sha256, state.environment.inputs.sha256, 'Build inputs changed after the run')
  await verifyMeasurements(state.rows)
  await publishPortableEvidence(state, { root, save: saveState })
  await writeReports(portable(state), { directory: reports, readmePath: rootReadme })
  process.stdout.write('Reports and README generated from the complete validated run.\n')
}

async function check() {
  const published = JSON.parse(await readFile(path.join(reports, 'results.json'), 'utf8'))
  validateReport(published)
  let latest
  try { latest = await readState() } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (latest) { assertLatestRun(published, latest); await verifyMeasurements(latest.rows) }
  await assertEvidenceMatches(published, { root, transform: portable })
  assert.equal((await inputFingerprint(root)).sha256, published.environment.inputs.sha256, 'Published results do not match current build inputs')
  assert.equal(await readFile(rootReadme, 'utf8'), readme(published, 'reports'), 'README does not match results.json')
  assert.equal(await readFile(path.join(reports, 'results.csv'), 'utf8'), csv(published), 'CSV does not match results.json')
  assert.equal(await readFile(path.join(reports, 'files.csv'), 'utf8'), fileCsv(published), 'Per-file CSV does not match results.json')
  assert.equal(await readFile(path.join(reports, 'scaling.svg'), 'utf8'), scalingChart(published), 'Chart does not match results.json')
  process.stdout.write('Report, README, CSV, chart and build-input fingerprint agree.\n')
}

try {
  assert.equal(process.versions.node, '24.22.1', 'Use the pinned Node 24.22.1 runtime (pnpm install installs devEngines.runtime)')
  const command = process.argv[2] ?? 'bench'
  if (command === 'build') await build()
  else if (command === 'measure') { const state = await readState(); await verifyMeasurements(state.rows); process.stdout.write('All current artifacts match their measured manifests.\n') }
  else if (command === 'validate') await validate(await readState())
  else if (command === 'ide') { const state = await ide(await readState()); if (state.rows.length === matrix().length && state.validation.web.status === 'passed') await report(state) }
  else if (command === 'report') await report(await readState())
  else if (command === 'check') await check()
  else if (command === 'bench') {
    const state = await validate(await build())
    if (process.env.BENCHMARK_RUN_IDE === '1') await ide(state)
    await report(state)
  }
  else throw new Error(`Unknown command: ${command}`)
}
catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
}
