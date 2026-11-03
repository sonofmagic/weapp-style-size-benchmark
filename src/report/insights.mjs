import { profiles, targets } from './validate.mjs'

export const names = { tailwind: 'weapp-tailwindcss', panda: 'weapp-pandacss', stylex: 'weapp-stylex', reference: '手写 CSS', unstyled: '无样式基线' }
export const profileName = value => value === 'standard' ? '常规生产' : '优化配置'
export const targetName = value => value === 'weapp' ? '微信' : 'H5'
export const kib = value => `${(value / 1024).toFixed(2)}`
export const delta = value => `${value > 0 ? '+' : ''}${kib(value)}`
const safe = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
export const table = (headings, rows) => [`| ${headings.join(' | ')} |`, `| ${headings.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(safe).join(' | ')} |`)]
const actualSchemes = ['tailwind', 'panda', 'stylex']

function select(report, scheme, profile, scenario, target) {
  return report.rows.find(row => row.scheme === scheme && row.profile === profile && row.scenario === scenario && row.target === target)
}
function smallest(rows, value) {
  const min = Math.min(...rows.map(value))
  return rows.filter(row => value(row) === min).map(row => row.scheme)
}
const equalNames = (left, right) => left.length === right.length && left.every(name => right.includes(name))

export function conclusions(report) {
  const lines = []
  let mismatched = 0
  for (const target of targets) for (const profile of profiles) {
    const rows = actualSchemes.map(scheme => select(report, scheme, profile, 'application', target))
    const min = Math.min(...rows.map(row => row.measurement.totals.raw))
    const winners = smallest(rows, row => row.measurement.totals.raw).map(scheme => names[scheme]).join('、')
    const max = Math.max(...rows.map(row => row.measurement.totals.raw))
    const ordered = [...rows].sort((left, right) => left.measurement.totals.raw - right.measurement.totals.raw)
    const nearestGap = ordered[1].measurement.totals.raw - ordered[0].measurement.totals.raw
    const close = target === 'web' ? ` raw 排序前两方案相差 ${nearestGap} 字节（相对最小值 ${(nearestGap / min * 100).toFixed(3)}%）；此差值只代表本版本和场景，不能泛化为普遍优势。` : ''
    lines.push(`- ${targetName(target)}的业务应用场景，${profileName(profile)}下总产物最小为 **${winners}：${kib(min)} KiB**；三方案最大与最小相差 ${kib(max - min)} KiB。${close}`)
    if (target === 'web') {
      const rawWinners = smallest(rows, row => row.measurement.totals.raw)
      const compressed = ['gzip', 'brotli'].map(metric => {
        const metricWinners = smallest(rows, row => row.measurement.totals[metric])
        const minimum = Math.min(...rows.map(row => row.measurement.totals[metric]))
        return `${metric === 'brotli' ? 'Brotli' : 'gzip'} 最小为 **${metricWinners.map(scheme => names[scheme]).join('、')} ${kib(minimum)} KiB**（${equalNames(rawWinners, metricWinners) ? '与 raw 最小方案一致' : '与 raw 最小方案不同'}）`
      })
      lines.push(`- H5 ${profileName(profile)}的业务应用传输参考：${compressed.join('；')}。raw 与压缩的排序取决于字符串、声明和代码的可压缩性，应按实际交付方式选指标。`)
    }
    for (const scenario of ['gallery', 'application']) {
      const candidates = actualSchemes.map(scheme => select(report, scheme, profile, scenario, target))
      if (!equalNames(smallest(candidates, row => row.measurement.byKind.style.raw), smallest(candidates, row => row.measurement.totals.raw))) mismatched++
    }
  }
  const panda = targets.flatMap(target => ['gallery', 'application'].map(scenario => {
    const standard = select(report, 'panda', 'standard', scenario, target).measurement
    const optimized = select(report, 'panda', 'optimized', scenario, target).measurement
    return { target, scenario, saving: standard.totals.raw - optimized.totals.raw, fraction: (standard.totals.raw - optimized.totals.raw) / standard.totals.raw * 100 }
  })).sort((left, right) => right.fraction - left.fraction)
  const best = panda[0]
  lines.push(`- Panda 类名哈希优化在四个展示/业务应用组合中的总产物变化范围为 ${kib(Math.min(...panda.map(row => row.saving)))}～${kib(Math.max(...panda.map(row => row.saving)))} KiB；相对降幅最大为 ${targetName(best.target)} ${best.scenario} 的 ${best.fraction.toFixed(2)}%。负值表示优化配置体积增加，详见下表。`)
  const growth = []
  for (const target of targets) for (const profile of profiles) for (const scheme of actualSchemes) {
    const change = mode => select(report, scheme, profile, `${mode}-1000`, target).measurement.totals.raw - select(report, scheme, profile, `${mode}-10`, target).measurement.totals.raw
    growth.push({ reuse: change('reuse'), unique: change('unique') })
  }
  lines.push(`- 规模由 10 增至 1000，三方案各目标/配置的总量增长：复用场景 ${kib(Math.min(...growth.map(row => row.reuse)))}～${kib(Math.max(...growth.map(row => row.reuse)))} KiB，独立样式场景 ${kib(Math.min(...growth.map(row => row.unique)))}～${kib(Math.max(...growth.map(row => row.unique)))} KiB。增长同时包含节点、模板和绑定数据，不能全归为样式增长。`)
  lines.push(`- gallery/application 共 8 个目标/配置/场景组合中，样式最小方案与总量最小方案${mismatched ? `有 **${mismatched} 组不一致**` : '全部一致'}；完整分项仍需一起比较。gallery 是较小能力集合的集成成本参照，application 增加业务结构；二者不是只改变样式条目的数学固定成本实验。`)
  lines.push('- 排名仅适用于本仓库锁定版本、场景和构建参数。原始数据包含手写 CSS 与无样式基线，适合复核总量和集成成本。')
  return lines
}

