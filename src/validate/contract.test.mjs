import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { assertEquivalent, assertSnapshot, assertStyleEqual, bounded, expectedStyles, loadFixture, poll } from './contract.mjs'
import { assertCalibrationEnvironment, assertIdeNavigationReady, calibrateRpxProbe, calibratedIdeProperties, closeOwnedIde, ideProperties, readIdeStyles } from './ide.mjs'
import { closeWebBrowser } from './web.mjs'

const row = { scheme: 'tailwind', profile: 'standard', scenario: 'gallery', target: 'web' }
const fixture = { version: 1, ...row, routes: [{ path: '/pages/gallery/index', rootId: 'root', elements: [{ id: 'root', styles: { width: '120px', color: 'rgb(0, 0, 0)' }, wideStyles: { width: '240px' } }], actions: [{ id: 'grow', state: 'grown', checks: [{ id: 'root', styles: { width: '200px' } }] }] }] }
const snapshot = { root: { styles: { width: '120px', color: 'rgb(0,0,0)' }, box: { x: 0, y: 0, width: 120, height: 30 } } }

test('a style mismatch cannot pass the equivalence gate', () => {
  assertSnapshot(snapshot, fixture.routes[0].elements)
  const altered = structuredClone(snapshot)
  altered.root.styles.color = 'rgb(1,0,0)'
  assert.throws(() => assertSnapshot(altered, fixture.routes[0].elements), /color/)
  assert.throws(() => assertEquivalent(altered, snapshot), /reference mismatch/)
})

