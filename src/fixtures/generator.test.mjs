import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateFixture } from './index.mjs'
import { SCHEMES, STYLE_SPEC, TOKENS, rgb, scaleStyle } from './spec.mjs'
import { styleModule } from './styles.mjs'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'weapp-style-size-fixture-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const contract = await generateFixture({ directory, scheme: 'reference', scenario: 'gallery', ...options })
  const read = file => readFile(path.join(directory, file), 'utf8')
  return { directory, contract, read }
}

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(full))
    else result.push(full)
  }
  return result
}

test('rejects unknown matrix values before creating an output', async () => {
  for (const [key, value] of [['scheme', 'unknown'], ['scenario', 'unique-7'], ['profile', 'fast'], ['target', 'alipay']]) {
    await assert.rejects(generateFixture({ directory: '/unused', scheme: 'reference', scenario: 'gallery', [key]: value }), new RegExp(`Unknown ${key}`))
  }
})

test('all schemes expose the same gallery elements and interaction state contract', async t => {
  const generated = []
  for (const scheme of SCHEMES) generated.push(await fixture(t, { scheme }))
  const expected = generated[0].contract.routes[0]
  for (const item of generated) {
    const route = item.contract.routes[0]
    assert.deepEqual(route.elements.map(element => element.id), expected.elements.map(element => element.id))
    assert.deepEqual(route.actions.map(action => [action.id, action.state, action.data]), expected.actions.map(action => [action.id, action.state, action.data]))
    const template = await item.read('src/pages/gallery/index.wxml')
    for (const element of route.elements) {
      assert.ok(template.includes(`id="${element.id}"`), element.id)
      assert.ok(template.includes(`data-testid="${element.id}"`), element.id)
    }
    for (const action of route.actions) assert.ok(template.includes(`id="${action.id}"`))
    if (item.contract.styled) assert.deepEqual(route.elements, expected.elements)
    else for (const element of route.elements) assert.deepEqual(element.styles, {})
  }
  assert.equal(expected.actions.find(action => action.state === 'dark').checks[0].styles.backgroundColor, rgb(TOKENS.dark.surface))
  assert.equal(expected.actions.find(action => action.state === 'grown').checks[0].styles.width, '200px')
  assert.equal(expected.actions.find(action => action.state === 'grown').id, 'bench-action-grow')
  assert.equal(expected.elements.find(element => element.id === 'rpx-probe').wideStyles.width, '204.8px')
  assert.ok(expected.elements.find(element => element.id === 'decorative-probe').styles.backgroundImage.startsWith('linear-gradient('))
})

test('Tailwind emits static utilities in WXML instead of introducing a class map runtime', async t => {
  const { read } = await fixture(t, { scheme: 'tailwind' })
  const script = await read('src/pages/gallery/index.ts')
  const template = await read('src/pages/gallery/index.wxml')
  assert.ok(template.includes('p-[24px]'))
  assert.ok(template.includes('p-bench-space'))
  assert.ok(template.includes('min-[640px]:w-[240px]'))
  assert.ok(template.includes("active ? '"))
  assert.ok(!script.includes('getStyles'))
  assert.ok(!script.includes('classes:'))
  assert.ok((await read('src/tailwind.css')).includes("@source './pages/**/*.{ts,wxml}'"))
})

test('Panda uses public css/cva/sva APIs and resolves its generated runtime from each entry', async t => {
  const { directory, read } = await fixture(t, { scheme: 'panda' })
  const source = await read('src/pages/gallery/index.styles.ts')
  assert.ok(source.includes('cva({'))
  assert.ok(source.includes('sva({'))
  assert.ok(source.includes('compoundVariants:'))
  assert.ok(source.includes('padding":"benchSpace"'))
  const importPath = source.match(/from '([^']+styled-system[^']+)'/)[1]
  assert.equal(path.resolve(directory, 'src/pages/gallery', importPath), path.join(directory, 'styled-system/css/index.mjs'))
  assert.equal(await read('src/panda.css'), '@layer reset, base, tokens, recipes, utilities;\n')
})

