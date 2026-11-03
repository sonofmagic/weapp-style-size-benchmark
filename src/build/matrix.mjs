import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { generateFixture } from '../fixtures/index.mjs'
import { PANDA_THEME } from '../fixtures/spec.mjs'
import { collect, assertRepeatable } from '../measure/index.mjs'
import { configureFixture } from './config.mjs'
import { runNode } from './process.mjs'
import { minifyNativeStyles } from './minify.mjs'
import { validateReferences } from '../validate/references.mjs'

export const schemes = ['tailwind', 'panda', 'stylex', 'reference', 'unstyled']
export const profiles = ['standard', 'optimized']
export const scenarios = ['gallery', 'application', 'reuse-10', 'reuse-100', 'reuse-1000', 'unique-10', 'unique-100', 'unique-1000']
export const targets = ['weapp', 'web']
export const idOf = row => [row.scheme, row.profile, row.scenario, row.target].join('/')

export function matrix(filters = {}) {
  return schemes.flatMap(scheme => profiles.flatMap(profile => scenarios.flatMap(scenario => targets.map(target => ({ scheme, profile, scenario, target })))))
    .filter(row => Object.entries(filters).every(([key, value]) => !value || row[key] === value))
}

export async function buildOne(root, row) {
  const fixtureDirectory = path.join(root, '.bench', 'fixtures', idOf(row))
  const logs = path.join(root, '.bench', 'logs', idOf(row))
  await rm(fixtureDirectory, { recursive: true, force: true })
  await generateFixture({ directory: fixtureDirectory, ...row })
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
    if (row.target === 'weapp') await writeFile(path.join(directory, 'project.config.json'), JSON.stringify({ appid: 'touristappid', projectname: 'style-size-benchmark', miniprogramRoot: '.', setting: { es6: true, minified: false, urlCheck: false } }, null, 2))
    if (row.target === 'weapp') cssMinification = await minifyNativeStyles(directory)
    referenceValidation = await validateReferences(directory, { target: row.target })
    rounds.push(await collect(directory, { target: row.target }))
  }
  assertRepeatable(rounds[0], rounds[1])
  const fixture = JSON.parse(await readFile(path.join(fixtureDirectory, 'fixture.json'), 'utf8'))
  assert.ok(fixture.routes.length > 0, 'Fixture has no routes')
  return { ...row, directory, fixtureDirectory, measurement: rounds[1], cssMinification, referenceValidation, repeatable: true, validation: { status: 'pending' } }
}

export async function buildMatrix(root, filters = {}, concurrency = 2) {
  const jobs = matrix(filters)
  assert.ok(jobs.length, `No matrix entries match ${JSON.stringify(filters)}`)
  const rows = new Array(jobs.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < jobs.length) {
      const index = next++
      process.stdout.write(`[${index + 1}/${jobs.length}] ${idOf(jobs[index])}\n`)
      try { rows[index] = await buildOne(root, jobs[index]) }
      catch (error) { failed = true; throw error }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  await mkdir(path.join(root, '.bench'), { recursive: true })
  await writeFile(path.join(root, '.bench', 'rows.json'), `${JSON.stringify(rows, null, 2)}\n`)
  return rows
}

export async function verifyMeasurements(rows) {
  for (const row of rows) {
    await validateReferences(row.directory, { target: row.target })
    assertRepeatable(row.measurement, await collect(row.directory, { target: row.target }))
  }
}
