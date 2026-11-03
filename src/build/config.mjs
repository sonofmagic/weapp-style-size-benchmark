import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function configureFixture(directory, { scheme, scenario, profile, target }, pandaTheme = {}) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Style size benchmark</title></head><body><div id="app"></div><script type="module" src="/@weapp-vite/web/entry"></script></body></html>\n')
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'benchmark-fixture', private: true, type: 'module' }))
  await writeFile(path.join(directory, 'project.config.json'), JSON.stringify({
    appid: 'touristappid', projectname: 'style-size-benchmark', miniprogramRoot: 'dist/',
    setting: { es6: true, minified: false, urlCheck: false },
  }, null, 2))
  let imports = ''
  let setup = ''
  let plugins = '[]'
  let compilerPlugins = '[]'
  let postcss = '{}'
  let tailwind = 'false'
  if (scheme === 'tailwind') {
    const entries = ['src/tailwind.css', ...(scenario === 'application' ? ['src/independent/tailwind.css'] : [])]
    tailwind = `{ cssEntries: ${JSON.stringify(entries.map(file => path.join(directory, file)))}, generator: { target: '${target}', webCompat: ${target === 'web'} }, cssPreflight: false, logLevel: 'warn' }`
    if (target === 'web') {
      imports = "import tailwindPostcss from 'weapp-tailwindcss/postcss'\n"
      tailwind = 'false'
      postcss = `{ postcss: { plugins: [tailwindPostcss({ projectRoot: ${JSON.stringify(directory)}, generator: { target: 'web', webCompat: true }, scanSources: true })] } }`
    }
  }
  if (scheme === 'stylex') {
    imports = "import { createStylex } from 'weapp-stylex/weapp-vite'\n"
    setup = "const sx = createStylex({ backend: 'babel' })\n"
    plugins = 'sx.vitePlugins'
    compilerPlugins = '[sx.compilerPlugin]'
  }
  if (scheme === 'panda') {
    imports = "import weappPanda from 'weapp-pandacss/postcss'\n"
    postcss = `{ postcss: { plugins: [weappPanda({ target: '${target}', panda: { configPath: ${JSON.stringify(path.join(directory, 'panda.config.ts'))}, cwd: ${JSON.stringify(directory)} } })] } }`
    await writeFile(path.join(directory, 'panda.config.ts'), `import { defineConfig } from '@pandacss/dev'
import { weappPanda } from 'weapp-pandacss/panda'
export default defineConfig({
  plugins: [weappPanda()], preflight: false, polyfill: ${target === 'web'},
  presets: ['@pandacss/preset-base', '@pandacss/preset-panda'],
  include: ['./src/**/*.ts'], exclude: [], outdir: 'styled-system',
  outExtension: 'mjs', forceImportExtension: true, cssVarRoot: '.theme-light, .theme-dark',
  hash: { className: ${profile === 'optimized'} }, theme: { extend: ${JSON.stringify(pandaTheme)} },
})\n`)
  }
  await writeFile(path.join(directory, 'vite.config.ts'), `import { defineConfig } from 'weapp-vite/config'
${imports}${setup}export default defineConfig({
  base: './', plugins: ${plugins},
  build: { outDir: 'dist', minify: true, cssMinify: true, sourcemap: false, emptyOutDir: false },
  css: ${postcss},
  weapp: { srcRoot: 'src', platform: '${target}', autoRoutes: false, autoImportComponents: false,
    tailwindcss: ${tailwind}, compilerPlugins: ${compilerPlugins}, },
})\n`)
}
