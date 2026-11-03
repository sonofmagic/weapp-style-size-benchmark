import path from 'node:path'

function versions(input) {
  return Object.fromEntries(Object.entries(input ?? {}).flatMap(([key, value]) => {
    if (typeof value === 'string' || typeof value === 'number') return [[key, value]]
    if (value && typeof value === 'object' && value.version) return [[key, value.version]]
    return []
  }))
}

export function environmentSummary(environment) {
  const names = ['node', 'pnpm', 'platform', 'arch', 'os', 'cpu', 'zlib', 'brotli', 'v8', 'browser', 'chromium', 'packageManager', 'lockfileSha256', 'commit']
  const summary = Object.fromEntries(names.filter(name => environment[name] !== undefined).map(name => [name, environment[name]]))
  for (const name of ['packages', 'versions', 'dependencies', 'adapters']) {
    if (environment[name]) summary[name] = versions(environment[name])
  }
  return summary
}

export function protocolSummary(protocol) {
  return Object.fromEntries(Object.entries(protocol).flatMap(([key, value]) => {
    if (/(?:manifest|source|files|fingerprint|artifact)/i.test(key)) return []
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return [[key, value]]
    if (Array.isArray(value) && value.length <= 20 && value.every(item => ['string', 'number', 'boolean'].includes(typeof item))) return [[key, value]]
    if (value && !Array.isArray(value) && typeof value === 'object') {
      const short = protocolSummary(value)
      if (Object.keys(short).length) return [[key, short]]
    }
    return []
  }))
}

export function representativeScreenshots(report) {
  const artifacts = report.validation.web?.artifacts ?? []
  return ['gallery', 'application'].flatMap(scenario => {
    const artifact = artifacts.find(item => {
      const key = String(item.key ?? '')
      return key.includes('reference') && key.includes('standard') && key.includes(scenario)
    })
    const state = artifact?.routes?.find(route => route.width === 375 && route.state === 'initial' && route.screenshot)
    return state ? [{ scenario, path: state.screenshot }] : []
  })
}

export function screenshotMarkdown(report, readmeDirectory = '.') {
  return representativeScreenshots(report).flatMap(item => {
    const relative = path.isAbsolute(item.path) ? path.relative(readmeDirectory, item.path) : item.path
    return [`![${item.scenario}：手写 CSS 参考，375px 初始状态](${relative.split(path.sep).join('/').replaceAll(' ', '%20')})`, '']
  })
}
