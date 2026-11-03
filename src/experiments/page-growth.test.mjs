import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generatePageGrowthFixture, NODES_PER_PAGE, pageMatrix, runPageGrowth, settlePageBuilds } from './page-growth.mjs'

test('page-growth matrix varies real page count independently of per-page node count', () => {
  assert.equal(pageMatrix().length, 60)
  assert.deepEqual([...new Set(pageMatrix().map(row => row.pageCount))], [1, 5, 10, 20, 50])
  assert.throws(() => pageMatrix({ pages: [0] }), /Page counts/)
  assert.throws(() => pageMatrix({ pages: [1, 1] }), /Duplicate page counts/)
})

test('failed page-growth retries invalidate both public and local cached passes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'page-growth-state-'))
  try {
    const files = ['.bench/page-growth/run.json', 'reports/page-growth/results.json']
    for (const file of files) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), JSON.stringify({ status: 'built', rows: [{ stale: true }] }))
    }
    await assert.rejects(() => runPageGrowth(root, { filters: { pages: [1, 1] } }), /Duplicate page counts/)
    for (const file of files) {
      const state = JSON.parse(await readFile(path.join(root, file), 'utf8'))
      assert.equal(state.status, 'failed')
      assert.deepEqual(state.rows, [])
      assert.match(state.error, /Duplicate page counts/)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a worker failure waits for in-flight builds to settle and stops new jobs', async () => {
  const started = []
  const finished = []
  await assert.rejects(() => settlePageBuilds([0, 1, 2], 2, async job => {
    started.push(job)
    await new Promise(resolve => setTimeout(resolve, job === 0 ? 5 : 35))
    if (job === 0) throw new Error('first build failed')
    finished.push(job)
    return job
  }), /first build failed/)
  assert.deepEqual(started, [0, 1])
  assert.deepEqual(finished, [1])
})

test('multipage fixtures declare actual routes and shared versus per-page style ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'page-growth-'))
  try {
    for (const scheme of ['tailwind', 'panda', 'stylex']) for (const mode of ['reuse', 'unique']) {
      const directory = path.join(root, scheme, mode)
      const fixture = await generatePageGrowthFixture({ directory, scheme, mode, pageCount: 5, target: 'weapp' })
      const app = JSON.parse(await readFile(path.join(directory, 'src/app.json'), 'utf8'))
      assert.equal(app.pages.length, 5)
      assert.equal(fixture.routes.length, 5)
      assert.deepEqual((await readdir(path.join(directory, 'src/pages'))).sort(), app.pages.map(route => route.split('/')[1]).sort())
      for (const route of app.pages) {
        const wxml = await readFile(path.join(directory, 'src', `${route}.wxml`), 'utf8')
        assert.equal((wxml.match(/id="bench-node-/g) ?? []).length, NODES_PER_PAGE * 2)
        assert.doesNotMatch(wxml, /wx:for/)
        const source = await readFile(path.join(directory, 'src', `${route}.ts`), 'utf8')
        if (scheme === 'tailwind') assert.equal(source, 'Page({})\n')
        else assert.match(source, mode === 'reuse' ? /\.\.\/\.\.\/styles\/shared-page\.styles/ : /\.\/index\.styles/)
      }
      const colors = fixture.routes.map(route => route.elements.filter(node => node.id.startsWith('bench-node-')).map(node => node.styles.backgroundColor))
      if (mode === 'reuse') assert.deepEqual(colors[0], colors[4])
      else assert.equal(new Set(colors.flat()).size, 5 * NODES_PER_PAGE)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reuse and unique start from identical first-page source and effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'page-growth-start-'))
  try {
    for (const scheme of ['tailwind', 'panda', 'stylex']) {
      const fixtures = []
      for (const mode of ['reuse', 'unique']) fixtures.push(await generatePageGrowthFixture({ directory: path.join(root, scheme, mode), scheme, mode, pageCount: 1, target: 'web' }))
      assert.deepEqual(fixtures[0].routes, fixtures[1].routes)
      assert.equal(await readFile(path.join(root, scheme, 'reuse/src/pages/bench-page-001/index.wxml'), 'utf8'), await readFile(path.join(root, scheme, 'unique/src/pages/bench-page-001/index.wxml'), 'utf8'))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
