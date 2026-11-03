import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import automator from 'miniprogram-automator'
import { assertStyleEqual, bounded, expectedStyles, loadFixture, poll, rowKey, saveEvidence } from './contract.mjs'

const run = promisify(execFile)
const OFFICIAL_VERSIONS = 'https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json'
const DOWNLOAD_PAGE = 'https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html'

export async function preflightIde({ cliPath, appid }) {
  assert.ok(cliPath && path.isAbsolute(cliPath), 'Set an explicit absolute DevTools CLI path')
  assert.match(appid ?? '', /^wx[0-9a-f]{16}$/i, 'IDE acceptance requires a real AppID')
  assert.notEqual(process.platform, 'win32', 'This local IDE harness uses the native macOS/Linux CLI; Windows requires a separately verified launcher')
  const response = await fetch(OFFICIAL_VERSIONS, { signal: AbortSignal.timeout(25000) })
  assert.ok(response.ok, `Official DevTools channel lookup failed: HTTP ${response.status}`)
  const channels = await response.json()
  const latestStable = channels.channels?.find(channel => channel.id === 'stable')?.version
  assert.ok(latestStable, 'Official stable channel version could not be confirmed')
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(cliPath), '../Resources/app.asar.unpacked/package.json'), 'utf8'))
  assert.equal(manifest.version, latestStable, 'Selected installation is not the verified current stable release')
  const login = await run(cliPath, ['islogin'], { timeout: 20000, maxBuffer: 1024 * 1024 })
  assert.match(`${login.stdout}\n${login.stderr}`, /["']?login["']?\s*:\s*true/, 'Selected DevTools installation is not logged in or its service port is unavailable')
  return { checkedAt: new Date().toISOString(), source: OFFICIAL_VERSIONS, downloadPage: DOWNLOAD_PAGE, latestStable, installedVersion: manifest.version, login: true, cliPath, appid, channels }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function endpointClosed(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(false))
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'))
    socket.setTimeout(1000, () => finish(false))
  })
}

export async function closeOwnedIde({ mini, cliPath, projectPath, port, resource }, { runCli = run, isClosed = endpointClosed } = {}) {
  if (resource.closed) return
  const errors = []
  try { await mini?.disconnect() } catch (error) { errors.push(error) }
  try { await runCli(cliPath, ['close', '--project', projectPath], { timeout: 20000 }) } catch (error) { errors.push(error) }
  try { await poll(async () => assert.ok(await isClosed(port), `Owned automation port ${port} is still open`), 'IDE cleanup', 15000) }
  catch (error) { errors.push(error) }
  resource.closed = errors.length === 0
  if (errors.length) throw new AggregateError(errors, `Failed closing owned IDE project ${projectPath}`)
}

function kebab(property) { return property.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`) }

export function ideProperties(styles) {
  const result = {}
  for (const [property, value] of Object.entries(styles)) {
    if (property === 'borderRadius') {
      for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) result[`border-${corner}-radius`] = value
    } else result[kebab(property)] = value
  }
  return result
}

async function findElement(page, id, component) {
  const scope = component ? await findElement(page, component) : page
  const elements = await scope.$$(`[id="${id}"]`)
  assert.equal(elements.length, 1, `Expected one native #${id}, received ${elements.length}`)
  return elements[0]
}

