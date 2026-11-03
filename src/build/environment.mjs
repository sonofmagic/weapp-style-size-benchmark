import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function inputFingerprint(root) {
  const paths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.nvmrc']
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`
      if (entry.isDirectory()) await walk(relative)
      else if (!entry.name.endsWith('.test.mjs')) paths.push(relative)
    }
  }
  await walk('src/fixtures')
  await walk('src/build')
  const files = await Promise.all(paths.sort().map(async file => ({ path: file, sha256: createHash('sha256').update(await readFile(path.join(root, file))).digest('hex') })))
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }
}

export async function environment(root) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  return {
    generatedAt: new Date().toISOString(), node: process.versions.node, pnpm: pkg.packageManager,
    platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
    zlib: process.versions.zlib, brotli: process.versions.brotli,
    packages: { ...pkg.dependencies, ...pkg.devDependencies },
    inputs: await inputFingerprint(root),
  }
}

export const protocol = {
  buildRounds: 2, production: true, minify: true, sourcemap: false,
  nativeFinalCssMinifier: 'lightningcss@1.33.0; same final WXSS pass for every scheme; before/after bytes retained per row',
  gzipLevel: 9, brotliQuality: 11, compressionScope: 'per-file',
  profiles: { standard: 'Production without extra class shortening', optimized: 'Panda hash.className=true; other schemes retain the same production settings' },
  targets: { weapp: 'Native WXML/Page/Component via weapp-vite', web: 'Same native sources via weapp-vite web renderer' },
  reset: 'Explicit shared reset; framework preflight disabled',
  classDelivery: 'Idiomatic per scheme; no artificial common runtime class map',
  packageAccounting: 'Physical files, no content deduplication or page apportioning',
}