test('StyleX owns token/theme declarations and a real dynamic style function', async t => {
  const { read } = await fixture(t, { scheme: 'stylex' })
  const source = await read('src/pages/gallery/index.styles.ts')
  const tokens = await read('src/styles/tokens.stylex.ts')
  assert.ok(tokens.includes('stylex.defineVars('))
  assert.ok(tokens.includes('stylex.createTheme('))
  assert.ok(source.includes('dynamic:(width:number,space:number,tone:string)'))
  assert.ok(source.includes('dark?darkTheme:lightTheme'))
  assert.ok(source.includes('tokens.space'))
  assert.ok(source.includes('tokens.radius'))
  assert.ok((await read('src/pages/gallery/index.wxml')).includes('classes.dynamic.style'))
  assert.ok(!source.includes('var(--bench-surface)'))
})

test('published StyleX compiler and attrs agree on dynamic custom properties', async t => {
  const require = createRequire(import.meta.url)
  const adapter = createRequire(require.resolve('weapp-stylex/weapp-vite')).resolve('@weapp-stylex/weapp-vite')
  const compiler = createRequire(adapter).resolve('@weapp-stylex/compiler')
  const { StylexSession } = await import(compiler)
  const stylex = await import('weapp-stylex')
  const { directory } = await fixture(t, { scheme: 'stylex' })
  const filename = path.join(directory, 'src/pages/gallery/index.styles.ts')
  const source = styleModule({ scheme: 'stylex', styles: STYLE_SPEC, keys: new Set(['dynamic']), file: filename, directory, independent: false }).replace(/^import \{tokens.*\n/m, '')
  for (const target of ['weapp', 'web']) {
    const session = new StylexSession({ backend: 'babel', target })
    try {
      const compiled = await session.transform(source, filename, { resolve: async specifier => require.resolve(specifier), addWatchFile() {}, diagnostic(value) { assert.notEqual(value.level, 'error') } })
      const code = stripTypeScriptTypes(compiled.code.replace(/^import .*\n/gm, '').replace('export function getStyles', 'function getStyles'), { mode: 'strip' })
      const context = { stylex }
      runInNewContext(`${code};globalThis.getStyles=getStyles`, context)
      const css = session.css()
      assert.ok(css.includes('padding:var(--x-padding)'))
      assert.ok(!css.includes('--x-paddingLeft'))
      assert.ok(css.includes('height:20px'))
      for (const [width, padding] of [[120, 8], [200, 20]]) {
        const inlineStyle = context.getStyles(false, false, width).dynamic.style
        assert.ok(inlineStyle.includes(`--x-width:${width}px`))
        assert.ok(inlineStyle.includes(`--x-padding:0 0 0 ${padding}px`))
        const declared = new Set(inlineStyle.split(';').map(declaration => declaration.split(':')[0]))
        for (const [, variable] of css.matchAll(/var\((--x-[^)]+)\)/g)) assert.ok(declared.has(variable), `${target}: ${variable}`)
      }
    }
    finally { session.clear() }
  }
})

test('application declares ordinary and independent packages with local component/style ownership', async t => {
  for (const scheme of SCHEMES) {
    const { read, contract, directory } = await fixture(t, { scheme, scenario: 'application' })
    const app = JSON.parse(await read('src/app.json'))
    assert.deepEqual(app.pages, ['pages/home/index', 'pages/list/index'])
    assert.deepEqual(app.subPackages, [{ root: 'package', pages: ['detail/index'] }, { root: 'independent', pages: ['settings/index'], independent: true }])
    assert.equal(contract.routes.length, 4)
    const home = contract.routes.find(route => route.path === '/pages/home/index')
    assert.deepEqual(home.navigation.map(action => action.path), ['/pages/list/index', '/package/detail/index', '/independent/settings/index'])
    assert.equal(home.elements.find(element => element.id === 'metric-value').component, 'home-metric')
    assert.equal(home.actions.find(action => action.state === 'dark').checks.find(check => check.id === 'metric-value').component, 'home-metric')
    assert.equal(contract.routes.find(route => route.path === '/independent/settings/index').actions.find(action => action.state === 'grown').id, 'bench-action-grow')
    const independentJson = JSON.parse(await read('src/independent/settings/index.json'))
    assert.equal(independentJson.usingComponents['bench-metric'], '../components/metric/index')
    assert.equal(JSON.parse(await read('src/independent/components/metric/index.json')).component, true)
    if (scheme === 'tailwind' || scheme === 'panda') {
      const framework = scheme === 'tailwind' ? 'tailwind' : 'panda'
      assert.ok((await read('src/app.css')).startsWith(`@import './${framework}.css';\n`))
      assert.ok((await read('src/independent/settings/index.css')).startsWith(`@import '../${framework}.css';\n`))
      assert.ok(!(await read('src/app.ts')).includes(`import './${framework}.css'`))
      assert.ok(!(await read('src/independent/settings/index.ts')).includes(`import '../${framework}.css'`))
    }
    if (scheme === 'stylex') {
      const independentStyle = await read('src/independent/settings/index.styles.ts')
      const tokenPath = independentStyle.match(/from '([^']+tokens.stylex)'/)[1]
      assert.equal(path.resolve(directory, 'src/independent/settings', `${tokenPath}.ts`), path.join(directory, 'src/independent/styles/tokens.stylex.ts'))
    }
  }
})

