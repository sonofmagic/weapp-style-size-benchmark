import assert from 'node:assert/strict'
import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from '@babel/parser'
import postcss from 'postcss'
import { packageRoots } from '../measure/index.mjs'

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, name) => {
    if (name[0] === '#') return String.fromCodePoint(Number.parseInt(name.slice(name[1].toLowerCase() === 'x' ? 2 : 1), name[1].toLowerCase() === 'x' ? 16 : 10))
    return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name.toLowerCase()] ?? entity
  })
}

// Attribute-aware lexer: '>' inside a quoted value, comments and script text
// cannot manufacture extra resource tags. This consumes emitted HTML/WXML.
function tags(source) {
  const found = []
  let cursor = 0
  while ((cursor = source.indexOf('<', cursor)) !== -1) {
    if (source.startsWith('<!--', cursor)) { const end = source.indexOf('-->', cursor + 4); cursor = end < 0 ? source.length : end + 3; continue }
    const match = /^<([a-z][\w:.-]*)\b/i.exec(source.slice(cursor))
    if (!match) { cursor++; continue }
    const name = match[1].toLowerCase()
    cursor += match[0].length
    const attributes = {}
    while (cursor < source.length && source[cursor] !== '>') {
      if (/[\s/]/.test(source[cursor])) { cursor++; continue }
      const attribute = /^[^\s=/>]+/.exec(source.slice(cursor))
      if (!attribute) { cursor++; continue }
      const key = attribute[0].toLowerCase()
      cursor += attribute[0].length
      while (/\s/.test(source[cursor] ?? '')) cursor++
      let value = ''
      if (source[cursor] === '=') {
        cursor++
        while (/\s/.test(source[cursor] ?? '')) cursor++
        const quote = source[cursor]
        if (quote === '"' || quote === "'") {
          const start = ++cursor
          while (cursor < source.length && source[cursor] !== quote) cursor++
          value = source.slice(start, cursor++)
        } else {
          const start = cursor
          while (cursor < source.length && !/[\s>]/.test(source[cursor])) cursor++
          value = source.slice(start, cursor).replace(/\/$/, '')
        }
      }
      attributes[key] = decodeEntities(value)
    }
    const selfClosing = source[cursor - 1] === '/'
    cursor++
    let body
    if (!selfClosing && ['script', 'style', 'wxs'].includes(name)) {
      const end = new RegExp(`</${name}\\s*>`, 'ig')
      end.lastIndex = cursor
      const close = end.exec(source)
      body = source.slice(cursor, close?.index ?? source.length)
      cursor = close ? end.lastIndex : source.length
    }
    found.push({ name, attributes, body })
  }
  return found
}

function stringValue(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
}

function javascriptReferences(source, filename) {
  let ast
  try { ast = parse(source, { sourceType: 'unambiguous', allowReturnOutsideFunction: true }) }
  catch (error) { throw new Error(`Cannot parse emitted JavaScript in ${filename}: ${error.message}`, { cause: error }) }
  const references = []
  let dynamic = 0
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source) {
      const request = stringValue(node.source)
      if (request !== undefined) references.push(request)
      else dynamic++
    } else if (node.type === 'CallExpression' && (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'require'))) {
      const request = stringValue(node.arguments[0])
      if (request !== undefined) references.push(request)
      else dynamic++
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => { if (child?.type) visit(child) })
      else if (value?.type) visit(value)
    }
  }
  try { visit(ast) } catch (error) { throw new Error(`Cannot inspect JavaScript references in ${filename}`, { cause: error }) }
  return { references, dynamic }
}

function cssImportRequest(params) {
  let text = params.trim().replace(/^url\(\s*/i, '')
  const quote = text[0]
  let value
  if (quote === '"' || quote === "'") {
    let end = 1
    while (end < text.length) {
      if (text[end] === '\\') end += 2
      else if (text[end] === quote) break
      else end++
    }
    value = text.slice(1, end)
  } else value = /^[^\s)]+/.exec(text)?.[0]
  assert.ok(value, `Invalid emitted CSS @import: ${params}`)
  return value.replace(/\\([\da-f]{1,6})(?:\s)?|\\([^\r\n])/gi, (_, hex, character) => hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : character)
}

