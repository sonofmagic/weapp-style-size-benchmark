import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export const compression = Object.freeze({ gzipLevel: 9, brotliQuality: 11, scope: 'per-file' })
// Only compressed lengths are retained; deployable files remain distinct rows.
const compressedLengths = new Map()

function sizes(bytes, sha256) {
  let lengths = compressedLengths.get(sha256)
  if (!lengths) {
    lengths = {
      gzip: gzipSync(bytes, { level: compression.gzipLevel }).byteLength,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: compression.brotliQuality } }).byteLength,
    }
    compressedLengths.set(sha256, lengths)
  }
  return lengths
}

function kindOf(file) {
  const extension = path.posix.extname(file).toLowerCase()
  if (['.css', '.wxss', '.acss', '.ttss'].includes(extension)) return 'style'
  if (['.js', '.mjs', '.cjs', '.wxs'].includes(extension)) return 'script'
  if (['.wxml', '.axml', '.ttml', '.html'].includes(extension)) return 'template'
  if (extension === '.json') return 'json'
  return 'asset'
}

function exclusion(file) {
  if (file.endsWith('.map')) return 'source map'
  const name = path.posix.basename(file)
  if (/^project(?:\.[^.]+)*\.config\.json$/i.test(name)) return 'developer tools project configuration'
  if (['.DS_Store', 'Thumbs.db'].includes(name)) return 'operating system metadata'
  if (name === 'stats.html' || name === 'stats.json') return 'build analysis output'
  return undefined
}

async function listFiles(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(directory, absolute).split(path.sep).join('/')
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not deployable benchmark outputs: ${relative}`)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Unsupported output file type: ${relative}`)
    }
  }
  await walk(directory)
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

export function packageRoots(app) {
  if (app.subPackages !== undefined && app.subpackages !== undefined) throw new Error('Ambiguous app.json subPackages/subpackages')
  const packages = app.subPackages ?? app.subpackages ?? []
  if (!Array.isArray(packages)) throw new Error('app.json subPackages must be an array')
  const roots = packages.map(item => item?.root)
  for (const root of roots) {
    if (typeof root !== 'string' || !root || root.startsWith('/') || root.includes('\\') || root.split('/').some(segment => !segment || segment === '.' || segment === '..') || /^[a-z]:/i.test(root)) {
      throw new Error(`Invalid subpackage root: ${String(root)}`)
    }
  }
  if (new Set(roots).size !== roots.length || roots.some(root => roots.some(other => root !== other && root.startsWith(`${other}/`)))) {
    throw new Error('Duplicate or overlapping subpackage roots')
  }
  return roots
}

function total() { return { files: 0, raw: 0, gzip: 0, brotli: 0 } }
function add(value, file) {
  value.files += 1
  for (const key of ['raw', 'gzip', 'brotli']) value[key] += file[key]
}

export async function collect(directory, { target } = {}) {
  if (!['weapp', 'web'].includes(target)) throw new Error(`Unknown measurement target: ${target}`)
  const allFiles = await listFiles(directory)
  const excluded = []
  const included = allFiles.filter(file => {
    const reason = exclusion(file)
    if (reason) excluded.push({ path: file, reason })
    return !reason
  })
  if (!included.length) throw new Error('Build output contains no deployable files')
  let roots = []
  if (target === 'weapp') {
    if (!included.includes('app.json')) throw new Error('Missing required weapp output: app.json')
    roots = packageRoots(JSON.parse(await readFile(path.join(directory, 'app.json'), 'utf8')))
  }
  else if (!included.some(file => path.posix.extname(file) === '.html')) throw new Error('Missing required web HTML entry')
  const files = []
  const totals = total()
  const byKind = Object.fromEntries(['style', 'script', 'template', 'json', 'asset'].map(kind => [kind, total()]))
  const byPackage = Object.fromEntries((target === 'weapp' ? ['main', ...roots] : ['web']).map(name => [name, total()]))
  for (const file of included) {
    const bytes = await readFile(path.join(directory, file))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const row = {
      path: file,
      kind: kindOf(file),
      package: target === 'web' ? 'web' : roots.find(root => file.startsWith(`${root}/`)) ?? 'main',
      raw: bytes.byteLength,
      ...sizes(bytes, sha256),
      sha256,
    }
    files.push(row)
    add(totals, row)
    add(byKind[row.kind], row)
    add(byPackage[row.package], row)
  }
  return { files, excluded, totals: { raw: totals.raw, gzip: totals.gzip, brotli: totals.brotli }, byKind, byPackage }
}

export function manifest(measurement) {
  const files = (Array.isArray(measurement) ? measurement : measurement.files)
    .map(file => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'))
  if (!files.length) throw new Error('Cannot create an empty output manifest')
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Duplicate output manifest paths')
  return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
}

export function compareManifests(expected, actual) {
  const before = new Map(expected.files.map(file => [file.path, file.sha256]))
  const after = new Map(actual.files.map(file => [file.path, file.sha256]))
  return {
    added: actual.files.filter(file => !before.has(file.path)).map(file => file.path),
    removed: expected.files.filter(file => !after.has(file.path)).map(file => file.path),
    changed: actual.files.filter(file => before.has(file.path) && before.get(file.path) !== file.sha256).map(file => file.path),
  }
}

export function assertRepeatable(expected, actual) {
  const difference = compareManifests(expected, actual)
  if (Object.values(difference).some(files => files.length)) throw new Error(`Production outputs differ: ${JSON.stringify(difference)}`)
  return true
}
