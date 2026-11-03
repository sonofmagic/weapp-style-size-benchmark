import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest } from '../measure/index.mjs'
import { inputFingerprint } from '../build/environment.mjs'
import { pageFilesCsv, pageRowsCsv } from './page-growth.mjs'

const COUNTS = [1, 5, 10, 20, 50]
const SCHEMES = ['tailwind', 'panda', 'stylex']
const TARGETS = ['weapp', 'web']
const MODES = ['reuse', 'unique']
const KINDS = ['style', 'script', 'template', 'json', 'asset']
const METRICS = ['raw', 'gzip', 'brotli']
const names = { tailwind: 'Tailwind', panda: 'Panda', stylex: 'StyleX', weapp: '微信原生', web: 'H5', reuse: '跨页复用', unique: '逐页独特' }
const key = row => [row.scheme, row.target, row.mode, row.pageCount].join('/')
const evidenceKey = row => `${row.scheme}/standard/${row.scenario}/${row.target}`
const route = index => `/pages/bench-page-${String(index).padStart(3, '0')}/index`
const kib = bytes => (bytes / 1024).toFixed(2)
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n')
const expectedKeys = () => new Set(SCHEMES.flatMap(scheme => TARGETS.flatMap(target => MODES.flatMap(mode => COUNTS.map(pageCount => key({ scheme, target, mode, pageCount }))))))

function checkFiles(row) {
  const id = key(row)
  const measurement = row.measurement
  assert.ok(measurement?.files?.length, `${id}: missing physical files`)
  const packages = row.target === 'weapp' ? ['main'] : ['web']
  assert.deepEqual(Object.keys(measurement.byPackage).sort(), packages, `${id}: expected one package`)
  for (const file of measurement.files) {
    assert.ok(typeof file.path === 'string' && file.path && !file.path.startsWith('/') && !file.path.split('/').some(part => !part || part === '..' || part === '.'), `${id}: invalid physical path`)
    assert.ok(KINDS.includes(file.kind), `${id}: invalid file kind`)
    assert.equal(file.package, packages[0], `${id}: invalid package`)
    assert.match(file.sha256, /^[a-f0-9]{64}$/, `${id}: invalid file SHA-256`)
    for (const metric of METRICS) assert.ok(Number.isSafeInteger(file[metric]) && file[metric] >= 0, `${id}: invalid file ${metric}`)
  }
  for (const metric of METRICS) {
    const sum = files => files.reduce((total, file) => total + file[metric], 0)
    assert.equal(measurement.totals[metric], sum(measurement.files), `${id}: ${metric} total differs from physical files`)
    for (const kind of KINDS) {
      const files = measurement.files.filter(file => file.kind === kind)
      assert.equal(measurement.byKind[kind]?.[metric], sum(files), `${id}: ${kind}/${metric} subtotal differs`)
      assert.equal(measurement.byKind[kind]?.files, files.length, `${id}: ${kind} file count differs`)
    }
    assert.equal(measurement.byPackage[packages[0]][metric], sum(measurement.files), `${id}: package/${metric} subtotal differs`)
  }
  assert.equal(measurement.byPackage[packages[0]].files, measurement.files.length, `${id}: package file count differs`)
  assert.equal(row.roundManifests?.length, 2, `${id}: expected two clean builds`)
  const current = manifest(measurement)
  for (const round of row.roundManifests) assert.deepEqual(round, current, `${id}: build manifest differs`)
}

