import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pageMatrix } from './page-growth.mjs'
import { assertPageGrowthMatrix, verifyPageGrowthArtifacts } from './validate-page-growth.mjs'
import { collect } from '../measure/index.mjs'

test('page validation rejects replacement duplicates and unexpected combinations', () => {
  const rows = pageMatrix().map(row => ({ ...row, nodesPerPage: 20, repeatable: true, referenceValidation: { status: 'passed' }, roundManifests: [{ files: [] }, { files: [] }] }))
  assert.doesNotThrow(() => assertPageGrowthMatrix(rows))
  assert.throws(() => assertPageGrowthMatrix([...rows.slice(0, -1), rows[0]]), /Duplicate/)
  assert.throws(() => assertPageGrowthMatrix(rows.map((row, index) => index === 0 ? { ...row, pageCount: 2 } : row)), /Missing or unexpected/)
  assert.throws(() => assertPageGrowthMatrix(rows.slice(1)), /complete/)
  assert.throws(() => assertPageGrowthMatrix(rows.map((row, index) => index === 0 ? { ...row, roundManifests: [{ files: [] }, { files: [{ path: 'unexpected' }] }] } : row)), /build rounds disagree/)
})

test('page artifact validation detects additional files as well as changed and missing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'page-growth-artifacts-'))
  try {
    await writeFile(path.join(directory, 'index.html'), '<main>benchmark</main>')
    const row = { scheme: 'tailwind', mode: 'reuse', pageCount: 1, target: 'web', directory, measurement: await collect(directory, { target: 'web' }) }
    await assert.doesNotReject(() => verifyPageGrowthArtifacts([row]))
    await writeFile(path.join(directory, 'extra.css'), 'main{color:red}')
    await assert.rejects(() => verifyPageGrowthArtifacts([row]), /complete artifact/)
    await rm(path.join(directory, 'extra.css'))
    await writeFile(path.join(directory, 'index.html'), '<main>changed</main>')
    await assert.rejects(() => verifyPageGrowthArtifacts([row]), /complete artifact/)
    await rm(path.join(directory, 'index.html'))
    await assert.rejects(() => verifyPageGrowthArtifacts([row]), /no deployable files/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