test('missing nodes and geometry changes fail, subpixel rounding is bounded', () => {
  assert.throws(() => assertSnapshot({}, fixture.routes[0].elements), /missing #root/)
  assert.throws(() => assertEquivalent({}, snapshot), /element sets differ/)
  const altered = structuredClone(snapshot)
  altered.root.box.width += 0.5
  assertEquivalent(altered, snapshot)
  altered.root.box.width += 1
  assert.throws(() => assertEquivalent(altered, snapshot), /geometry mismatch/)
})

test('wide expectations override only declared responsive properties', () => {
  assert.deepEqual(expectedStyles(fixture.routes[0].elements[0], 768), { width: '240px', color: 'rgb(0, 0, 0)' })
  assert.equal(expectedStyles(fixture.routes[0].elements[0], 375).width, '120px')
})

test('rpx uses the real host width while responsive rules use the viewport', () => {
  const element = { styles: { width: '100px' }, wideStyles: { backgroundColor: 'green' }, rpx: { width: 200 } }
  assert.deepEqual(expectedStyles(element, 768, 375), { width: '100px', backgroundColor: 'green' })
  assert.equal(expectedStyles(element, 393).width, '104.8px')
})

test('a stalled native protocol check has a bounded deadline', async () => {
  await assert.rejects(poll(() => new Promise(() => {}), 'stalled protocol', 5), /timed out/)
})

test('bounded protocol timeouts have a distinct name and code', async () => {
  await assert.rejects(bounded(() => new Promise(() => {}), 'stalled protocol', 5), error => error.name === 'TimeoutError' && error.code === 'ERR_BENCHMARK_TIMEOUT')
})

test('poll retains the actual style assertion when a later RPC hits its remaining deadline', async () => {
  let attempts = 0
  await assert.rejects(poll(() => {
    if (++attempts === 1) assert.equal('100px', '200px', '#rpx-probe width mismatch')
    return new Promise(() => {})
  }, 'native rpx probe', 250), error => error.message.includes('#rpx-probe width mismatch') && error.cause?.code === 'ERR_ASSERTION')
  assert.equal(attempts, 2)
})

test('fixture contract rejects wrong provenance, absent routes, and unknown action probes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'style-contract-'))
  const save = value => writeFile(path.join(directory, 'fixture.json'), JSON.stringify(value))
  try {
    await save(fixture)
    assert.deepEqual(await loadFixture({ ...row, fixtureDirectory: directory }), fixture)
    await assert.rejects(loadFixture({ ...row, scheme: 'panda', fixtureDirectory: directory }), /scheme mismatch/)
    await save({ ...fixture, routes: [] })
    await assert.rejects(loadFixture({ ...row, fixtureDirectory: directory }), /no routes/)
    const badAction = structuredClone(fixture)
    badAction.routes[0].actions[0].checks[0].id = 'absent'
    await save(badAction)
    await assert.rejects(loadFixture({ ...row, fixtureDirectory: directory }), /unknown element/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('IDE expands border radius to the computed corners exposed by native DevTools', () => {
  assert.deepEqual(ideProperties({ borderRadius: '12px', backgroundColor: 'red' }), {
    'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-left-radius': '12px', 'border-bottom-right-radius': '12px', 'background-color': 'red',
  })
})

test('IDE reads and maps all requested style properties in one public protocol call', async () => {
  const calls = []
  const names = Object.keys(ideProperties({ borderRadius: '12px', backgroundColor: 'red' }))
  const element = { send: async (method, parameters) => {
    calls.push({ method, parameters })
    return { styles: ['12px', '12px', '12px', '12px', 'rgb(255, 0, 0)'] }
  } }
  assert.deepEqual(await readIdeStyles(element, names), {
    'border-top-left-radius': '12px', 'border-top-right-radius': '12px', 'border-bottom-left-radius': '12px', 'border-bottom-right-radius': '12px', 'background-color': 'rgb(255, 0, 0)',
  })
  assert.deepEqual(calls, [{ method: 'Element.getStyles', parameters: { names } }])
  assert.deepEqual(await readIdeStyles(element, []), {})
  assert.equal(calls.length, 1)
})

test('IDE batch styles reject incomplete protocol responses', async () => {
  await assert.rejects(readIdeStyles({ send: async () => ({ styles: ['red'] }) }, ['color', 'width']), /returned 1 values for 2 properties/)
})

test('native rpx calibration records bounded host rounding from the handwritten reference', () => {
  const expected = { id: 'rpx-probe', styles: { backgroundColor: 'red' }, rpx: { width: 200, height: 40, borderRadius: 8 } }
  const native = { width: '104px', height: '20px', ...ideProperties({ borderRadius: '4px' }) }
  const probe = calibrateRpxProbe(expected, 390, native)
  assert.equal(probe.theoretical.height, '20.8px')
  assert.deepEqual(probe.actual, native)
  const properties = calibratedIdeProperties(expected, 390, { probes: { 'rpx-probe': probe } })
  assert.equal(properties.height, '20px')
  assert.equal(properties['background-color'], 'red')
  assertStyleEqual('20px', properties.height, 'matching native scheme', 0.1)
  assert.throws(() => assertStyleEqual('20.8px', properties.height, 'different native scheme', 0.1), /different native scheme/)
  assert.throws(() => calibrateRpxProbe(expected, 390, { ...native, width: '103px' }), /at least 1px/)
})

test('native rpx expectations require the same reference specification', () => {
  const expected = { id: 'rpx-probe', styles: {}, rpx: { width: 200 } }
  assert.throws(() => calibratedIdeProperties(expected, 390), /Missing handwritten native rpx calibration/)
  assert.throws(() => calibratedIdeProperties(expected, 390, { probes: { 'rpx-probe': { rpx: { width: 100 }, actual: { width: '52px' } } } }), /specification differs/)
})

test('native rpx calibration is tied to the actual device width and SDK', () => {
  const systemInfo = { windowWidth: 390, model: 'iPhone 12/13', pixelRatio: 3, platform: 'devtools' }
  const toolInfo = { SDKVersion: '3.17.5' }
  const calibration = { device: { ...systemInfo, SDKVersion: toolInfo.SDKVersion } }
  assertCalibrationEnvironment(calibration, systemInfo, toolInfo)
  assert.throws(() => assertCalibrationEnvironment(calibration, { ...systemInfo, windowWidth: 375 }, toolInfo), /window width differs/)
  assert.throws(() => assertCalibrationEnvironment(calibration, systemInfo, { SDKVersion: '3.17.4' }), /SDK differs/)
  assert.throws(() => assertCalibrationEnvironment(calibration, { ...systemInfo, model: 'another model' }, toolInfo), /model differs/)
})

test('native navigation does not pass when the route changes before its rendered root is ready', async () => {
  let ready = false
  const queried = []
  const mini = { currentPage: async () => ({ path: 'pages/list/index', $$: async selector => { queried.push(selector); return ready ? [{}] : [] } }) }
  const navigation = { path: '/pages/list/index' }
  const routes = [{ path: '/pages/list/index', rootId: 'bench-root' }]
  await assert.rejects(assertIdeNavigationReady(mini, navigation, routes), /Expected one native #bench-root, received 0/)
  ready = true
  await assertIdeNavigationReady(mini, navigation, routes)
  assert.deepEqual(queried, ['[id="bench-root"]', '[id="bench-root"]'])
  await assert.rejects(assertIdeNavigationReady(mini, { path: '/unknown/index' }, routes), /destination has no fixture root/)
})

test('IDE cleanup is idempotent and targets only its owned project', async () => {
  const calls = []
  const owned = { mini: { disconnect() { calls.push(['disconnect']) } }, cliPath: '/selected/cli', projectPath: '/owned/project', port: 12345, resource: { closed: false } }
  const operations = { runCli: async (cli, args) => calls.push([cli, args]), isClosed: async port => port === 12345 }
  await closeOwnedIde(owned, operations)
  await closeOwnedIde(owned, operations)
  assert.equal(owned.resource.closed, true)
  assert.deepEqual(calls, [['disconnect'], ['/selected/cli', ['close', '--project', '/owned/project']]])
})

test('IDE cleanup errors are reported without escalating to a global shutdown', async () => {
  const calls = []
  const owned = { cliPath: '/selected/cli', projectPath: '/owned/project', port: 12345, resource: { closed: false } }
  await assert.rejects(closeOwnedIde(owned, { runCli: async (_, args) => { calls.push(args); throw new Error('close rejected') }, isClosed: async () => true }), /Failed closing owned/)
  assert.equal(owned.resource.closed, false)
  assert.deepEqual(calls, [['close', '--project', '/owned/project']])
})

test('browser cleanup still closes its process if context cleanup fails', async () => {
  const calls = []
  const resource = { closed: false }
  await assert.rejects(closeWebBrowser({
    context: { close: async () => { calls.push('context'); throw new Error('context rejected') } },
    browser: { close: async () => calls.push('browser') }, resource,
  }), /H5 browser cleanup failed/)
  assert.deepEqual(calls, ['context', 'browser'])
  assert.equal(resource.closed, true)
})