export function validatePageGrowthReport(report) {
  assert.equal(report.schemaVersion, 1, 'Unsupported page-growth schema')
  assert.equal(report.status, 'validated', 'Page-growth report must be validated')
  const protocol = report.protocol
  assert.equal(protocol?.buildRounds, 2, 'Expected two build rounds')
  assert.equal(protocol.production, true)
  assert.equal(protocol.minify, true)
  assert.equal(protocol.sourcemap, false)
  assert.equal(protocol.profile, 'standard')
  assert.deepEqual(protocol.pageCounts, COUNTS)
  assert.equal(protocol.nodesPerPage, 20)
  assert.equal(protocol.gzipLevel, 9)
  assert.equal(protocol.brotliQuality, 11)
  assert.equal(protocol.compressionScope, 'per-file')
  const expected = expectedKeys()
  assert.equal(report.rows?.length, expected.size, 'Expected complete 60-row page matrix')
  const rows = new Map()
  for (const row of report.rows) {
    const id = key(row)
    assert.ok(expected.has(id) && !rows.has(id), `Unexpected or duplicate page-growth row: ${id}`)
    assert.equal(row.profile, 'standard', `${id}: invalid profile`)
    assert.equal(row.scenario, `pages-${row.mode}-${String(row.pageCount).padStart(3, '0')}`, `${id}: invalid scenario`)
    assert.equal(row.nodesPerPage, 20, `${id}: invalid style probes per page`)
    assert.equal(row.styleUsePoints, row.pageCount * 20, `${id}: invalid style use count`)
    assert.equal(row.distinctStyleDefinitions, row.mode === 'reuse' ? 20 : row.pageCount * 20, `${id}: invalid definition count`)
    assert.equal(row.repeatable, true, `${id}: unstable build`)
    assert.equal(row.referenceValidation?.status, 'passed', `${id}: artifact references not validated`)
    assert.equal(row.validation?.status, 'passed', `${id}: validation not passed`)
    assert.equal(row.validation?.visual, row.target === 'web' ? 'passed' : 'not-run', `${id}: invalid visual acceptance scope`)
    checkFiles(row)
    rows.set(id, row)
  }
  for (const gate of ['headless', 'web']) {
    const validation = report.validation?.[gate]
    assert.equal(validation?.status, 'passed', `${gate} global validation not passed`)
    assert.ok(Array.isArray(validation.resources) && validation.resources.length > 0, `${gate}: missing resource lifecycle evidence`)
    assert.ok(validation.resources.every(resource => resource.closed === true), `${gate}: validation resources are not closed`)
    assert.ok(Array.isArray(validation.artifacts), `${gate}: missing validation evidence`)
    const artifacts = new Map()
    for (const artifact of validation.artifacts) {
      assert.equal(artifact.status, 'passed', `${gate}: failed artifact`)
      assert.ok(!artifacts.has(artifact.key), `${gate}: duplicate artifact evidence`)
      artifacts.set(artifact.key, artifact)
    }
    assert.equal(artifacts.size, gate === 'headless' ? 30 : 40, `${gate}: unexpected evidence matrix`)
    for (const row of rows.values()) {
      if (row.target !== (gate === 'headless' ? 'weapp' : 'web')) continue
      const artifact = artifacts.get(evidenceKey(row))
      assert.ok(artifact, `${gate}: missing evidence for ${key(row)}`)
      if (gate === 'headless') {
        assert.equal(artifact.routes.length, row.pageCount, `${key(row)}: not every native page was checked`)
        for (let index = 1; index <= row.pageCount; index++) {
          assert.ok(artifact.routes.some(item => item.path === route(index) && item.elements === 22), `${key(row)}: missing native route ${index}`)
        }
      } else {
        const indices = [...new Set([1, Math.floor((row.pageCount - 1) / 2) + 1, row.pageCount])]
        assert.equal(artifact.routes.length, indices.length * 2, `${key(row)}: incomplete H5 observations`)
        for (const index of indices) for (const width of [375, 768]) {
          const observation = artifact.routes.find(item => item.route === route(index) && item.width === width && item.state === 'initial')
          assert.ok(observation && observation.elements === 22, `${key(row)}: missing H5 route ${index}/${width}`)
          assert.match(observation.snapshotSha256, /^[a-f0-9]{64}$/)
          if (width === 375) {
            assert.ok(observation.screenshot, `${key(row)}: missing H5 screenshot`)
            assert.equal(observation.pixels?.differentPixels, 0, `${key(row)}: screenshot differs from handwritten reference`)
          }
        }
      }
    }
    if (gate === 'web') for (const mode of MODES) for (const pageCount of COUNTS) {
      const reference = artifacts.get(`reference/standard/pages-${mode}-${String(pageCount).padStart(3, '0')}/web`)
      assert.ok(reference, `web: missing handwritten reference ${mode}/${pageCount}`)
    }
  }
  return rows
}

function totalTable(rows, target, mode) {
  return table(['页面数', ...SCHEMES.map(scheme => names[scheme])], COUNTS.map(pageCount => [pageCount, ...SCHEMES.map(scheme => kib(rows.get(key({ scheme, target, mode, pageCount })).measurement.totals.raw))]))
}

