import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }

export async function createArtifactServer() {
  let artifact
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
      let file = path.resolve(artifact, `.${pathname}`)
      assert.ok(file === artifact || file.startsWith(`${artifact}${path.sep}`), 'Path traversal')
      try {
        if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
      } catch {
        if (!path.extname(pathname)) file = path.join(artifact, 'index.html')
      }
      const content = await readFile(file)
      response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end('Not found')
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    select(directory) { artifact = path.resolve(directory) },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
