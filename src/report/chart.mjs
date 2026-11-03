import { profiles, schemes, targets } from './validate.mjs'

const colors = { tailwind: '#0e7490', panda: '#a16207', stylex: '#7c3aed', reference: '#64748b', unstyled: '#cbd5e1' }
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

export function scalingChart(report) {
  const width = 1120
  const panelWidth = 550
  const panelHeight = 255
  const elements = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="1130" viewBox="0 0 ${width} 1130" role="img" aria-labelledby="title desc"><title id="title">三种样式方案的规模增长曲线</title><desc id="desc">按目标、配置和重复或独立样式场景，比较最终部署文件未压缩 KiB。横轴规模采用等距对数刻度。</desc><rect width="100%" height="100%" fill="#fff"/><g font-family="system-ui,sans-serif" fill="#0f172a"><text x="30" y="35" font-size="23" font-weight="700">样式产物随规模增长</text><text x="30" y="59" font-size="13" fill="#475569">最终部署文件总量 · raw KiB · 横轴 10 / 100 / 1000 · 各面板独立纵轴</text>`]
  for (const [index, scheme] of schemes.entries()) elements.push(`<circle cx="${32 + index * 180}" cy="85" r="4" fill="${colors[scheme]}"/><text x="${42 + index * 180}" y="90" font-size="13">${scheme}</text>`)
  let panel = 0
  for (const target of targets) for (const profile of profiles) for (const mode of ['reuse', 'unique']) {
    const column = panel % 2
    const rowIndex = Math.floor(panel / 2)
    const left = column * panelWidth + 30
    const top = rowIndex * panelHeight + 120
    const x = [left + 58, left + 258, left + 458]
    const baseline = top + 188
    const values = report.rows.filter(row => row.target === target && row.profile === profile && row.scenario.startsWith(`${mode}-`))
    const maximum = Math.max(...values.map(row => row.measurement.totals.raw / 1024), 1) * 1.08
    const y = value => baseline - value / maximum * 142
    elements.push(`<text x="${left}" y="${top}" font-size="14" font-weight="650">${target === 'weapp' ? '微信' : 'H5'} · ${profile === 'standard' ? '常规生产' : '优化配置'} · ${mode === 'reuse' ? '复用样式' : '独立样式'}</text>`)
    for (let tick = 0; tick <= 3; tick++) {
      const value = maximum * tick / 3
      elements.push(`<path d="M${left + 58} ${y(value)}H${left + 458}" stroke="#e2e8f0"/><text x="${left + 48}" y="${y(value) + 4}" text-anchor="end" font-size="11" fill="#64748b">${value.toFixed(value < 10 ? 1 : 0)}</text>`)
    }
    for (const [index, count] of [10, 100, 1000].entries()) elements.push(`<text x="${x[index]}" y="${baseline + 21}" text-anchor="middle" font-size="12">${count}</text>`)
    for (const scheme of schemes) {
      const points = [10, 100, 1000].map((count, index) => {
        const value = values.find(row => row.scheme === scheme && row.scenario === `${mode}-${count}`).measurement.totals.raw / 1024
        return { x: x[index], y: y(value), value }
      })
      elements.push(`<polyline points="${points.map(point => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${colors[scheme]}" stroke-width="2"${scheme === 'unstyled' ? ' stroke-dasharray="5 4"' : ''}/>`)
      for (const point of points) elements.push(`<circle cx="${point.x}" cy="${point.y}" r="3" fill="${colors[scheme]}"><title>${escape(scheme)}: ${point.value.toFixed(2)} KiB</title></circle>`)
    }
    panel++
  }
  elements.push('</g></svg>')
  return elements.join('\n')
}