function copiedStylex(rows) {
  const samples = MODES.map(mode => {
    const row = rows.get(`stylex/weapp/${mode}/50`)
    const files = row.measurement.files.filter(file => /(^|\/)stylex\.wxss$/.test(file.path))
    if (files.length !== 51 || new Set(files.map(file => file.sha256)).size !== 1) return undefined
    return { mode, size: files[0].raw, total: files.reduce((sum, file) => sum + file.raw, 0), residual: row.measurement.byKind.style.raw - files.reduce((sum, file) => sum + file.raw, 0) }
  })
  if (samples.some(sample => !sample)) return 'StyleX 的物理文件复制情况应按 [files.csv](files.csv) 审查；当前数据未满足“根目录及每页同内容 stylex.wxss”的自动识别条件。'
  return `锁定的 weapp-stylex@0.3.1 与 weapp-vite@7.7.0 组合会把全局样式并集写成根目录及每页目录下的同内容 \`stylex.wxss\`。50 页时两组均为 51 个物理副本：${samples.map(sample => `${names[sample.mode]}每份 ${sample.size.toLocaleString('en-US')} B，合计 ${kib(sample.total)} KiB，另有 ${sample.residual.toLocaleString('en-US')} B WXSS`).join('；')}。文件路径、SHA-256 与大小均可在 [files.csv](files.csv) 核对。\n\n因而本组合的原生样式成本含有 \`(页数 + 1) × 全局样式并集大小\`。复用组的并集基本固定，复制成本随页数增加；独特组的并集也随页数增加，当前采样范围内出现更陡的增长。这是该版本适配器与构建组合的实测输出行为，不代表所有 StyleX 实现都存在同样增长，也不能据此外推其他版本。`
}