test('scale fixtures contain exactly N explicit nodes and preserve reuse versus uniqueness', async t => {
  for (const kind of ['reuse', 'unique']) {
    const { read, contract } = await fixture(t, { scheme: 'reference', scenario: `${kind}-1000` })
    const template = await read('src/pages/scale/index.wxml')
    const css = await read('src/pages/scale/index.wxss')
    assert.equal([...template.matchAll(/ id="bench-node-\d+"/g)].length, 1000)
    assert.equal(new Set([...template.matchAll(/ id="(bench-node-\d+)"/g)].map(match => match[1])).size, 1000)
    assert.equal(contract.routes[0].elements.filter(element => element.id.startsWith('bench-node-')).length, 1000)
    assert.equal([...css.matchAll(/\.b-scale(?:Repeated|\d+)\{/g)].length, kind === 'reuse' ? 1 : 1000)
    const colors = new Set(Array.from({ length: 1000 }, (_, index) => scaleStyle(index, kind === 'unique').backgroundColor))
    assert.equal(colors.size, kind === 'reuse' ? 1 : 1000)
  }
})

test('Tailwind production generation ignores benchmark node and action identities', async t => {
  const { createWeappTailwindcssGenerator, resolveTailwindV4Source } = await import('weapp-tailwindcss/generator')
  const generate = async (css, content) => {
    const source = await resolveTailwindV4Source({ base: process.cwd(), projectRoot: process.cwd(), css })
    const generator = createWeappTailwindcssGenerator(source)
    try { return await generator.generate({ target: 'weapp', sources: typeof content === 'string' ? [{ content, extension: 'wxml' }] : content, scanSources: false, incrementalCache: false }) }
    finally { await generator.dispose?.() }
  }
  const outputs = []
  let css, largeTemplate
  for (const count of [10, 1000]) {
    const { read } = await fixture(t, { scheme: 'tailwind', scenario: `reuse-${count}` })
    css = (await read('src/tailwind.css')).replace(/^@source .*\n/gm, '')
    const template = await read('src/pages/scale/index.wxml')
    const output = await generate(css, template)
    assert.ok(![...output.classSet].some(candidate => /^scale-\d+$/.test(candidate)))
    assert.ok(!/\.scale-\d+\s*\{/.test(output.css))
    outputs.push(output)
    largeTemplate = template
  }
  assert.equal(outputs[1].css, outputs[0].css)
  assert.deepEqual([...outputs[1].classSet].sort(), [...outputs[0].classSet].sort())
  const misleading = await generate(css, largeTemplate.replaceAll('bench-node-', 'scale-'))
  assert.ok(misleading.classSet.has('scale-0'))
  assert.ok(misleading.css.length > outputs[1].css.length * 2)
  const gallery = await fixture(t, { scheme: 'tailwind', scenario: 'gallery' })
  const template = await gallery.read('src/pages/gallery/index.wxml')
  const script = await gallery.read('src/pages/gallery/index.ts')
  css = (await gallery.read('src/tailwind.css')).replace(/^@source .*\n/gm, '')
  const sourceGraph = [{ content: template, extension: 'wxml' }, { content: script, extension: 'ts' }]
  const galleryOutput = await generate(css, sourceGraph)
  assert.ok(!galleryOutput.classSet.has('grow'))
  assert.ok(!/\.grow\s*\{/.test(galleryOutput.css))
  const misleadingAction = await generate(css, [{ ...sourceGraph[0], content: template.replaceAll('bench-action-grow', 'grow') }, sourceGraph[1]])
  assert.ok(misleadingAction.classSet.has('grow'))
})

test('static scale pages carry only their needed class bindings', async t => {
  for (const scheme of SCHEMES) {
    const { read } = await fixture(t, { scheme, scenario: 'reuse-10' })
    const script = await read('src/pages/scale/index.ts')
    assert.ok(!script.includes('onToggle'))
    assert.ok(!script.includes('onGrow'))
    assert.ok(!script.includes('navigateTo'))
    assert.ok(!script.includes('dynamicStyle'))
    assert.ok(!script.includes('active:'))
    assert.ok(!script.includes('dark:'))
    assert.ok(!script.includes('width:'))
    if (scheme === 'panda' || scheme === 'stylex') assert.ok(script.includes('classes:getStyles()'))
    else assert.ok(!script.includes('data:'))
  }
})

test('generated page handlers preserve other state and keep dynamic values synchronized', async t => {
  for (const scheme of SCHEMES) {
    const { read } = await fixture(t, { scheme })
    const source = stripTypeScriptTypes((await read('src/pages/gallery/index.ts')).replace(/^import .*\n/gm, ''), { mode: 'strip' })
    let page
    runInNewContext(source, { Page: value => { page = value }, getStyles: (active = false, dark = false, width = 120) => ({ active, dark, width }) })
    page.setData = next => Object.assign(page.data, next)
    for (const action of ['onToggleVariant', 'onToggleTheme', 'onGrow']) page[action]()
    assert.equal(page.data.active, true)
    assert.equal(page.data.dark, true)
    assert.equal(page.data.width, 200)
    if (scheme === 'stylex') {
      assert.equal(page.data.dynamicStyle, undefined)
      assert.deepEqual(page.data.classes, { active: true, dark: true, width: 200 })
    }
    else if (scheme !== 'unstyled') assert.equal(page.data.dynamicStyle, '--bench-width:200px;--bench-space:20px;--bench-tone:#be123c')
    page.onGrow()
    assert.equal(page.data.width, 120)
    assert.equal(page.data.active, true)
    assert.equal(page.data.dark, true)
  }
})

test('all generated TypeScript inputs parse, including framework-specific style expressions', async t => {
  for (const scheme of SCHEMES) {
    const { directory } = await fixture(t, { scheme, scenario: 'application' })
    const paths = await files(path.join(directory, 'src'))
    for (const file of paths.filter(value => value.endsWith('.ts'))) {
      const source = await readFile(file, 'utf8')
      assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: 'strip' }), file)
    }
  }
})

