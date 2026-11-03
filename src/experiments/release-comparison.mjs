import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inputFingerprint } from '../build/environment.mjs'
import { validateReport } from '../report/validate.mjs'
import { assertEvidenceMatches, assertLatestRun, portablePaths } from '../validate/run-state.mjs'
import { validatePageGrowthReport, writePageGrowthReport } from './report-page-growth.mjs'

const HISTORY_PATH = 'reports/history/2026-11-03-before-refresh.json'
const HISTORY_SHA256 = '4e530d93519b69172c01c30c8d2739771d53727af267db2af44328b05219fcb8'
const KINDS = ['style', 'script', 'template', 'json', 'asset']
const METRICS = ['raw', 'gzip', 'brotli']
const identity = row => [row.scheme, row.profile, row.scenario, row.target].join('/')
const names = { tailwind: 'Tailwind', panda: 'Panda', stylex: 'StyleX', reference: '手写 CSS', unstyled: '无样式', weapp: '微信', web: 'H5', standard: '常规', optimized: '优化', reuse: '跨页复用', unique: '逐页独特' }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n')
const kib = bytes => (bytes / 1024).toFixed(2)
const delta = bytes => `${bytes > 0 ? '+' : ''}${kib(bytes)}`
const compact = row => ({ scheme: row.scheme, profile: row.profile, scenario: row.scenario, target: row.target, ...(row.mode ? { mode: row.mode, pageCount: row.pageCount } : {}), totals: row.measurement.totals, byKind: row.measurement.byKind, byPackage: row.measurement.byPackage, physicalFiles: row.measurement.files.length, stylexFiles: row.measurement.files.filter(file => /stylex[^/]*\.wxss$/.test(file.path)).map(({ path, raw, sha256 }) => ({ path, raw, sha256 })) })

export function compareRows(beforeRows, afterRows, dataset) {
  const map = rows => {
    const result = new Map()
    for (const row of rows) {
      const key = identity(row)
      assert.ok(!result.has(key), `${dataset}: duplicate comparison row ${key}`)
      for (const metric of METRICS) {
        assert.ok(Number.isSafeInteger(row.totals?.[metric]) && row.totals[metric] >= 0, `${key}: invalid ${metric}`)
        assert.equal(KINDS.reduce((sum, kind) => sum + row.byKind[kind][metric], 0), row.totals[metric], `${key}: kind totals differ`)
      }
      result.set(key, row)
    }
    return result
  }
  const before = map(beforeRows), after = map(afterRows)
  assert.deepEqual([...before.keys()].sort(), [...after.keys()].sort(), `${dataset}: comparison matrices differ`)
  return [...before].map(([key, old]) => {
    const current = after.get(key)
    const difference = part => Object.fromEntries(METRICS.map(metric => [metric, current[part][metric] - old[part][metric]]))
    return { dataset, key, scheme: old.scheme, profile: old.profile, scenario: old.scenario, target: old.target, ...(old.mode ? { mode: old.mode, pageCount: old.pageCount } : {}), before: old, after: current, delta: { totals: difference('totals'), byKind: Object.fromEntries(KINDS.map(kind => [kind, Object.fromEntries(METRICS.map(metric => [metric, current.byKind[kind][metric] - old.byKind[kind][metric]]))])) } }
  })
}

export async function validateCurrentComparisonInputs(root, main, pages) {
  const fingerprint = await inputFingerprint(root)
  for (const [name, report] of Object.entries({ main, pages })) assert.deepEqual(report.environment?.inputs, fingerprint, `${name}: build inputs are stale`)
  assert.deepEqual(main.environment.packages, pages.environment.packages, 'Main and page-growth dependency versions differ')
  for (const [field, file] of [['experimentSourceSha256', 'page-growth.mjs'], ['validationSourceSha256', 'validate-page-growth.mjs']]) {
    assert.equal(pages.environment[field], sha256(await readFile(path.join(root, 'src/experiments', file))), `Page-growth ${file} is stale`)
  }
}