export function renderPageGrowthReport(report) {
  const rows = validatePageGrowthReport(report)
  const get = (scheme, target, mode, pageCount) => rows.get(key({ scheme, target, mode, pageCount }))
  const summaries = TARGETS.flatMap(target => MODES.flatMap(mode => SCHEMES.map(scheme => {
    const first = get(scheme, target, mode, 1).measurement.totals.raw
    const last = get(scheme, target, mode, 50).measurement.totals.raw
    return [names[target], names[mode], names[scheme], kib(first), kib(last), kib(last - first), kib((last - first) / 49)]
  })))
  const breakdown = TARGETS.flatMap(target => MODES.flatMap(mode => SCHEMES.map(scheme => {
    const measurement = get(scheme, target, mode, 50).measurement
    return [names[target], names[mode], names[scheme], ...KINDS.map(kind => kib(measurement.byKind[kind].raw)), kib(measurement.totals.raw)]
  })))
  const nativeReuse = SCHEMES.map(scheme => `${names[scheme]} ${kib((get(scheme, 'weapp', 'reuse', 50).measurement.totals.raw - get(scheme, 'weapp', 'reuse', 1).measurement.totals.raw) / 49)} KiB/新增页`).join('、')
  const uniqueStylexEarly = (get('stylex', 'weapp', 'unique', 5).measurement.totals.raw - get('stylex', 'weapp', 'unique', 1).measurement.totals.raw) / 4
  const uniqueStylexLate = (get('stylex', 'weapp', 'unique', 50).measurement.totals.raw - get('stylex', 'weapp', 'unique', 20).measurement.totals.raw) / 30
  const packages = report.environment?.packages ?? {}
  return `# 页面数增长补充实验

页面变多后，总量取决于“增加多少模板与绑定代码”和“新增多少样式定义”，并受适配器如何放置样式文件影响。这里把真实页面增加到 1、5、10、20、50 页，各做两种情况；所有点均为生产构建实测，没有外推到更大页数。

![页面数与最终产物体积](page-growth.png)

[SVG 矢量图](page-growth.svg) · [WXSS/CSS 曲线 PNG](style-growth.png) · [WXSS/CSS 曲线 SVG](style-growth.svg) · [原始 JSON](results.json) · [项目 CSV](results.csv) · [逐文件 CSV](files.csv)

## 怎么读这组数据

- **跨页复用**：所有页面复用同一组 20 款探针样式。Panda、StyleX 实际从共享模块导入样式定义；Tailwind 使用静态 WXML 类。
- **逐页独特**：每增加一页就新增 20 款探针样式，数值在编译期生成。两组第 1 页相同。
- 每页有 20 个变量样式探针，另有固定标题节点与布局根节点，合计 22 个受检节点。它们是真实的独立页面和编译期声明，未用运行时列表重复充当页面增长。
- 3 套方案 × 2 个目标 × 2 种增长模式 × 5 个页面数，共 60 个项目；仅用常规生产配置，全部页面处于同一主包，未混入分包拆分因素。

总量按最终物理文件计数，不按相同内容去重。单位为 raw KiB（1 KiB = 1024 B）；生产构建启用 minify、关闭 sourcemap，原生 WXSS 再统一用 LightningCSS 压缩。gzip level 9、Brotli quality 11 的逐文件压缩求和保存在 JSON/CSV，仅供传输压缩参考，不是微信官方上传包大小。

H5 的样式可能内嵌于 JS（如 ShadowRoot 样式），因此不能只看独立 CSS 文件判断 H5 的样式成本。完整产物总量是主要指标。

## 实测总量

### 微信原生：跨页复用（raw KiB）

${totalTable(rows, 'weapp', 'reuse')}

### 微信原生：逐页独特（raw KiB）

${totalTable(rows, 'weapp', 'unique')}

### H5：跨页复用（raw KiB）

${totalTable(rows, 'web', 'reuse')}

### H5：逐页独特（raw KiB）

${totalTable(rows, 'web', 'unique')}

## 从 1 页增长到 50 页

最后一列是 \`(50 页总量 - 1 页总量) / 49\`，只描述本区间平均增量，不作为每页固定成本或超过 50 页的预测。

${table(['目标', '模式', '方案', '1 页 KiB', '50 页 KiB', '新增 KiB', '平均 KiB/新增页'], summaries)}

## 50 页分类明细（raw KiB）

按文件扩展名分类；H5 内嵌 CSS 仍计入 JS。WXS 归入脚本，WXML/HTML 归入模板。

${table(['目标', '模式', '方案', 'WXSS/CSS', 'JS/WXS', 'WXML/HTML', 'JSON', '资源', '总量'], breakdown)}

## 观察到的趋势

**复用样式时，样式库的固定成本会逐渐被摊薄，总量仍随模板、页面注册与绑定代码增长。** 微信原生复用组的 1→50 页平均新增量为 ${nativeReuse}。Tailwind 与 Panda 的共享 WXSS 在本组保持不变，但模板类名长度与实际绑定代码开销不同，因此不能只根据首屏或单页大小判断多页应用的最终总量。

**每页持续增加独特值时，还要支付新增样式规则和绑定数据的成本。** Tailwind 的原子声明仍能复用部分已有声明；Panda 的本地样式绑定随每页定义增加；StyleX 在 H5 的样式负载部分进入 JS。这些开销都保留在产物中。H5 还包含同一 weapp-vite Web renderer 的固定运行时代价，随着页面变多，各方案页面源码、模板与样式交付方式的差异逐渐体现。

**当前原生 StyleX 独特组不能用一条固定斜率直线概括。** 其总量在 1→5 页区间平均新增 ${kib(uniqueStylexEarly)} KiB/页，20→50 页区间为 ${kib(uniqueStylexLate)} KiB/页。下面的文件复制行为解释了本次曲线为什么会越来越陡。

${copiedStylex(rows)}

## 验证与边界

60 个项目均完成两次清理后的生产构建，逐文件路径与 SHA-256 一致；真实构建产物的静态引用检查通过。报告生成器要求完整矩阵、逐行通过状态、全局验证通过及清单加总一致；同时核对 JSON/CSV 一致、持久化验证记录一致、截图路径及非空文件、输入源码指纹和测试资源关闭状态。失败或缺格会拒绝生成，也不会使用旧结果填补。

- **微信原生**：headless 对每个项目的全部页面检查逻辑 WXML、类名绑定和预期节点/状态；共 ${report.validation.headless.artifacts.reduce((sum, artifact) => sum + artifact.routes.length, 0)} 个页面检查。它不提供微信原生视觉渲染证据。[headless 原始记录](evidence/headless/report.json)。
- **H5**：每个项目的首、中、末页在 375/768 px 视口与实际手写 CSS 参考产物比较计算样式、布局尺寸；375 px 保存截图并进行逐像素比对，通过的三套方案观察点均无差异。1 页项目去重后只检查该页。768 px 保留计算样式/尺寸快照摘要，没有单独保存截图。[H5 原始记录与截图索引](evidence/web/report.json)。
- **IDE**：本补充实验没有新增微信开发者工具验收，不把原基准的代表页面 IDE 证据当作 50 页实验的逐页视觉验收。

本图只覆盖上述真实页面形状、20 个样式探针/页、同一主包和锁定版本。真实业务的组件复用比例、样式独特值数量、分包布局、绑定粒度与适配器升级都会改变曲线。连线仅连接测量点，各面板纵轴独立且从 0 开始；不应按跨面板线条角度比较增长速度。

## 版本与复现

Node ${report.environment.node}、${report.environment.pnpm}；weapp-vite ${packages['weapp-vite']}；weapp-tailwindcss ${packages['weapp-tailwindcss']} + Tailwind ${packages.tailwindcss}；weapp-pandacss ${packages['weapp-pandacss']} + Panda ${packages['@pandacss/dev']}；weapp-stylex ${packages['weapp-stylex']}。详细环境、配置及双轮文件清单在 [results.json](results.json) 中。

在仓库根目录执行（使用锁定工具链）：

\`\`\`sh
corepack pnpm install --frozen-lockfile
pnpm exec node src/experiments/page-growth.mjs --concurrency=3
pnpm exec node src/experiments/validate-page-growth.mjs
pnpm exec node --test src/experiments/page-growth.test.mjs src/experiments/report-page-growth.test.mjs
pnpm exec node src/experiments/report-page-growth.mjs
pnpm exec node src/experiments/report-page-growth.mjs --check
python3 -m pip install -r src/experiments/requirements-chart.txt
python3 src/experiments/plot-page-growth.py
\`\`\`

效果验证使用后台浏览器并在结束时关闭本任务创建的 browser/server；无需启动微信 IDE。图表使用 matplotlib 与中文字体，详见绘图脚本的 \`--font\` 参数。原始测量数据、本文表格和曲线来自同一份 \`results.json\`，本补充实验独立于原有 \`pnpm bench\` 矩阵。
`
}

