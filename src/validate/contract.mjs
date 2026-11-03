import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const VISUAL_PROPERTIES = ['display', 'boxSizing', 'position', 'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopStyle', 'borderTopColor', 'borderRadius', 'opacity', 'gap', 'alignItems', 'justifyContent', 'flexDirection', 'backgroundImage', 'boxShadow', 'transform']

export function rowKey(row) {
  return [row.scheme, row.profile, row.scenario, row.target].join('/')
}

export async function loadFixture(row) {
  const fixture = JSON.parse(await readFile(path.join(row.fixtureDirectory, 'fixture.json'), 'utf8'))
  assert.equal(fixture.version, 1, 'Unsupported fixture contract')
  for (const key of ['scheme', 'profile', 'scenario', 'target']) assert.equal(fixture[key], row[key], `Fixture ${key} mismatch`)
  assert.ok(Array.isArray(fixture.routes) && fixture.routes.length, 'Fixture has no routes')
  const routes = new Set()
  for (const route of fixture.routes) {
    assert.ok(typeof route.path === 'string' && /^\/[\w/-]+$/.test(route.path), 'Invalid fixture route')
    assert.ok(!routes.has(route.path), 'Duplicate fixture route')
    routes.add(route.path)
    assert.ok(route.rootId && Array.isArray(route.elements) && route.elements.length, 'Missing fixture element expectations')
    const ids = new Set()
    for (const element of route.elements) {
      assert.ok(element.id && !ids.has(element.id), 'Duplicate or empty expected element id')
      ids.add(element.id)
      assert.ok(element.styles && typeof element.styles === 'object', 'Missing expected styles')
    }
    for (const action of route.actions ?? []) {
      assert.ok(action.id && action.state, 'Action must declare its target and resulting state')
      assert.ok(Array.isArray(action.checks) && action.checks.length, 'Action has no observable checks')
      for (const check of action.checks) assert.ok(ids.has(check.id), `Action references unknown element ${check.id}`)
    }
  }
  return fixture
}

export function expectedStyles(element, viewportWidth = 375, rpxWidth = viewportWidth) {
  return { ...element.styles, ...(viewportWidth >= 768 ? element.wideStyles : {}), ...Object.fromEntries(Object.entries(element.rpx ?? {}).map(([key, value]) => [key, `${value * rpxWidth / 750}px`])) }
}

export function normalizeStyle(value) {
  return String(value).trim().replace(/\s+/g, ' ').replace(/,\s*/g, ',')
}

export function assertStyleEqual(actual, expected, label, tolerance = 0.1) {
  const px = /^(-?\d+(?:\.\d+)?)px$/
  const left = px.exec(String(actual).trim())
  const right = px.exec(String(expected).trim())
  if (left && right) assert.ok(Math.abs(Number(left[1]) - Number(right[1])) <= tolerance, `${label}: ${actual} != ${expected}`)
  else assert.equal(normalizeStyle(actual), normalizeStyle(expected), label)
}

export function assertSnapshot(snapshot, elements, { width = 375, rpxWidth = width, label = '' } = {}) {
  for (const element of elements) {
    const actual = snapshot[element.id]
    assert.ok(actual, `${label}: missing #${element.id}`)
    for (const [property, expected] of Object.entries(expectedStyles(element, width, rpxWidth))) {
      assertStyleEqual(actual.styles[property], expected, `${label}: #${element.id} ${property}`)
    }
    for (const [dimension, value] of Object.entries(element.box ?? {})) {
      assert.ok(Math.abs(actual.box[dimension] - value) <= 0.75, `${label}: #${element.id} ${dimension}: ${actual.box[dimension]} != ${value}`)
    }
  }
}

export function assertEquivalent(actual, reference, { label = '', tolerance = 0.75 } = {}) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(reference).sort(), `${label}: element sets differ`)
  for (const [id, expected] of Object.entries(reference)) {
    for (const [property, value] of Object.entries(expected.styles)) {
      assertStyleEqual(actual[id].styles[property], value, `${label}: reference mismatch #${id} ${property}`)
    }
    for (const dimension of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(actual[id].box[dimension] - expected.box[dimension]) <= tolerance, `${label}: reference geometry mismatch #${id} ${dimension}: ${actual[id].box[dimension]} != ${expected.box[dimension]}`)
    }
  }
}

export async function saveEvidence(directory, filename, value) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, filename), `${JSON.stringify(value, null, 2)}\n`)
}

export async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout
  let lastError
  do {
    try { return await bounded(check, label, Math.max(1, deadline - Date.now())) }
    catch (error) {
      // A final short RPC deadline should not hide the concrete mismatch that
      // triggered the retry. Preserve it while still failing at the deadline.
      if (!lastError || error?.code !== 'ERR_BENCHMARK_TIMEOUT') lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  } while (Date.now() < deadline)
  throw new Error(`${label}: ${lastError?.message ?? 'timed out'}`, { cause: lastError })
}

export async function bounded(work, label, timeout = 15000) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} timed out after ${timeout}ms`)
        error.name = 'TimeoutError'
        error.code = 'ERR_BENCHMARK_TIMEOUT'
        reject(error)
      }, timeout)
    })])
  } finally { clearTimeout(timer) }
}
