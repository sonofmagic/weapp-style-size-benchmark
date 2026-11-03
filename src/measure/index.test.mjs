import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { assertRepeatable, collect, compareManifests, manifest, packageRoots } from './index.mjs'

async function fixture(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'style-size-measure-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), content)
  }
  return directory
}

test('measures each physical file with fixed compression and explicit exclusions', async t => {
  const content = 'a repeated declaration;'.repeat(50)
  const directory = await fixture(t, { 'index.html': '<html></html>', 'a.css': content, 'copy.css': content, 'runtime.wxs': 'module.exports=1', 'a.css.map': '{}', 'project.private.config.json': '{}' })
  const measurement = await collect(directory, { target: 'web' })
  assert.equal(measurement.files.length, 4)
  const a = measurement.files.find(file => file.path === 'a.css')
  const b = measurement.files.find(file => file.path === 'copy.css')
  assert.equal(a.sha256, b.sha256)
  assert.equal(a.gzip, gzipSync(content, { level: 9 }).byteLength)
  assert.equal(a.brotli, brotliCompressSync(content, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength)
  assert.equal(measurement.byKind.style.raw, Buffer.byteLength(content) * 2)
  assert.equal(measurement.files.find(file => file.path === 'runtime.wxs').kind, 'script')
  for (const key of ['raw', 'gzip', 'brotli']) assert.equal(measurement.totals[key], measurement.files.reduce((sum, file) => sum + file[key], 0))
  assert.deepEqual(measurement.excluded.map(file => file.path), ['a.css.map', 'project.private.config.json'])
})

test('partitions from app.json with segment boundaries and no shared allocation', async t => {
  const directory = await fixture(t, { 'app.json': '{"subPackages":[{"root":"feature"}]}', 'app.wxss': '.a{}', 'shared/style.wxss': '.b{}', 'feature/index.wxml': '<view/>', 'feature-other/index.js': 'Page({})' })
  const measurement = await collect(directory, { target: 'weapp' })
  assert.equal(measurement.files.find(file => file.path === 'feature/index.wxml').package, 'feature')
  assert.equal(measurement.files.find(file => file.path === 'feature-other/index.js').package, 'main')
  assert.equal(measurement.files.find(file => file.path === 'shared/style.wxss').package, 'main')
  assert.equal(Object.values(measurement.byPackage).reduce((sum, value) => sum + value.raw, 0), measurement.totals.raw)
})

test('rejects ambiguous, invalid, duplicate and overlapping subpackage roots', () => {
  for (const roots of [[''], ['/a'], ['a/../b'], ['a//b'], ['a/'], ['a\\b'], ['C:/a'], ['a', 'a'], ['a', 'a/b']]) {
    assert.throws(() => packageRoots({ subPackages: roots.map(root => ({ root })) }))
  }
  assert.throws(() => packageRoots({ subPackages: [], subpackages: [] }), /Ambiguous/)
  assert.deepEqual(packageRoots({ subpackages: [{ root: 'a' }, { root: 'ab' }] }), ['a', 'ab'])
})

test('rejects empty outputs, missing required entries, and symlinks', async t => {
  const empty = await fixture(t, {})
  await assert.rejects(collect(empty, { target: 'web' }), /no deployable/)
  const missing = await fixture(t, { 'style.css': '.a{}' })
  await assert.rejects(collect(missing, { target: 'weapp' }), /app.json/)
  await assert.rejects(collect(missing, { target: 'web' }), /HTML/)
  const links = await fixture(t, { 'index.html': '<html/>' })
  await symlink(path.join(links, 'index.html'), path.join(links, 'link.html'))
  await assert.rejects(collect(links, { target: 'web' }), /Symbolic/)
})

test('manifests detect added, removed and content-modified files', () => {
  const before = manifest([{ path: 'a', sha256: '1' }, { path: 'b', sha256: '2' }])
  const after = manifest([{ path: 'b', sha256: '3' }, { path: 'c', sha256: '1' }])
  assert.deepEqual(compareManifests(before, after), { added: ['c'], removed: ['a'], changed: ['b'] })
  assert.throws(() => assertRepeatable(before, after), /Production outputs differ/)
  assert.equal(assertRepeatable(before, manifest([...before.files].reverse())), true)
  assert.throws(() => manifest([]), /empty/)
})
