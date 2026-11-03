import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateReferences } from './references.mjs'

async function artifact(t, files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'style-references-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await save(directory, files)
  return directory
}

async function save(directory, files) {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true })
    await writeFile(path.join(directory, file), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

const native = {
  'app.json': { pages: ['pages/home/index'] },
  'app.js': 'require("./common")',
  'common.js': 'module.exports = {}',
  'pages/home/index.js': 'Page({})',
  'pages/home/index.json': { usingComponents: { metric: '/components/metric/index' } },
  'pages/home/index.wxml': '<wxs module="utils" src="../../utils.wxs"/><include src="../../templates/content.wxml"/><metric/>',
  'pages/home/index.wxss': '@import "../../styles/base.wxss";',
  'components/metric/index.js': 'Component({})',
  'components/metric/index.json': { component: true },
  'components/metric/index.wxml': '<view/>',
  'styles/base.wxss': 'view{color:red}',
  'templates/content.wxml': '<view/>',
  'utils.wxs': 'module.exports = {}',
}

test('native references resolve declared pages, components, templates, styles and WXS modules', async t => {
  const directory = await artifact(t, native)
  const result = await validateReferences(directory, { target: 'weapp' })
  assert.equal(result.status, 'passed')
  assert.equal(result.files, Object.keys(native).length)
  assert.ok(result.references.some(reference => reference.to === 'common.js'))
  assert.ok(result.references.some(reference => reference.to === 'utils.wxs'))
  assert.ok(result.references.some(reference => reference.to === 'templates/content.wxml'))
})

test('removing any referenced native artifact fails instead of accepting a partial build', async t => {
  const directory = await artifact(t, native)
  for (const file of ['pages/home/index.js', 'pages/home/index.wxml', 'pages/home/index.json', 'components/metric/index.wxml', 'common.js', 'styles/base.wxss', 'templates/content.wxml', 'utils.wxs']) {
    await rm(path.join(directory, file))
    await assert.rejects(validateReferences(directory, { target: 'weapp' }), /missing/)
    await save(directory, { [file]: native[file] })
  }
})

test('web follows real module syntax, extensionless resolutions and escaped HTML attributes', async t => {
  const directory = await artifact(t, {
    'index.html': '<!-- <script src="missing.js"> --><script type="module" src="/assets/app.js?v=1&amp;x=2"></script><link rel="stylesheet" href="./assets/app.css"><script type="module">import "./inline.js"</script>',
    'assets/app.js': String.raw`import "./side.js"; export { value } from "./export.js"; import("./lazy.js"); require("./common"); require("./directory"); const text = "require(\"./not-real.js\")"; /* import "./absent.js" */ import(selectedModule);`,
    'assets/side.js': '', 'assets/export.js': 'export const value = 1',
    'assets/lazy.js': '', 'assets/common.json': '{}', 'assets/directory/index.js': '',
    'assets/app.css': '@import url("./base.css") layer(base);', 'assets/base.css': '',
    'inline.js': '',
  })
  const result = await validateReferences(directory, { target: 'web' })
  assert.equal(result.dynamicReferences, 1)
  assert.ok(result.references.some(reference => reference.to === 'assets/common.json'))
  assert.ok(result.references.some(reference => reference.to === 'assets/directory/index.js'))
  await rm(path.join(directory, 'assets/export.js'))
  await assert.rejects(validateReferences(directory, { target: 'web' }), /missing JavaScript module/)
})

test('external URLs and nonliteral imports do not become guessed local paths', async t => {
  const directory = await artifact(t, {
    'index.html': '<script src="https://cdn.example.com/app.js"></script><link href="//cdn.example.com/app.css"><script type="module" src="./app.js"></script>',
    'app.js': 'import "https://cdn.example.com/module.js"; import "dependency"; require(getModulePath())',
    'app.css': '@import "data:text/css,view%7Bcolor:red%7D";',
  })
  const result = await validateReferences(directory, { target: 'web' })
  assert.equal(result.external.length, 5)
  assert.equal(result.dynamicReferences, 1)
})

test('paths cannot escape the final artifact even through URL encoding', async t => {
  const directory = await artifact(t, { 'index.html': '<script src="./app.js"></script>', 'app.js': '' })
  for (const request of ['../outside.js', '/%2e%2e/outside.js', '..%2Foutside.js', './%5c..%5coutside.js']) {
    await save(directory, { 'app.js': `import ${JSON.stringify(request)}` })
    await assert.rejects(validateReferences(directory, { target: 'web' }), /escape|invalid artifact path/)
  }
})

test('an independent package may use its own code and components', async t => {
  const directory = await artifact(t, {
    ...native,
    'app.json': { pages: ['pages/home/index'], subPackages: [{ root: 'independent', independent: true, pages: ['settings/index'] }] },
    'independent/settings/index.js': 'require("../shared")',
    'independent/settings/index.json': { usingComponents: { card: '../components/card/index' } },
    'independent/settings/index.wxml': '<include src="../content.wxml"/><card/>',
    'independent/settings/index.wxss': '@import "../base.wxss";',
    'independent/shared.js': '', 'independent/content.wxml': '<view/>', 'independent/base.wxss': '',
    'independent/components/card/index.js': 'Component({})',
    'independent/components/card/index.json': { component: true },
    'independent/components/card/index.wxml': '<view/>',
  })
  const result = await validateReferences(directory, { target: 'weapp' })
  assert.deepEqual(result.independentPackages, ['independent'])
  for (const [file, content] of [
    ['independent/settings/index.js', 'require("../../common")'],
    ['independent/settings/index.json', { usingComponents: { card: '/components/metric/index' } }],
    ['independent/settings/index.wxml', '<include src="../../templates/content.wxml"/>'],
    ['independent/settings/index.wxss', '@import "../../styles/base.wxss";'],
  ]) {
    const original = file.endsWith('.json') ? { usingComponents: { card: '../components/card/index' } } : ({ js: 'require("../shared")', wxml: '<include src="../content.wxml"/><card/>', wxss: '@import "../base.wxss";' })[file.split('.').at(-1)]
    await save(directory, { [file]: content })
    await assert.rejects(validateReferences(directory, { target: 'weapp' }), /Independent subpackage independent cannot reference outside/)
    await save(directory, { [file]: original })
  }
})

test('HTML and JavaScript lexical content cannot manufacture resource references', async t => {
  const directory = await artifact(t, {
    'index.html': String.raw`<script>const value = "<script src=\"missing.js\">";</script><script type="application/json">{"text":"<link href=\"missing.css\">"}</script><div title="> <script src=missing.js>"></div><link href="app.css">`,
    'app.css': '/* @import "missing.css"; */ view{color:red}',
  })
  const result = await validateReferences(directory, { target: 'web' })
  assert.equal(result.references.length, 1)
})

test('inline WXS references and include following self closing WXS are both inspected', async t => {
  const directory = await artifact(t, { ...native, 'pages/home/index.wxml': '<wxs module="utils">var value = require("../../utils.wxs"); module.exports=value</wxs><include src="../../templates/content.wxml"/>' })
  const result = await validateReferences(directory, { target: 'weapp' })
  assert.ok(result.references.some(reference => reference.kind === 'JavaScript module' && reference.to === 'utils.wxs'))
  await rm(path.join(directory, 'templates/content.wxml'))
  await assert.rejects(validateReferences(directory, { target: 'weapp' }), /missing WXML include/)
})

test('malformed emitted JavaScript reports the source artifact', async t => {
  const directory = await artifact(t, { 'index.html': '', 'app.js': 'export const =' })
  await assert.rejects(validateReferences(directory, { target: 'web' }), /Cannot parse emitted JavaScript in app.js/)
})

test('artifact symlinks are rejected instead of following outside files', async t => {
  const directory = await artifact(t, { 'index.html': '' })
  await symlink('index.html', path.join(directory, 'alias.html'))
  await assert.rejects(validateReferences(directory, { target: 'web' }), /Artifact symlink is forbidden/)
})