export async function assertIdeNavigationReady(mini, navigation, routes) {
  const destination = routes.find(route => route.path.replace(/^\//, '') === navigation.path.replace(/^\//, ''))
  assert.ok(destination?.rootId, `Native navigation destination has no fixture root: ${navigation.path}`)
  const current = await mini.currentPage()
  assert.equal(current.path.replace(/^\//, ''), navigation.path.replace(/^\//, ''))
  // The route stack can update before the destination WebView/bridge is ready.
  // Require its real rendered root before another navigation is allowed.
  await findElement(current, destination.rootId)
}

export async function readIdeStyles(element, names) {
  if (!names.length) return {}
  // This is the same public protocol used by automator's style(name), with
  // one request for all properties rather than one round trip per property.
  const { styles } = await element.send('Element.getStyles', { names })
  assert.ok(Array.isArray(styles) && styles.length === names.length, `Element.getStyles returned ${styles?.length ?? 'no'} values for ${names.length} properties`)
  return Object.fromEntries(names.map((name, index) => [name, styles[index]]))
}

function theoreticalRpxStyles(expected, width) {
  return ideProperties(Object.fromEntries(Object.entries(expected.rpx ?? {}).map(([property, value]) => [property, `${value * width / 750}px`])))
}

export function calibrateRpxProbe(expected, width, values) {
  const theoretical = theoreticalRpxStyles(expected, width)
  assert.ok(Object.keys(theoretical).length, 'Native calibration requires an rpx probe')
  const actual = {}
  for (const [property, value] of Object.entries(theoretical)) {
    assert.match(String(values[property]), /^-?\d+(?:\.\d+)?px$/, `Native reference #${expected.id} ${property} is not a pixel value`)
    assert.ok(Math.abs(Number.parseFloat(values[property]) - Number.parseFloat(value)) < 1, `Native reference #${expected.id} ${property}: ${values[property]} differs by at least 1px from theoretical ${value}`)
    actual[property] = values[property]
  }
  return { rpx: { ...expected.rpx }, theoretical, actual }
}

export function calibratedIdeProperties(expected, width, calibration) {
  const properties = ideProperties(expectedStyles(expected, width))
  if (!expected.rpx) return properties
  const probe = calibration?.probes?.[expected.id]
  assert.ok(probe, `Missing handwritten native rpx calibration for #${expected.id}`)
  assert.deepEqual(probe.rpx, expected.rpx, `Native rpx specification differs from reference for #${expected.id}`)
  for (const property of Object.keys(theoreticalRpxStyles(expected, width))) {
    assert.ok(Object.hasOwn(probe.actual, property), `Native calibration lacks #${expected.id} ${property}`)
    properties[property] = probe.actual[property]
  }
  return properties
}

export function assertCalibrationEnvironment(calibration, systemInfo, toolInfo) {
  assert.ok(calibration?.device, 'Handwritten native rpx calibration has not run')
  assert.equal(Number(systemInfo.windowWidth), calibration.device.windowWidth, 'Native window width differs from handwritten calibration')
  assert.equal(toolInfo.SDKVersion, calibration.device.SDKVersion, 'Native SDK differs from handwritten calibration')
  for (const property of ['model', 'pixelRatio', 'platform']) assert.equal(systemInfo[property], calibration.device[property], `Native ${property} differs from handwritten calibration`)
}

async function referenceHashes(row) {
  assert.ok(row.measurement?.files?.length, 'Native reference calibration requires a measured artifact')
  const files = []
  for (const file of row.measurement.files) {
    const bytes = await readFile(path.join(row.directory, file.path))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    assert.equal(sha256, file.sha256, `Native calibration reference changed: ${file.path}`)
    files.push({ path: file.path, bytes: bytes.length, sha256 })
  }
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

async function assertIdeElements(page, elements, width, label, calibration) {
  const actual = {}
  for (const expected of elements) {
    const properties = calibratedIdeProperties(expected, width, calibration)
    actual[expected.id] = await poll(async () => {
      const element = await findElement(page, expected.id, expected.component)
      const values = await readIdeStyles(element, Object.keys(properties))
      for (const [property, value] of Object.entries(properties)) {
        assertStyleEqual(values[property], value, `${label}: #${expected.id} ${property}`, 0.1)
      }
      return values
    }, `${label}: #${expected.id}`)
  }
  return actual
}

export async function validateIde(rows, { root, evidenceDirectory, cliPath, appid }) {
  const report = { status: 'running', scope: 'gallery/application: all standard schemes and optimized Panda; handwritten native rpx calibration', calibrations: [], artifacts: [], resources: [] }
  let failure
  try {
    report.environment = await preflightIde({ cliPath, appid })
    await saveEvidence(evidenceDirectory, 'official-versions.json', report.environment.channels)
    delete report.environment.channels
    const selected = rows.filter(row => row.target === 'weapp' && ['tailwind', 'panda', 'stylex'].includes(row.scheme) && ['gallery', 'application'].includes(row.scenario) && (row.profile === 'standard' || row.scheme === 'panda'))
    assert.equal(selected.length, 8, 'IDE acceptance requires all six standard artifacts and two optimized Panda artifacts')
    const reference = rows.filter(row => row.target === 'weapp' && row.scheme === 'reference' && row.profile === 'standard' && row.scenario === 'gallery')
    assert.equal(reference.length, 1, 'IDE acceptance requires one handwritten native gallery for rpx calibration')
    let calibration
    for (const row of [...reference, ...selected]) {
      const isCalibration = row === reference[0]
      const fixture = await loadFixture(row)
      const name = rowKey(row).replaceAll('/', '-')
      const projectPath = path.join(root, '.bench/ide-projects', name)
      await mkdir(path.dirname(projectPath), { recursive: true })
      await rm(projectPath, { recursive: true, force: true })
      await cp(row.directory, projectPath, { recursive: true, force: true })
      await writeFile(path.join(projectPath, 'project.config.json'), JSON.stringify({ appid, projectname: `style-size-${name}`, compileType: 'miniprogram', miniprogramRoot: '.', setting: { urlCheck: false, es6: true, compileHotReLoad: false } }, null, 2))
      await writeFile(path.join(projectPath, 'project.private.config.json'), JSON.stringify({ condition: { miniprogram: { list: fixture.routes.map(route => ({ name: route.path, pathName: route.path.slice(1), query: '' })) } } }, null, 2))
      const port = await freePort()
      const resource = { name, projectPath, port, createdByTask: true, closed: false }
      report.resources.push(resource)
      const record = { key: rowKey(row), status: 'running', routes: [], errors: [] }
      if (isCalibration) { record.probes = {}; report.calibrations.push(record) }
      else report.artifacts.push(record)
      let mini
      let artifactFailure
      try {
        if (isCalibration) record.reference = await referenceHashes(row)
        mini = await bounded(() => automator.launch({ cliPath, projectPath, port, timeout: 60000, trustProject: true }), 'Automator launch', 65000)
        assert.ok(mini, 'Automation did not connect; check login and service port')
        mini.addListener('exception', error => record.errors.push(error))
        mini.addListener('console', message => {
          if (message.type === 'error' || message.level === 'error') record.errors.push(message)
        })
        await bounded(() => mini.send('App.enableLog'), 'App.enableLog')
        record.toolInfo = await bounded(() => mini.send('Tool.getInfo'), 'Tool.getInfo')
        record.systemInfo = await bounded(() => mini.systemInfo(), 'System info')
        assert.equal(record.toolInfo.version, report.environment.installedVersion)
        assert.ok(record.toolInfo.SDKVersion, 'Actual native SDK version is missing')
        const account = await bounded(() => mini.callWxMethod('getAccountInfoSync'), 'Account info')
        assert.equal(account.miniProgram.appId, appid)
        await poll(async () => {
          const stack = await mini.pageStack()
          assert.ok(stack.length, 'Native page stack is not ready')
          await findElement(stack.at(-1), fixture.routes[0].rootId)
        }, `${name}: native initial page readiness`, 45000)
        const width = Number(record.systemInfo.windowWidth)
        assert.ok(width > 0, 'Native window width is missing')
        if (isCalibration) record.device = { windowWidth: width, SDKVersion: record.toolInfo.SDKVersion, model: record.systemInfo.model, pixelRatio: record.systemInfo.pixelRatio, platform: record.systemInfo.platform }
        else { assertCalibrationEnvironment(calibration, record.systemInfo, record.toolInfo); record.calibration = calibration.key }
        for (const route of fixture.routes) {
          const elements = isCalibration ? route.elements.filter(element => element.rpx) : route.elements
          if (!elements.length) continue
          const page = await bounded(() => mini.reLaunch(route.path), 'Native route', 30000)
          assert.equal(page.path.replace(/^\//, ''), route.path.slice(1))
          let initial
          if (isCalibration) {
            initial = {}
            for (const expected of elements) {
              const probe = await poll(async () => {
                const element = await findElement(page, expected.id, expected.component)
                const values = await readIdeStyles(element, Object.keys(theoreticalRpxStyles(expected, width)))
                return calibrateRpxProbe(expected, width, values)
              }, `${name}: calibrate #${expected.id}`)
              record.probes[expected.id] = probe
              initial[expected.id] = probe.actual
            }
          } else initial = await assertIdeElements(page, elements, width, `${name} initial`, calibration)
          const routeRecord = { path: route.path, initial, actions: [] }
          record.routes.push(routeRecord)
          for (const action of isCalibration ? [] : route.actions ?? []) {
            await bounded(async () => await (await findElement(page, action.id)).tap(), `Native tap ${action.id}`)
            const computed = await assertIdeElements(page, action.checks, width, `${name} ${action.state}`, calibration)
            if (action.data) for (const [key, value] of Object.entries(action.data)) assert.deepEqual(await bounded(() => page.data(key), `Native state ${key}`), value)
            routeRecord.actions.push({ state: action.state, computed })
          }
          assert.deepEqual(record.errors, [], 'Native runtime exceptions')
          const filename = `${name}-${route.path.replaceAll('/', '-')}.png`
          const screenshotPath = path.join(evidenceDirectory, filename)
          await bounded(() => mini.screenshot({ path: screenshotPath }), 'Native screenshot')
          const image = await readFile(screenshotPath)
          assert.ok(image.length > 8 && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'IDE screenshot is not a PNG')
          routeRecord.screenshot = path.relative(root, screenshotPath).split(path.sep).join('/')
          routeRecord.navigation = []
          for (const navigation of isCalibration ? [] : route.navigation ?? []) {
            const origin = await bounded(() => mini.reLaunch(route.path), 'Reset navigation route', 30000)
            await bounded(async () => await (await findElement(origin, navigation.id)).tap(), 'Native navigation tap')
            await poll(() => assertIdeNavigationReady(mini, navigation, fixture.routes), `${name}: ${navigation.method} ${navigation.path}`)
            routeRecord.navigation.push({ ...navigation, status: 'passed' })
          }
        }
        if (isCalibration) { assert.ok(Object.keys(record.probes).length, 'Handwritten calibration contains no rpx probes'); calibration = record }
        record.status = 'passed'
      } catch (error) {
        record.status = 'failed'
        record.error = error.stack ?? String(error)
        artifactFailure = error
      } finally {
        try { await closeOwnedIde({ mini, cliPath, projectPath, port, resource }) }
        catch (error) { artifactFailure = new AggregateError([artifactFailure, error].filter(Boolean), 'IDE validation/cleanup failed'); resource.cleanupError = error.message }
        await saveEvidence(evidenceDirectory, 'report.json', report)
      }
      if (artifactFailure) throw artifactFailure
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack ?? String(error)
    failure = error
  } finally { await saveEvidence(evidenceDirectory, 'report.json', report) }
  if (failure) throw failure
  return report
}
