import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LAYOUT_TOKENS, PROFILES, SCENARIOS, SCHEMES, SHARED_RESET, STYLE_SPEC, TARGETS, TOKENS, rgb, scaleStyle } from './spec.mjs'
import { classFor, renderNodes } from './render.mjs'
import { referenceCss, styleModule, themeCss } from './styles.mjs'

const node = (id, styles, text, children = [], extra = {}) => ({ id, styles: Array.isArray(styles) ? styles : [styles], text, children, tag: 'view', ...extra })
const control = (id, text, action) => node(id, 'control', text, [], { action })
const text = (id, styles, content) => node(id, styles, content, [], { tag: 'text' })

function gallery() {
  return [
    text('title', 'title', 'One scene, three styling systems'),
    text('subtitle', 'subtitle', 'Tokens · variants · slots · dynamic values · responsive rules'),
    node('controls', 'row', '', [control('toggle-variant', 'Toggle variants', 'onToggleVariant'), control('toggle-theme', 'Toggle theme', 'onToggleTheme'), control('bench-action-grow', 'Grow dynamic value', 'onGrow')]),
    node('token-probe', 'tokenProbe', 'Shared spacing, radius and color tokens'),
    node('variant-probe', 'variant', 'Compound variant'),
    node('slot-root', 'slotRoot', '', [text('slot-label', 'slotLabel', 'Slot recipe label')]),
    text('condition-probe', 'condition', 'Conditional opacity'),
    node('dynamic-probe', 'dynamic', 'Dynamic'),
    node('media-probe', 'mediaProbe', '640px breakpoint'),
    node('rpx-probe', 'rpxProbe', ''),
    node('decorative-probe', 'decorativeProbe', ''),
    text('state-status', 'subtitle', '{{active ? "active" : "neutral"}} · {{dark ? "dark" : "light"}} · {{width}}'),
  ]
}

function pageNodes(role) {
  if (role === 'home') return [
    text('title', 'title', 'Workspace overview'), text('subtitle', 'subtitle', 'A native app with shared components and package boundaries'),
    node('home-actions', 'row', '', [control('open-list', 'View projects', 'onOpenList'), control('open-detail', 'Open detail package', 'onOpenDetail'), control('open-settings', 'Independent settings', 'onOpenSettings'), control('toggle-theme', 'Toggle theme', 'onToggleTheme')]),
    { id: 'home-metric', component: 'bench-metric', label: 'Monthly activity', value: '2,480', children: [], styles: [] },
    node('home-panel', ['panel', 'stack'], '', [text('home-panel-title', 'metricValue', '12 active projects'), text('home-panel-description', 'subtitle', 'Shared tokens and page-level CSS variables')]),
  ]
  if (role === 'list') return [
    text('title', 'title', 'Projects'), text('subtitle', 'subtitle', 'Explicit list content with reusable atomic declarations'),
    ...Array.from({ length: 12 }, (_, index) => node(`project-${index}`, 'listItem', '', [text(`project-label-${index}`, 'subtitle', `Project ${String(index + 1).padStart(2, '0')}`), text(`project-badge-${index}`, 'badge', index % 2 ? 'In progress' : 'Ready')])),
    control('open-detail', 'Open first project', 'onOpenDetail'),
  ]
  if (role === 'detail') return [
    text('title', 'title', 'Project detail'), text('subtitle', 'subtitle', 'Ordinary subpackage consuming the shared metric component'),
    { id: 'detail-metric', component: 'bench-metric', label: 'Completed work', value: '86%', children: [], styles: [] },
    node('detail-panel', ['panel', 'stack'], '', [text('detail-label', 'metricValue', 'Release readiness'), node('variant-probe', 'variant', 'Mark as ready'), control('toggle-variant', 'Toggle project status', 'onToggleVariant')]),
  ]
  return [
    text('title', 'title', 'Independent settings'), text('subtitle', 'subtitle', 'This package owns its styles, scripts and component resources'),
    { id: 'settings-metric', component: 'bench-metric', label: 'Local preferences', value: '3', children: [], styles: [] },
    node('settings-panel', ['panel', 'stack'], '', [control('toggle-theme', 'Toggle theme', 'onToggleTheme'), control('bench-action-grow', 'Adjust dynamic value', 'onGrow'), node('dynamic-probe', 'dynamic', 'Dynamic')]),
  ]
}

