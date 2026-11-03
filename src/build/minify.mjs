import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { transform } from 'lightningcss'

// Native adapters emit styles after Vite's CSS minifier has run. Apply one
// identical final pass so formatting differences do not determine raw ranking.
export async function minifyNativeStyles(directory) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.isFile() && file.endsWith('.wxss')) {
        const input = await readFile(file)
        const output = transform({ filename: path.relative(directory, file), code: input, minify: true, sourceMap: false, errorRecovery: false }).code
        await writeFile(file, output)
        files.push({ path: path.relative(directory, file).split(path.sep).join('/'), before: input.length, after: output.length })
      }
    }
  }
  await walk(directory)
  return { tool: 'lightningcss@1.33.0', files, before: files.reduce((sum, file) => sum + file.before, 0), after: files.reduce((sum, file) => sum + file.after, 0) }
}