async function outputFiles(directory) {
  assert.ok(!(await lstat(directory)).isSymbolicLink(), 'Artifact root cannot be a symlink')
  const files = []
  async function walk(current, parent = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = parent ? `${parent}/${entry.name}` : entry.name
      assert.ok(!entry.isSymbolicLink(), `Artifact symlink is forbidden: ${relative}`)
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Unsupported artifact entry: ${relative}`)
    }
  }
  await walk(directory)
  return files.sort()
}

export async function validateReferences(directory, { target }) {
  assert.ok(['weapp', 'web'].includes(target), `Unknown reference validation target: ${target}`)
  const files = await outputFiles(directory)
  assert.ok(files.length, 'Cannot validate an empty artifact')
  const existing = new Set(files)
  const references = []
  const external = []
  let dynamicReferences = 0
  let roots = []
  const independent = new Set()
  const read = file => readFile(path.join(directory, file), 'utf8')
  const mustExist = (file, from, request, kind) => {
    assert.ok(existing.has(file), `${from}: missing ${kind} ${JSON.stringify(request)} (expected ${file})`)
    const owner = roots.find(root => from.startsWith(`${root}/`))
    if (owner && independent.has(owner)) assert.ok(file.startsWith(`${owner}/`), `Independent subpackage ${owner} cannot reference outside its package: ${from} -> ${file}`)
    references.push({ from, to: file, kind, request })
    return file
  }
  const localPath = (from, request, kind, bare = true) => {
    assert.equal(typeof request, 'string', `${from}: ${kind} must have a string path`)
    assert.ok(!/^[a-z]:[\\/]/i.test(request) && !request.includes('\\') && !request.includes('\0'), `${from}: invalid artifact path ${request}`)
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(request)) { external.push({ from, request, kind }); return }
    if (!bare && !request.startsWith('.') && !request.startsWith('/')) { external.push({ from, request, kind }); return }
    if (request.includes('{{')) { dynamicReferences++; return }
    const clean = decodeURIComponent(request.split(/[?#]/, 1)[0])
    const resolved = clean.startsWith('/') ? path.posix.normalize(clean.slice(1)) : clean ? path.posix.join(path.posix.dirname(from), clean) : from
    assert.ok(resolved !== '..' && !resolved.startsWith('../') && !path.posix.isAbsolute(resolved) && !resolved.includes('\\') && !resolved.includes('\0'), `${from}: reference escapes artifact root: ${request}`)
    return resolved
  }
  const resource = (from, request, kind, { suffixes = [''], bare = true } = {}) => {
    const resolved = localPath(from, request, kind, bare)
    if (resolved === undefined) return
    const match = suffixes.map(suffix => `${resolved}${suffix}`).find(candidate => existing.has(candidate))
    assert.ok(match, `${from}: missing ${kind} ${JSON.stringify(request)} (tried ${suffixes.map(suffix => `${resolved}${suffix}`).join(', ')})`)
    return mustExist(match, from, request, kind)
  }
  const triplet = (from, request, kind) => {
    const resolved = localPath(from, request, kind)
    if (resolved !== undefined) for (const suffix of ['.js', '.wxml', '.json']) mustExist(`${resolved}${suffix}`, from, request, kind)
  }
  if (target === 'weapp') {
    mustExist('app.json', 'app.json', 'app.json', 'application configuration')
    mustExist('app.js', 'app.json', 'app.js', 'application script')
    const app = JSON.parse(await read('app.json'))
    roots = packageRoots(app)
    assert.ok(Array.isArray(app.pages) && app.pages.length, 'app.json must declare main-package pages')
    const packages = app.subPackages ?? app.subpackages ?? []
    const pages = new Set()
    for (const pkg of packages) {
      assert.ok(Array.isArray(pkg.pages), `Subpackage ${pkg.root} must declare pages`)
      assert.ok(pkg.independent === undefined || typeof pkg.independent === 'boolean', `Invalid independent flag for ${pkg.root}`)
      if (pkg.independent) independent.add(pkg.root)
    }
    for (const [prefix, routes] of [['', app.pages], ...packages.map(pkg => [pkg.root, pkg.pages])]) {
      for (const route of routes) {
        assert.ok(typeof route === 'string' && route && !route.startsWith('/') && !route.includes('\\') && !/[?#]/.test(route) && !route.split('/').some(segment => !segment || segment === '.' || segment === '..'), `Invalid app.json page route: ${String(route)}`)
        const relative = prefix ? `${prefix}/${route}` : route
        assert.ok(!pages.has(relative), `Duplicate app.json page: ${relative}`)
        pages.add(relative)
        triplet('app.json', `/${relative}`, 'declared page')
      }
    }
  } else assert.ok(existing.has('index.html'), 'H5 artifact must contain index.html at its serving root')

  const inspectJs = (source, file) => {
    const found = javascriptReferences(source, file)
    dynamicReferences += found.dynamic
    for (const request of found.references) resource(file, request, 'JavaScript module', { suffixes: ['', '.js', '.json', '.mjs', '.cjs', '/index.js', '/index.json', '/index.mjs'], bare: false })
  }
  for (const file of files) {
    if (/\.(?:js|mjs|cjs|wxs)$/.test(file)) inspectJs(await read(file), file)
    else if (target === 'weapp' && file.endsWith('.json') && !/^project(?:\.[^.]+)*\.config\.json$/.test(path.posix.basename(file))) {
      const config = JSON.parse(await read(file))
      for (const request of Object.values(config.usingComponents ?? {})) triplet(file, request, 'usingComponents target')
    } else if (/\.(?:wxss|css)$/.test(file)) {
      postcss.parse(await read(file), { from: file }).walkAtRules('import', rule => resource(file, cssImportRequest(rule.params), 'stylesheet import'))
    } else if (file.endsWith('.wxml') || file.endsWith('.html')) {
      for (const tag of tags(await read(file))) {
        if (file.endsWith('.wxml') && ['import', 'include'].includes(tag.name)) {
          assert.ok(tag.attributes.src, `${file}: ${tag.name} has no src`)
          resource(file, tag.attributes.src, `WXML ${tag.name}`)
        } else if (file.endsWith('.wxml') && tag.name === 'wxs') {
          if (tag.attributes.src) resource(file, tag.attributes.src, 'WXS module')
          else if (tag.body) inspectJs(tag.body, file)
        } else if (file.endsWith('.html')) {
          if (tag.name === 'script' && tag.attributes.src) resource(file, tag.attributes.src, 'HTML script')
          else if (tag.name === 'script' && tag.body && (!tag.attributes.type || ['module', 'text/javascript', 'application/javascript'].includes(tag.attributes.type))) inspectJs(tag.body, file)
          if (tag.name === 'link' && tag.attributes.href) resource(file, tag.attributes.href, 'HTML link')
        }
      }
    }
  }
  return { status: 'passed', target, files: files.length, references, external, dynamicReferences, independentPackages: [...independent] }
}