function collectKeys(nodes, set = new Set()) {
  for (const item of nodes) {
    for (const key of item.styles) set.add(key)
    collectKeys(item.children, set)
  }
  return set
}

function collectActions(nodes, set = new Set()) {
  for (const item of nodes) {
    if (item.action) set.add(item.action)
    collectActions(item.children, set)
  }
  return set
}

function pageScript(scheme, nodes) {
  const styleImport = scheme === 'panda' || scheme === 'stylex' ? "import {getStyles} from './index.styles'\n" : ''
  const actions = collectActions(nodes)
  const states = [['onToggleVariant', 'active', 'false'], ['onToggleTheme', 'dark', 'false'], ['onGrow', 'width', '120']]
  const data = states.filter(([action]) => actions.has(action)).map(([, name, value]) => `${name}:${value}`)
  const dynamicStyle = scheme !== 'unstyled' && scheme !== 'stylex' && actions.has('onGrow')
  if (dynamicStyle) data.push("dynamicStyle:'--bench-width:120px;--bench-space:8px;--bench-tone:#0f766e'")
  if (styleImport) data.push('classes:getStyles()')
  const stateValue = name => actions.has(states.find(([, state]) => state === name)[0]) ? `this.data.${name}` : name === 'width' ? '120' : 'false'
  const stylexClasses = changed => `,classes:getStyles(${['active', 'dark', 'width'].map(name => name === changed ? name : stateValue(name)).join(',')})`
  const methods = []
  if (actions.has('onToggleVariant')) methods.push(`onToggleVariant(){const active=!this.data.active;this.setData({active${scheme === 'panda' ? ',classes:getStyles(active)' : scheme === 'stylex' ? stylexClasses('active') : ''}})}`)
  if (actions.has('onToggleTheme')) methods.push(`onToggleTheme(){const dark=!this.data.dark;this.setData({dark${scheme === 'stylex' ? stylexClasses('dark') : ''}})}`)
  if (actions.has('onGrow')) methods.push(`onGrow(){const width=this.data.width===120?200:120;this.setData({width${dynamicStyle ? ",dynamicStyle:'--bench-width:'+width+'px;--bench-space:'+(width===120?8:20)+'px;--bench-tone:'+(width===120?'#0f766e':'#be123c')" : ''}${scheme === 'stylex' ? stylexClasses('width') : ''}})}`)
  for (const [action, url] of [['onOpenList', '/pages/list/index'], ['onOpenDetail', '/package/detail/index'], ['onOpenSettings', '/independent/settings/index']]) if (actions.has(action)) methods.push(`${action}(){wx.navigateTo({url:'${url}'})}`)
  return `${styleImport}Page({\n${data.length ? ` data:{${data.join(',')}},\n` : ''}${methods.map(method => ` ${method},\n`).join('')}})\n`
}