export function pandaTable(report) {
  const rows = targets.flatMap(target => ['gallery', 'application'].map(scenario => {
    const standard = select(report, 'panda', 'standard', scenario, target).measurement
    const optimized = select(report, 'panda', 'optimized', scenario, target).measurement
    const saved = standard.totals.raw - optimized.totals.raw
    return [targetName(target), scenario, kib(standard.totals.raw), kib(optimized.totals.raw), delta(saved), `${(saved / standard.totals.raw * 100).toFixed(2)}%`, delta(standard.byKind.style.raw - optimized.byKind.style.raw)]
  }))
  return table(['目标', '场景', '常规总量', '优化总量', '节省 raw', '节省比例', '节省样式'], rows)
}

export function overheadTable(report) {
  const rows = targets.flatMap(target => profiles.flatMap(profile => actualSchemes.map(scheme => {
    const overhead = scenario => select(report, scheme, profile, scenario, target).measurement.totals.raw - select(report, 'unstyled', profile, scenario, target).measurement.totals.raw
    return [targetName(target), profileName(profile), names[scheme], delta(overhead('gallery')), delta(overhead('application'))]
  })))
  return table(['目标', '配置', '方案', 'gallery Δ 无样式', 'application Δ 无样式'], rows)
}

export function growthTable(report) {
  const rows = targets.flatMap(target => profiles.flatMap(profile => actualSchemes.map(scheme => {
    const growth = (mode, metric) => {
      const value = count => select(report, scheme, profile, `${mode}-${count}`, target).measurement
      return metric === 'style' ? value(1000).byKind.style.raw - value(10).byKind.style.raw : value(1000).totals.raw - value(10).totals.raw
    }
    return [targetName(target), profileName(profile), names[scheme], delta(growth('reuse', 'total')), delta(growth('reuse', 'style')), delta(growth('unique', 'total')), delta(growth('unique', 'style'))]
  })))
  return table(['目标', '配置', '方案', '复用总量增长', '复用样式增长', '独立总量增长', '独立样式增长'], rows)
}

export function minificationTable(report) {
  const rows = report.rows.filter(row => row.target === 'weapp' && actualSchemes.includes(row.scheme) && ['gallery', 'application'].includes(row.scenario)).map(row => {
    const value = row.cssMinification
    return [profileName(row.profile), row.scenario, names[row.scheme], kib(value.before), kib(value.after), kib(value.before - value.after)]
  })
  return table(['配置', '场景', '方案', '压缩前 WXSS', '最终 WXSS', '统一压缩减少'], rows)
}