export function compareReleases(baseline, main, pages) {
  validateReport(main)
  validatePageGrowthReport(pages)
  assert.equal(baseline.schemaVersion, 1, 'Unsupported historical baseline')
  assert.equal(baseline.datasets.main.rows.length, 160, 'Incomplete historical main matrix')
  assert.equal(baseline.datasets.pages.rows.length, 60, 'Incomplete historical page matrix')
  for (const [name, report] of Object.entries({ main, pages })) {
    assert.notEqual(report.environment.inputs.sha256, baseline.datasets[name].environment.inputs.sha256, 'The historical run cannot be presented as a refresh')
    const fixtures = environment => environment.inputs.files.filter(file => file.path.startsWith('src/fixtures/'))
    assert.deepEqual(fixtures(report.environment), fixtures(baseline.datasets[name].environment), `${name}: scenario fixtures changed; this comparison requires unchanged fixtures`)
    for (const field of ['buildRounds', 'production', 'minify', 'sourcemap', 'gzipLevel', 'brotliQuality', 'compressionScope']) assert.deepEqual(report.protocol[field], baseline.datasets[name].protocol[field], `${name}: measurement protocol changed: ${field}`)
  }
  assert.equal(pages.environment.experimentSourceSha256, baseline.datasets.pages.environment.experimentSourceSha256, 'Page-growth scenario generator changed')
  return {
    schemaVersion: 1, status: 'validated', baseline: { path: HISTORY_PATH, sha256: HISTORY_SHA256, sourceCommit: baseline.sourceCommit, datasets: Object.fromEntries(Object.entries(baseline.datasets).map(([name, data]) => [name, { path: data.path, url: data.url, sourceSha256: data.sourceSha256, environment: data.environment }])) },
    current: { main: main.environment, pages: pages.environment },
    scope: 'Complete dependency-set refresh with unchanged scenario fixtures; differences are not a single-package causal experiment. Native WXSS uses physical-file accounting. H5 CSS embedded in JS is counted as script.',
    rows: [...compareRows(baseline.datasets.main.rows, main.rows.map(compact), 'main'), ...compareRows(baseline.datasets.pages.rows, pages.rows.map(compact), 'pages')],
  }
}

export function comparisonCsv(report) {
  const header = ['dataset', 'scheme', 'profile', 'scenario', 'target', 'pageCount', ...['total', ...KINDS].flatMap(kind => METRICS.flatMap(metric => ['before', 'after', 'delta'].map(stage => `${kind}_${metric}_${stage}`)))]
  const rows = report.rows.map(row => [row.dataset, row.scheme, row.profile, row.scenario, row.target, row.pageCount ?? '', ...['total', ...KINDS].flatMap(kind => METRICS.flatMap(metric => [kind === 'total' ? row.before.totals[metric] : row.before.byKind[kind][metric], kind === 'total' ? row.after.totals[metric] : row.after.byKind[kind][metric], kind === 'total' ? row.delta.totals[metric] : row.delta.byKind[kind][metric]]))])
  return [header, ...rows].map(row => row.join(',')).join('\n') + '\n'
}