export async function writePageGrowthReport({ root = path.resolve(fileURLToPath(new URL('../..', import.meta.url))), check = false } = {}) {
  const directory = path.join(root, 'reports/page-growth')
  const report = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'))
  assert.deepEqual(report.environment?.inputs, await inputFingerprint(root), 'Page-growth benchmark inputs are stale; rerun the experiment')
  for (const [field, file] of [['experimentSourceSha256', 'page-growth.mjs'], ['validationSourceSha256', 'validate-page-growth.mjs']]) {
    const digest = createHash('sha256').update(await readFile(path.join(root, 'src/experiments', file))).digest('hex')
    assert.equal(report.environment[field], digest, `Page-growth ${file} fingerprint is stale; rerun its stage`)
  }
  const text = renderPageGrowthReport(report)
  for (const [file, expected] of [['results.csv', pageRowsCsv(report.rows)], ['files.csv', pageFilesCsv(report.rows)]]) {
    assert.equal(await readFile(path.join(directory, file), 'utf8'), expected, `Page-growth ${file} differs from results.json`)
  }
  for (const gate of ['headless', 'web']) {
    const { report: reportPath, ...expected } = report.validation[gate]
    assert.equal(reportPath, `reports/page-growth/evidence/${gate}/report.json`, `${gate}: unexpected evidence report path`)
    const persisted = JSON.parse(await readFile(path.join(root, reportPath), 'utf8'))
    assert.deepEqual(persisted, expected, `${gate}: persisted evidence differs from results.json`)
  }
  const evidenceDirectory = path.join(directory, 'evidence')
  const evidenceRealDirectory = await realpath(evidenceDirectory)
  const screenshots = new Set(report.validation.web.artifacts.flatMap(artifact => artifact.routes).filter(observation => observation.screenshot).map(observation => observation.screenshot))
  assert.ok(screenshots.size > 0, 'Page-growth screenshot evidence is missing')
  for (const screenshot of screenshots) {
    assert.equal(typeof screenshot, 'string', 'Invalid screenshot path')
    const absolute = path.resolve(root, screenshot)
    assert.ok(absolute.startsWith(`${evidenceDirectory}${path.sep}`), `Screenshot path is outside page-growth evidence: ${screenshot}`)
    const physical = await realpath(absolute)
    assert.ok(physical.startsWith(`${evidenceRealDirectory}${path.sep}`), `Screenshot resolves outside page-growth evidence: ${screenshot}`)
    assert.ok((await readFile(physical)).length > 0, `Screenshot evidence is empty: ${screenshot}`)
  }
  const destination = path.join(directory, 'README.md')
  if (check) assert.equal(await readFile(destination, 'utf8'), text, 'Page-growth README is stale; regenerate it from the validated results')
  else await writeFile(destination, text)
  return destination
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok(args.every(arg => arg === '--check'), 'Only --check is supported')
  writePageGrowthReport({ check: args.includes('--check') }).then(file => process.stdout.write(`${file}\n`)).catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
}
