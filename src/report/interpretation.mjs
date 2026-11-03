import { delta, kib, names, table, targetName } from './insights.mjs'

const schemes = ['tailwind', 'panda', 'stylex']
const kinds = { style: '样式文件', script: '脚本', template: '模板', json: 'JSON', asset: '资源' }
const get = (report, scheme, scenario, target) => report.rows.find(row => row.scheme === scheme && row.profile === 'standard' && row.scenario === scenario && row.target === target).measurement
const growth = (before, after, kind) => kind ? after.byKind[kind].raw - before.byKind[kind].raw : after.totals.raw - before.totals.raw

export function interpretation(report) {
  const small = []
  const scaling = []
  const explanations = []
  for (const target of ['weapp', 'web']) {
    const baseline = get(report, 'unstyled', 'reuse-10', target)
    for (const scheme of schemes) {
      const start = get(report, scheme, 'reuse-10', target)
      const repeated = get(report, scheme, 'reuse-1000', target)
      const unique = get(report, scheme, 'unique-1000', target)
      small.push([targetName(target), names[scheme], kib(baseline.totals.raw), delta(start.totals.raw - baseline.totals.raw), kib(start.byKind.style.raw), kib(start.byKind.script.raw), kib(start.byKind.template.raw)])
      scaling.push([targetName(target), names[scheme], delta(growth(start, repeated)), delta(growth(start, repeated, 'style')), delta(growth(start, repeated, 'script')), delta(growth(start, repeated, 'template')), delta(growth(repeated, unique)), delta(growth(repeated, unique, 'style')), delta(growth(repeated, unique, 'script'))])
      const dominant = Object.keys(kinds).map(kind => ({ kind, bytes: growth(start, repeated, kind) })).sort((left, right) => right.bytes - left.bytes)[0]
      const styleGrowth = growth(start, repeated, 'style')
      explanations.push(`${targetName(target)} ${names[scheme]} 的重复节点由 10 到 1000，${styleGrowth === 0 ? '样式文件字节不变，说明这一路径复用了已生成规则' : `样式文件变化 ${delta(styleGrowth)} KiB，需结合生成内容看待扫描、变量或规则增长，不能直接等同必要声明数量`}；总量增长最多来自${kinds[dominant.kind]}（${delta(dominant.bytes)} KiB）。`)
    }
  }
  const nativeScripts = schemes.map(scheme => `${names[scheme]} ${kib(get(report, scheme, 'reuse-10', 'weapp').byKind.script.raw)} KiB`).join('、')
  const nativeTemplates = schemes.map(scheme => `${names[scheme]} ${kib(get(report, scheme, 'reuse-1000', 'weapp').byKind.template.raw)} KiB`).join('、')
  const webBase = get(report, 'unstyled', 'reuse-10', 'web').totals.raw
  return [
    '## 数据如何解释', '',
    '以下使用常规生产配置解释成本来源；Panda 哈希优化见前表。小规模采用相同的 10 节点重复样式场景，Δ 无样式包含共享 reset、主题与适配器集成，属于此场景的起点成本，不能当作对所有应用恒定的运行时税。', '',
    ...table(['目标', '方案', '无样式总量', '10 节点 Δ 无样式', '样式文件', '脚本', '模板'], small), '',
    `原生 10 节点场景的完整脚本文件为 ${nativeScripts}。Tailwind 将 utility 类串直接写入模板；Panda 和 StyleX 通过脚本生成/保存类绑定与样式映射，因此“CSS 原子化”仍需同时计入脚本。这里列的是完整脚本文件，未把混合在同一文件中的业务与运行时模块精确拆开。`, '',
    `原生重复 1000 节点的模板分别为 ${nativeTemplates}。它展示了重复 class 字符串与类绑定表达式的交付成本；重复使用同一组规则，仍会增加节点和绑定描述。H5 无样式 10 节点自身已为 ${kib(webBase)} KiB，包含 Web 宿主和页面表示，比较样式方案时应同时看总量与匹配基线的增量。`, '',
    '复用与独特声明的差别：先看同一组样式从 10 个节点重复到 1000 个节点，再在相同 1000 节点规模下把复用样式替换为独特样式。后者扣除了节点数量增长，仍包含不同类名/绑定数据的交付差异。单位 KiB，正数为增长：', '',
    ...table(['目标', '方案', '复用 10→1000 总量', '其中样式', '其中脚本', '其中模板', '同规模独特−复用总量', '其中样式', '其中脚本'], scaling), '',
    ...explanations.map(value => `- ${value}`), '',
    '独特样式的 CSS 可按声明复用部分值，但每个节点仍有独特属性组合；Panda/StyleX 的 JavaScript 样式映射也可能随定义增长。表中“同规模独特−复用”的脚本、样式变化用于验证本轮具体行为，不从源语言风格直接推断体积。H5 的模板和 ShadowRoot 样式字符串可被编译进脚本，外部 CSS 很小也不表示样式负载已消失。', '',
  ]
}