export function comparisonMarkdown(report) {
  const old = report.baseline.datasets.main.environment, current = report.current.main
  const versions = [...new Set([...Object.keys(old.packages), ...Object.keys(current.packages)])].sort().map(name => [name, old.packages[name] ?? '—', current.packages[name] ?? '—'])
  const show = report.rows.filter(row => row.dataset === 'main' && ['gallery', 'application'].includes(row.scenario) && ['tailwind', 'panda', 'stylex'].includes(row.scheme))
  const pages = report.rows.filter(row => row.dataset === 'pages' && [20, 50].includes(row.pageCount))
  const sizeRows = rows => rows.map(row => [names[row.target], names[row.scheme], row.pageCount ? `${names[row.mode]} ${row.pageCount} 页` : `${names[row.profile]} ${row.scenario}`, kib(row.before.totals.raw), kib(row.after.totals.raw), delta(row.delta.totals.raw), delta(row.delta.byKind.style.raw), delta(row.delta.byKind.script.raw), delta(row.delta.byKind.template.raw)])
  const stylex = report.rows.filter(row => row.dataset === 'pages' && row.target === 'weapp' && row.scheme === 'stylex' && row.pageCount === 50)
  return `# 最新稳定版本与上一版报告对比

本轮将依赖整组升级后重新构建，主矩阵 160 格、页面增长实验 60 格均与固定历史提交逐格匹配。当前完整结果分别见 [主报告](../../README.md) 与 [页面增长报告](../page-growth/README.md)；[全部差值 JSON](results.json) 和 [CSV](results.csv) 保留 220 格的 raw、gzip、Brotli 及各分类变化。

**差值表示整组升级的效果，不能单独归因于 weapp-stylex。** 宿主、底层编译器和其他适配器的升级也可能改变 JS、模板、样式及压缩结果。场景结构、设计 tokens、使用点和物理文件计数口径保持一致；压缩值仍是逐文件参考值，不是微信官方上传包大小。H5 的 ShadowRoot 样式可能内嵌于 JS，独立 CSS 列不能表示其全部样式成本。

效果工具也已更新：Pixelmatch 7 → 8 将颜色差异度量从 YIQ 改为 OKLab/HyAB。所有截图和效果证据均重新采集，\`threshold: 0.1\` 与 \`includeAA: false\` 保持原设置；跨版本像素差异计数不作为视觉改善的因果证据。

## 历史数据来源

历史提交为 [${report.baseline.sourceCommit.slice(0, 7)}](https://github.com/sonofmagic/weapp-style-size-benchmark/tree/${report.baseline.sourceCommit})。历史 [160 格完整数据](${report.baseline.datasets.main.url})、[60 格页面数据](${report.baseline.datasets.pages.url}) 与原截图仍保存在该提交；仓库另保留 [紧凑指标基线](../history/2026-11-03-before-refresh.json)，包含环境、原始数值、来源文件 SHA-256 和 StyleX 命名 WXSS 的物理文件记录。该基线不用于补填本轮缺失或失败数据。

历史输入指纹：\`${old.inputs.sha256}\`；当前输入指纹：\`${current.inputs.sha256}\`。Node 为 ${old.node} → ${current.node}，包管理器为 ${old.pnpm} → ${current.pnpm}。

## 依赖版本

${table(['依赖', '上一版', '本轮'], versions)}

## 展示页与业务应用

单位 KiB；Δ 为本轮减上一版，负值表示减少。分类 Δ 全部按物理扩展名计数。

${table(['目标', '方案', '配置/场景', '旧总量', '新总量', 'Δ 总量', 'Δ 样式', 'Δ 脚本', 'Δ 模板'], sizeRows(show))}

## 20 / 50 页增长点

${table(['目标', '方案', '模式/页数', '旧总量', '新总量', 'Δ 总量', 'Δ 样式', 'Δ 脚本', 'Δ 模板'], sizeRows(pages))}

## StyleX 原生共享样式的物理输出

${table(['50 页模式', '旧 StyleX 文件数', '新 StyleX 文件数', '旧全部 WXSS KiB', '新全部 WXSS KiB', 'WXSS 减少比例'], stylex.map(row => [names[row.mode], row.before.stylexFiles.length, row.after.stylexFiles.length, kib(row.before.byKind.style.raw), kib(row.after.byKind.style.raw), row.before.byKind.style.raw ? `${((row.before.byKind.style.raw - row.after.byKind.style.raw) / row.before.byKind.style.raw * 100).toFixed(2)}%` : '—']))}

StyleX 文件按末尾 \`stylex*.wxss\` 命名识别；样式体积列包含全部 WXSS，因此页面导入包装与其他样式不会漏算。新旧具体路径、字节与 SHA-256 随对比 JSON 保存；最新全部物理文件可在 [页面增长 files.csv](../page-growth/files.csv) 检查。文件数变化与静态引用检查共同说明交付布局发生了什么，不能将同内容文件先去重再计量，也不能由本表声称所有增长只来自同一个根因。

## 验证与复现

生成器要求两份当前报告都通过完整矩阵、双构建、必要效果门禁与清单加总检查；同时核对当前输入指纹、页面实验/验证源码指纹、持久化证据和历史基线摘要。失败、缺格、混用依赖或使用旧结果会拒绝生成。微信 IDE 状态沿用主报告的独立披露；页面增长实验没有新增 IDE 视觉验收。

两份当前报告生成并检查完成后执行：

\`\`\`sh
pnpm exec node src/experiments/release-comparison.mjs
pnpm exec node src/experiments/release-comparison.mjs --check
\`\`\`
`
}

export async function writeReleaseComparison({ root = path.resolve(fileURLToPath(new URL('../..', import.meta.url))), check = false } = {}) {
  const directory = path.join(root, 'reports/release-comparison')
  if (!check) {
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'results.json'), '{"status":"generating"}\n')
    for (const file of ['README.md', 'results.csv']) await rm(path.join(directory, file), { force: true })
  }
  try {
    const baselineBytes = await readFile(path.join(root, HISTORY_PATH))
    assert.equal(sha256(baselineBytes), HISTORY_SHA256, 'Historical baseline digest changed')
    const baseline = JSON.parse(baselineBytes)
    const main = JSON.parse(await readFile(path.join(root, 'reports/results.json'), 'utf8'))
    const pages = JSON.parse(await readFile(path.join(root, 'reports/page-growth/results.json'), 'utf8'))
    await validateCurrentComparisonInputs(root, main, pages)
    await assertEvidenceMatches(main, { root, transform: value => portablePaths(value, root) })
    await writePageGrowthReport({ root, check: true })
    try { assertLatestRun(main, JSON.parse(await readFile(path.join(root, '.bench/run.json'), 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const report = compareReleases(baseline, main, pages)
    const outputs = { 'results.json': `${JSON.stringify(report, null, 2)}\n`, 'results.csv': comparisonCsv(report), 'README.md': comparisonMarkdown(report) }
    for (const [file, content] of Object.entries(outputs)) {
      const destination = path.join(directory, file)
      if (check) assert.equal(await readFile(destination, 'utf8'), content, `Release comparison ${file} is stale`)
      else await writeFile(destination, content)
    }
    return report
  } catch (error) {
    if (!check) await writeFile(path.join(directory, 'results.json'), `${JSON.stringify({ status: 'failed', error: String(error.stack ?? error) }, null, 2)}\n`)
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok(args.every(arg => arg === '--check'), 'Only --check is supported')
  writeReleaseComparison({ check: args.includes('--check') }).then(report => process.stdout.write(`Release comparison: ${report.rows.length} validated rows.\n`)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