function initialElements(nodes, styles) {
  const flat = []
  const visit = values => { for (const item of values) { if (!item.component) flat.push(item); visit(item.children) } }
  visit(nodes)
  const ids = new Set(flat.map(item => item.id))
  const elements = [{ id: 'bench-root', styles: { backgroundColor: rgb(TOKENS.light.surface), color: rgb(TOKENS.light.text), paddingTop: '24px' } }]
  const add = (id, expected, wideStyles, metadata = {}) => { if (ids.has(id)) elements.push({ id, styles: expected, ...metadata, ...(wideStyles ? { wideStyles } : {}) }) }
  add('title', { fontSize: '28px', fontWeight: '700', lineHeight: '36px' })
  add('token-probe', { paddingTop: '16px', borderRadius: '12px', backgroundColor: rgb(TOKENS.light.accent) })
  add('variant-probe', { width: '160px', height: '56px', backgroundColor: rgb('#e2e8f0'), color: rgb('#334155'), fontWeight: '400', display: 'flex' })
  add('slot-root', { backgroundColor: rgb('#f1f5f9'), paddingTop: '12px' })
  add('slot-label', { color: rgb('#475569'), fontWeight: '400' })
  add('condition-probe', { opacity: '1', color: rgb('#7c3aed') })
  add('dynamic-probe', { width: '120px', height: '20px', paddingLeft: '8px', color: rgb('#0f766e') })
  add('media-probe', { width: '120px', height: '32px', backgroundColor: rgb('#dbeafe') }, { width: '240px', backgroundColor: rgb('#dcfce7') })
  add('rpx-probe', { width: '100px', height: '20px' }, { width: '204.8px', height: '40.96px' }, { rpx: { width: 200, height: 40, borderRadius: 8 } })
  add('decorative-probe', { width: '160px', height: '48px', backgroundImage: 'linear-gradient(135deg, rgb(219, 234, 254) 0%, rgb(224, 231, 255) 100%)', boxShadow: 'rgba(15, 23, 42, 0.12) 0px 4px 12px 0px' })
  for (const item of nodes.filter(value => value.component)) {
    elements.push({ id: 'metric-root', component: item.id, styles: { backgroundColor: rgb(TOKENS.light.panel), paddingTop: '16px' } })
    elements.push({ id: 'metric-label', component: item.id, styles: { color: rgb(TOKENS.light.muted), fontSize: '14px' } })
    elements.push({ id: 'metric-value', component: item.id, styles: { color: rgb(TOKENS.light.accent), fontSize: '24px', fontWeight: '700' } })
  }
  for (const item of flat.filter(value => value.id.startsWith('bench-node-'))) {
    const style = styles[item.styles[0]]
    elements.push({ id: item.id, styles: { width: style.width, height: style.height, backgroundColor: rgb(style.backgroundColor), paddingLeft: style.paddingLeft } })
  }
  return elements
}

function routeActions(nodes) {
  const ids = new Set()
  const visit = values => { for (const item of values) { ids.add(item.id); visit(item.children) } }
  visit(nodes)
  const actions = []
  if (ids.has('toggle-variant')) actions.push({ id: 'toggle-variant', state: 'active', data: { active: true }, checks: [
    ...(ids.has('variant-probe') ? [{ id: 'variant-probe', styles: { backgroundColor: rgb('#2563eb'), color: rgb('#ffffff'), fontWeight: '700' } }] : []),
    ...(ids.has('slot-root') ? [{ id: 'slot-root', styles: { backgroundColor: rgb('#dbeafe') } }, { id: 'slot-label', styles: { color: rgb('#2563eb'), fontWeight: '700' } }] : []),
    ...(ids.has('condition-probe') ? [{ id: 'condition-probe', styles: { opacity: '0.5' } }] : []),
  ] })
  if (ids.has('toggle-theme')) actions.push({ id: 'toggle-theme', state: 'dark', data: { dark: true }, checks: [{ id: 'bench-root', styles: { backgroundColor: rgb(TOKENS.dark.surface), color: rgb(TOKENS.dark.text) } }, ...(ids.has('token-probe') ? [{ id: 'token-probe', styles: { backgroundColor: rgb(TOKENS.dark.accent) } }] : []), ...nodes.filter(value => value.component).flatMap(item => [{ id: 'metric-root', component: item.id, styles: { backgroundColor: rgb(TOKENS.dark.panel) } }, { id: 'metric-label', component: item.id, styles: { color: rgb(TOKENS.dark.muted) } }, { id: 'metric-value', component: item.id, styles: { color: rgb(TOKENS.dark.accent) } }])] })
  if (ids.has('bench-action-grow')) actions.push({ id: 'bench-action-grow', state: 'grown', data: { width: 200 }, checks: [{ id: 'dynamic-probe', styles: { width: '200px', height: '20px', paddingLeft: '20px', color: rgb('#be123c') } }] })
  return actions
}

// The baseline retains node identity and behavior, without any visual assertions.
const unstyledElement = ({ id, component }) => ({ id, ...(component ? { component } : {}), styles: {} })