test('profiles and targets preserve the visual contract while remaining explicit metadata', async t => {
  const baseline = await fixture(t)
  const optimized = await fixture(t, { profile: 'optimized', target: 'web' })
  assert.equal(optimized.contract.profile, 'optimized')
  assert.equal(optimized.contract.target, 'web')
  assert.deepEqual(optimized.contract.routes, baseline.contract.routes)
  const unstyled = await fixture(t, { scheme: 'unstyled' })
  assert.equal(await unstyled.read('src/app.css'), '')
  assert.ok(!(await unstyled.read('src/pages/gallery/index.wxml')).includes(' class='))
})

test('unstyled contracts preserve nodes and interactions without visual expectations in either profile', async t => {
  const identity = ({ id, component }) => ({ id, ...(component ? { component } : {}) })
  for (const profile of ['standard', 'optimized']) for (const scenario of ['gallery', 'application']) {
    const { contract } = await fixture(t, { scheme: 'unstyled', profile, scenario })
    const { contract: reference } = await fixture(t, { scheme: 'reference', profile, scenario })
    assert.equal(contract.styled, false)
    for (const [index, route] of contract.routes.entries()) {
      const styled = reference.routes[index]
      assert.equal(route.path, styled.path)
      assert.equal(route.rootId, styled.rootId)
      assert.deepEqual(route.elements.map(identity), styled.elements.map(identity))
      assert.deepEqual(route.navigation, styled.navigation)
      assert.deepEqual(route.actions.map(({ checks, ...action }) => action), styled.actions.map(({ checks, ...action }) => action))
      for (const [actionIndex, action] of route.actions.entries()) assert.deepEqual(action.checks.map(identity), styled.actions[actionIndex].checks.map(identity))
      for (const element of [...route.elements, ...route.actions.flatMap(action => action.checks)]) assert.deepEqual(element, { ...identity(element), styles: {} })
    }
  }
})
