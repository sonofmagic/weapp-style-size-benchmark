import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function runNode(script, args, { cwd, log, env = {} }) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd, env: { ...process.env, ...env, NODE_ENV: 'production', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let content = ''
    const append = data => { content += data.toString() }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => { child.kill('SIGTERM') }, 180_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ content, code, signal })
    })
  })
  await mkdir(path.dirname(log), { recursive: true })
  await writeFile(log, output.content)
  if (output.code !== 0) throw new Error(`Command failed (${output.code ?? output.signal}): ${script} ${args.join(' ')}\n${output.content.slice(-16000)}\nLog: ${log}`)
  return output.content
}