/** Generate source inputs only; framework configuration belongs to the runner. */
export async function generateFixture({ directory, scheme, scenario, profile = 'standard', target = 'weapp' }) {
  for (const [name, value, allowed] of [['scheme', scheme, SCHEMES], ['scenario', scenario, SCENARIOS], ['profile', profile, PROFILES], ['target', target, TARGETS]]) if (!allowed.includes(value)) throw new Error(`Unknown ${name}: ${value}`)
  directory = path.resolve(directory)
  const save = async (file, content) => { const full = path.join(directory, file); await mkdir(path.dirname(full), { recursive: true }); await writeFile(full, content); return full }
  const styled = scheme !== 'unstyled'
  const styles = { ...STYLE_SPEC }
  const pages = []
  if (scenario === 'application') {
    for (const [route, role] of [['pages/home/index', 'home'], ['pages/list/index', 'list'], ['package/detail/index', 'detail'], ['independent/settings/index', 'settings']]) pages.push({ route, role, nodes: pageNodes(role), independent: role === 'settings' })
  }
  else if (scenario === 'gallery') pages.push({ route: 'pages/gallery/index', role: 'gallery', nodes: gallery() })
  else {
    const [kind, rawCount] = scenario.split('-')
    const count = Number(rawCount)
    const nodes = [text('title', 'title', `${kind === 'reuse' ? 'Reused' : 'Unique'} styles · ${count} nodes`)]
    for (let index = 0; index < count; index++) { const key = kind === 'reuse' ? 'scaleRepeated' : `scale${index}`; styles[key] = scaleStyle(index, kind === 'unique'); nodes.push(node(`bench-node-${index}`, key, `Node ${index + 1}`)) }
    pages.push({ route: 'pages/scale/index', role: 'scale', nodes })
  }
  const appConfig = { pages: pages.filter(page => page.route.startsWith('pages/')).map(page => page.route), window: { navigationBarTitleText: 'Style size benchmark', navigationStyle: 'custom' }, ...(scenario === 'application' ? { subPackages: [{ root: 'package', pages: ['detail/index'] }, { root: 'independent', pages: ['settings/index'], independent: true }] } : {}) }
  await save('src/app.json', JSON.stringify(appConfig, null, 2) + '\n')
  const frameworkStyle = scheme === 'tailwind' ? 'tailwind' : scheme === 'panda' ? 'panda' : undefined
  await save('src/app.ts', `${styled ? "import './app.css'\n" : ''}App({})\n`)
  await save('src/app.css', styled ? (frameworkStyle ? `@import './${frameworkStyle}.css';\n` : '') + SHARED_RESET + (scheme === 'stylex' ? '' : themeCss) : '')
  if (scheme === 'tailwind') await save('src/tailwind.css', `@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities) source(none);\n@source './pages/**/*.{ts,wxml}';\n@source './components/**/*.{ts,wxml}';\n@source './package/**/*.{ts,wxml}';\n@theme { --spacing-bench-space:16px; --radius-bench-radius:12px; }\n`)
  if (scheme === 'panda') await save('src/panda.css', '@layer reset, base, tokens, recipes, utilities;\n')
  if (scheme === 'stylex') {
    const vars = { ...TOKENS.light, ...LAYOUT_TOKENS }
    const tokenSource = `import * as stylex from 'weapp-stylex'\nexport const tokens=stylex.defineVars(${JSON.stringify(vars)})\nexport const lightTheme=stylex.createTheme(tokens,${JSON.stringify(vars)})\nexport const darkTheme=stylex.createTheme(tokens,${JSON.stringify({ ...TOKENS.dark, ...LAYOUT_TOKENS })})\n`
    await save('src/styles/tokens.stylex.ts', tokenSource)
    if (scenario === 'application') await save('src/independent/styles/tokens.stylex.ts', tokenSource)
  }
  const contract = { version: 1, scheme, scenario, profile, target, styled, routes: [] }
  for (const page of pages) {
    const nodes = page.nodes
    const keys = collectKeys(nodes, new Set(['shell', 'stack']))
    const className = ['shell', 'stack'].map(key => classFor(key, scheme, styles)).filter(Boolean).join(' ')
    const theme = styled && scheme !== 'stylex' ? collectActions(nodes).has('onToggleTheme') ? ` {{dark ? 'theme-dark' : 'theme-light'}}` : ' theme-light' : ''
    await save(`src/${page.route}.wxml`, `<view id="bench-root" data-testid="bench-root"${className || theme ? ` class="${className}${theme}"` : ''}>\n${renderNodes(nodes, scheme, styles)}\n</view>\n`)
    await save(`src/${page.route}.ts`, pageScript(scheme, nodes))
    const usesComponent = nodes.some(item => item.component)
    await save(`src/${page.route}.json`, JSON.stringify({ ...(usesComponent ? { usingComponents: { 'bench-metric': page.independent ? '../components/metric/index' : '/components/metric/index' } } : {}) }) + '\n')
    let localCss = scheme === 'reference' ? referenceCss(styles, keys) : ''
    if (page.independent && styled) localCss = (frameworkStyle ? `@import '../${frameworkStyle}.css';\n` : '') + SHARED_RESET + (scheme === 'stylex' ? '' : themeCss) + localCss
    if (localCss) await save(`src/${page.route}.${page.independent && frameworkStyle ? 'css' : 'wxss'}`, localCss)
    if (scheme === 'panda' || scheme === 'stylex') {
      const file = path.join(directory, `src/${page.route}.styles.ts`)
      await save(`src/${page.route}.styles.ts`, styleModule({ scheme, styles, keys, file, directory, independent: page.independent }))
    }
    const navigation = nodes.filter(item => item.action && ['onOpenList', 'onOpenDetail', 'onOpenSettings'].includes(item.action)).map(item => ({ id: item.id, method: 'navigateTo', path: { onOpenList: '/pages/list/index', onOpenDetail: '/package/detail/index', onOpenSettings: '/independent/settings/index' }[item.action] }))
    const navigationChildren = nodes.flatMap(item => item.children).filter(item => item.action && ['onOpenList', 'onOpenDetail', 'onOpenSettings'].includes(item.action)).map(item => ({ id: item.id, method: 'navigateTo', path: { onOpenList: '/pages/list/index', onOpenDetail: '/package/detail/index', onOpenSettings: '/independent/settings/index' }[item.action] }))
    contract.routes.push({ path: `/${page.route}`, rootId: 'bench-root', elements: initialElements(nodes, styles).map(element => styled ? element : unstyledElement(element)), actions: routeActions(nodes).map(action => styled ? action : { ...action, checks: action.checks.map(unstyledElement) }), ...(navigation.length || navigationChildren.length ? { navigation: [...navigation, ...navigationChildren] } : {}) })
  }
  if (scenario === 'application') {
    if (scheme === 'tailwind') await save('src/independent/tailwind.css', `@import 'tailwindcss/theme.css' layer(theme);\n@import 'tailwindcss/utilities.css' layer(utilities) source(none);\n@source './**/*.{ts,wxml}';\n@theme { --spacing-bench-space:16px; --radius-bench-radius:12px; }\n`)
    if (scheme === 'panda') await save('src/independent/panda.css', '@layer reset, base, tokens, recipes, utilities;\n')
    for (const independent of [false, true]) {
      const componentRoute = independent ? 'independent/components/metric/index' : 'components/metric/index'
      const nodes = [text('metric-label', 'subtitle', '{{label}}'), text('metric-value', 'metricValue', '{{value}}')]
      const keys = collectKeys(nodes, new Set(['panel']))
      await save(`src/${componentRoute}.wxml`, `<view id="metric-root" data-testid="metric-root"${styled ? ` class="${classFor('panel', scheme, styles)}"` : ''}>\n${renderNodes(nodes, scheme, styles)}\n</view>\n`)
      await save(`src/${componentRoute}.json`, '{"component":true}\n')
      await save(`src/${componentRoute}.ts`, `${scheme === 'panda' || scheme === 'stylex' ? "import {getStyles} from './index.styles'\n" : ''}Component({options:{styleIsolation:'apply-shared'},properties:{label:String,value:String},data:{${scheme === 'panda' || scheme === 'stylex' ? 'classes:getStyles()' : ''}}})\n`)
      if (scheme === 'reference') await save(`src/${componentRoute}.wxss`, referenceCss(styles, keys))
      if (scheme === 'panda' || scheme === 'stylex') await save(`src/${componentRoute}.styles.ts`, styleModule({ scheme, styles, keys, file: path.join(directory, `src/${componentRoute}.styles.ts`), directory, independent }))
    }
  }
  await save('fixture.json', JSON.stringify(contract, null, 2) + '\n')
  return contract
}
