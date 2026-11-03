import { passed } from './validate.mjs'
import { conclusions, delta, growthTable, kib, minificationTable, names, overheadTable, pandaTable, profileName, table, targetName } from './insights.mjs'
import { environmentSummary, protocolSummary, screenshotMarkdown } from './metadata.mjs'
import { interpretation } from './interpretation.mjs'
const safe = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

function evidenceLinks(gate) {
  const paths = [gate?.path, gate?.report, gate?.evidence, ...(gate?.artifacts ?? [])].flat().filter(value => typeof value === 'string')
  return [...new Set(paths)].map(value => `[${safe(value)}](${value.replaceAll(' ', '%20')})`).join('、') || '见 results.json 中 validation 的完整记录'
}

export function readme(report, reportPrefix = 'reports', readmeDirectory = '.') {
  const pick = (row, scheme) => report.rows.find(item => item.target === row.target && item.profile === row.profile && item.scenario === row.scenario && item.scheme === scheme)
  const showcase = report.rows.filter(row => ['gallery', 'application'].includes(row.scenario))
  const summary = showcase.map(row => {
    const m = row.measurement
    return [targetName(row.target), profileName(row.profile), row.scenario, names[row.scheme], kib(m.totals.raw), kib(m.byKind.style.raw), kib(m.byKind.script.raw), kib(m.byKind.template.raw), kib(m.byKind.json.raw), kib(m.byKind.asset.raw), delta(m.totals.raw - pick(row, 'unstyled').measurement.totals.raw), delta(m.totals.raw - pick(row, 'reference').measurement.totals.raw)]
  })
  const packages = showcase.filter(row => row.target === 'weapp').flatMap(row => Object.entries(row.measurement.byPackage).map(([name, value]) => [profileName(row.profile), row.scenario, names[row.scheme], name, kib(value.raw), kib(value.gzip), kib(value.brotli)]))
  const transmission = showcase.filter(row => row.target === 'web').map(row => [profileName(row.profile), row.scenario, names[row.scheme], kib(row.measurement.totals.raw), kib(row.measurement.totals.gzip), kib(row.measurement.totals.brotli)])
  const packageVersions = report.environment.packages ?? {}
  const version = name => packageVersions[name] ?? '未记录'
  const ide = passed(report.validation.ide)
  const nativeRecords = report.validation.ide?.artifacts ?? []
  const sdkVersions = [...new Set(nativeRecords.map(row => row.toolInfo?.SDKVersion).filter(Boolean))]
  const nativeWidths = [...new Set(nativeRecords.map(row => row.systemInfo?.windowWidth).filter(Boolean))]
  const nativeScreenshot = nativeRecords.find(row => row.key === 'tailwind/standard/gallery/weapp')?.routes?.find(route => route.screenshot)?.screenshot
  const excluded = [...new Set(report.rows.flatMap(row => row.measurement.excluded.map(file => `${file.path}（${file.reason}）`)))]
  return [
    '# 小程序样式方案产物体积对比', '',
    '对比 weapp-tailwindcss、weapp-pandacss、weapp-stylex 在原生微信小程序与 H5 中实现相同布局和交互状态的最终产物体积，同时保留手写 CSS 参考和无样式基线。数据由真实生产构建生成，README 表格与曲线均来自同一份报告。', '',
    `本轮使用 weapp-tailwindcss ${version('weapp-tailwindcss')}、weapp-pandacss ${version('weapp-pandacss')}、weapp-stylex ${version('weapp-stylex')}，宿主为 weapp-vite ${version('weapp-vite')}。[官方稳定版本核对记录](${reportPrefix}/version-refresh/latest-versions.json)与[上一版报告对比](${reportPrefix}/release-comparison/README.md)单独保存。`, '',
    '## 本次结论', '', ...conclusions(report), '',
    `当前矩阵共 ${report.rows.length} 格，全部通过两次独立生产构建一致性检查。H5 与 headless 校验通过；微信 IDE 验证${ide ? '已通过' : '**待完成**，当前不能把 H5/headless 结果表述为微信真机或 IDE 布局等效证明'}。`, '',
    '## 如何复跑', '', '```sh', 'corepack pnpm install --frozen-lockfile', 'corepack pnpm exec playwright install chromium', 'corepack pnpm test', 'corepack pnpm bench', 'corepack pnpm report:check', '```', '',
    `Node.js ${report.environment.node}，${report.environment.pnpm}。以提交中的 lockfile 为依赖版本来源。IDE 验证需在安装并登录微信开发者工具的本机单独执行，不由 GitHub CI 代替。`, '',
    '`pnpm bench` 一键完成全矩阵构建、headless/H5 等效校验、测量和报告；默认不启动微信 IDE。调试时可以分步执行，后续命令消费 `.bench/run.json` 中当前已构建状态，不会自动沿用更早一次的成功报告：', '',
    '```sh',
    'corepack pnpm bench:build        # 清理后构建全矩阵，每格两轮',
    'corepack pnpm test:equivalence   # 消费已构建状态，运行 headless 与 H5 校验',
    'corepack pnpm bench:measure      # 核对当前产物仍与已测量清单一致',
    'corepack pnpm bench:report       # 全部必要校验通过后生成 README / JSON / CSV / SVG',
    '```', '',
    '微信 IDE 校验在上述完整构建与校验之后执行。将 CLI 路径改为本机安装位置；当前默认测试 AppID 为 `wxb3d842a4a7e3440d`，也可设置为自己有权限使用的 AppID：', '',
    '```sh',
    "export WEAPP_VITE_E2E_DEVTOOLS_CLI_PATH='/Applications/wechatwebdevtools.app/Contents/MacOS/cli'",
    "export BENCHMARK_WECHAT_APPID='wxb3d842a4a7e3440d'",
    'corepack pnpm test:ide',
    '',
    '# 或从头重建，并把本机 IDE 校验合并到本轮完整流程',
    'BENCHMARK_RUN_IDE=1 corepack pnpm bench',
    '```', '',
    '## 场景与源码', '',
    ...table(['场景', '共同内容', '观察目标'], [
      ['gallery', '布局、间距、排版、边框、阴影、渐变、640px 媒体查询、主题、条件状态、variants/compound variants、slots、动态宽度/间距/颜色、rpx', '较小能力集合的集成成本与效果等价'],
      ['application', '首页、列表、详情、设置；共享 metric 组件；package 普通分包与 independent 独立分包', '共享样式、组件绑定、物理文件复制与各包体积'],
      ['reuse-10/100/1000', '在源码中写出 N 个节点，重复同一份样式定义', '声明复用后，模板和绑定随使用点增长的成本'],
      ['unique-10/100/1000', '在源码中写出 N 个节点与独特属性组合，颜色唯一，其他数值部分复用', '独特声明增长与原子规则的部分复用'],
    ]), '',
    '共享规格与设计 tokens 位于 `src/fixtures/spec.mjs`，WXML 和各方案惯用 API 由 `src/fixtures/` 生成。构建后可在 `.bench/fixtures/<scheme>/<profile>/<scenario>/<target>/src/` 查看完整原生源码，在对应 `dist/`（H5 为 `dist/web/`）查看产物。规模场景没有用运行时列表重复冒充编译期使用点；节点和动作 ID 使用不会被 Tailwind 误识别为 utility 的前缀，并有真实编译器回归测试。', '',
    '## 对比方法', '',
    '- 五组实现：三种样式方案、手写 CSS 参考、无样式基线。两种配置、八个场景、两个目标，共 160 格。无样式基线保持同一内容结构与业务逻辑，仅移除样式，供观察增量。',
    '- `gallery` 覆盖样式能力展示，`application` 覆盖完整业务页面；`reuse-10/100/1000` 观察重复使用相同样式的增长，`unique-10/100/1000` 观察独立样式的增长。场景数据和预期效果共用契约。',
    '- 常规生产使用各方案正常生产构建；优化配置仅为 Panda 开启 `hash: { className: true }`。StyleX 两档均保留默认生产 hash；Tailwind 没有对应的内置类名压缩开关，两档配置相同。不引入 tailwindcss-mangle。',
    `- 宿主统一使用 \`weapp-vite@${version('weapp-vite')}\`：微信 Tailwind 走宿主内置 \`weapp.tailwindcss\`（锁定 \`weapp-tailwindcss@${version('weapp-tailwindcss')}\`），H5 走官方 \`weapp-tailwindcss/postcss\`，配置 \`generator: { target: 'web', webCompat: true }\`；Panda 使用 PostCSS 适配器，StyleX 走 \`createStylex()\` 的 Vite 与 compiler 两个入口。Tailwind/Panda 全局样式均由 \`app.css\` 顶部 \`@import\` 进入原生样式引用图，以传递到 H5 页面的 ShadowRoot；不通过 App 脚本单独导入框架样式。`,
    '- 三套样式方案及手写 CSS 共享显式 reset，关闭各框架 preflight；无样式基线不含 reset。Panda 仍使用官方 preset-base/preset-panda。构建实际保留的默认 token、变量、兼容 CSS 与运行时代码全部计量，不为缩小某方案单独删减。',
    '- H5 为 Panda 开启官方 Web layer polyfill（`polyfill: true`）；两端 Panda 均使用 `cssVarRoot: \'.theme-light, .theme-dark\'`，让 token 声明落在已有主题根节点。Tailwind 的 H5 `webCompat: true` 处理 layer 与宿主默认样式优先级；这些配置均通过浏览器计算样式验证。',
    `- 本轮像素比较使用 \`pixelmatch@${version('pixelmatch')}\`，保留 \`threshold: 0.1\` 与 \`includeAA: false\`。历史报告使用的 Pixelmatch 7 与本轮 8 的颜色差异度量不同（YIQ → OKLab/HyAB）；截图和效果证据全部重采，不能把跨工具版本的像素差异计数直接解读为视觉改善。`,
    '- 微信 IDE 先在手写 CSS 参考产物上校准宿主的 rpx 取整（与理论值偏差须小于 1 CSS px），保存设备、基础库及参考文件哈希；三套方案随后在同设备、同基础库下，以 0.1px 容差严格匹配校准结果。其余样式直接检查规格预期，校准证据保存在 IDE 报告的 `calibrations`。',
    '- 宿主配置统一设 `emptyOutDir: false`，由基准程序在每轮开始前清理整个输出目录，避免主包构建清掉适配器在独立分包子构建中生成的样式。不会在构建结束后手工补回缺失规则。',
    `- 原生适配器在 Vite CSS 压缩之后仍可能写入 WXSS，不同格式化方式会影响 raw 排名。因此每轮原生构建后，对所有方案的最终 WXSS 统一使用 \`lightningcss@${version('lightningcss')}\` 执行 \`minify: true\`，然后才采集、校验重复性。H5 使用 Vite 的统一生产压缩。本文排名对应此最终部署产物，**不是未经统一压缩的适配器裸输出**；原生压缩前/后每个文件的字节均保存于 \`row.cssMinification\`。`,
    '- 每格清理产物后生产构建两次，校验最终文件路径和 SHA-256 一致，并检查 JS 模块、CSS 导入、WXML/WXS、页面/组件配置与独立分包的静态引用完整性。独立分包的静态引用不得越出自身目录；完整证据保存在每格 `referenceValidation`。不会用缓存报告填补失败或缺失格。度量包括最终脚本、模板、样式、JSON 和资源；WXS 归入脚本。',
    '- 微信主包与分包从最终 `app.json` 划定。每个物理路径计一次，同内容复制到不同路径仍分别计量；共享文件归实际所在包，不分摊给页面。',
    '- raw 是最终部署文件原始字节之和；gzip 固定 level 9、Brotli 固定 quality 11，逐文件压缩后求和。压缩值可供 H5 传输参考，**不等于微信官方上传包体积**。1 KiB = 1024 字节。',
    '- Δ 无样式、Δ 手写均为匹配目标、配置和场景的总产物差值，允许负数。差值包含模板绑定、业务集成、生成代码和共享文件变化，不能归因为精确的纯样式运行时成本。', '',
    '## 页面产物对照', '', '单位：KiB，使用最终部署文件总量。分类按物理文件扩展名：H5 ShadowRoot 的 CSS 字符串可能内嵌于脚本，计入脚本列，不能把外部样式文件列当作全部 CSS 负载。当前样例未引入外部图片、字体等资源。完整 160 格及逐文件数据见下方 JSON/CSV。', '',
    ...table(['目标', '配置', '场景', '方案', '总量', '样式文件', '脚本', '模板', 'JSON', '资源', 'Δ 无样式', 'Δ 手写'], summary), '',
    '## Panda 类名哈希的实际收益', '', '单位：KiB。节省值为常规生产减去优化配置，正数表示体积减少，负数表示增加；比例以常规总量为分母。', '', ...pandaTable(report), '',
    '## 展示页与业务应用的集成成本', '', '单位：KiB，相对各自无样式基线。gallery 展示样式能力，application 包含业务结构、主题和分包；不能把 gallery 的数值直接当作所有应用的固定开销。', '', ...overheadTable(report), '',
    '## 原生 WXSS 的统一压缩', '', '单位：KiB，涵盖每个场景全部物理 WXSS 文件。压缩前为适配器写入磁盘的样式，最终值为统一 Lightning CSS 处理后的样式；不做内容去重。总产物与分类表使用最终值，H5 不重复执行此步骤。', '', ...minificationTable(report), '',
    '## 微信主包与分包', '', ...table(['配置', '场景', '方案', '包', 'raw', 'gzip', 'Brotli'], packages), '',
    '## H5 压缩参考', '', ...table(['配置', '场景', '方案', 'raw', 'gzip', 'Brotli'], transmission), '',
    '## 规模增长', '', `![复用与独立样式的产物规模曲线](${reportPrefix}/scaling.svg)`, '',
    '曲线使用最终部署文件总量，各面板有独立纵轴。横轴规模 10、100、1000 使用等距对数刻度；可通过 SVG 中的点查看精确值，完整数字保存在 CSV。', '',
    '以下为规模 10 → 1000 的原始字节增量（KiB），总量和样式分别列出：', '', ...growthTable(report), '',
    '## 页面数量增长补充实验', '',
    `另有 [1 / 5 / 10 / 20 / 50 个真实页面的实测报告](${reportPrefix}/page-growth/README.md)，分别观察跨页共享样式与每页新增样式。每页包含 20 个样式探针，另有固定标题和布局；全部页面位于同一主包，使用常规生产配置。该横轴表示实际路由数量，与上方单页内使用点数量的实验不同。`, '',
    `![真实页面数增长的产物体积曲线](${reportPrefix}/page-growth/page-growth.svg)`, '',
    '补充实验独立运行双构建、全页面 headless 与 H5 首/中/尾页面效果校验；没有新增微信 IDE 验收，范围和原始数据见补充报告。', '',
    '## 与上一版报告的变化', '',
    `完整的新旧版本对比见 [升级对比报告](${reportPrefix}/release-comparison/README.md)，其中同时列出总量、样式、脚本和模板变化，保留历史数据来源。整组依赖升级的差值不能单独归因于 StyleX。`, '',
    ...interpretation(report),
    '## 验证证据与原始数据', '',
    ...(ide ? [`本地微信开发者工具 ${report.validation.ide.environment?.installedVersion}，基础库 ${sdkVersions.join('、')}；验收视口宽度 ${nativeWidths.join('、')}px。IDE 结果来自该模拟器环境，不代替不同设备的真机验证。`, ''] : []),
    ...table(['校验', '结果', '证据'], [['H5 等效性', 'passed', evidenceLinks(report.validation.web)], ['headless', 'passed', evidenceLinks(report.validation.headless)], ['微信 IDE', ide ? 'passed' : 'pending', evidenceLinks(report.validation.ide)]]), '',
    ...screenshotMarkdown(report, readmeDirectory),
    ...(ide && nativeScreenshot ? [`![微信开发者工具：Tailwind 画廊，完成主题、variants 与动态值交互后](${nativeScreenshot.replaceAll(' ', '%20')})`, ''] : []),
    `- [完整结果与逐文件清单](${reportPrefix}/results.json)`, `- [全部 160 格汇总 CSV](${reportPrefix}/results.csv)`, `- [逐文件 CSV：路径、分类、归属、三种字节数及 SHA-256](${reportPrefix}/files.csv)`, `- [规模曲线 SVG](${reportPrefix}/scaling.svg)`, '',
    '环境、必要依赖版本与构建参数摘要（完整输入清单保存在 results.json）：', '', '```json', JSON.stringify({ environment: environmentSummary(report.environment), protocol: protocolSummary(report.protocol) }, null, 2), '```', '',
    '## 边界', '',
    '- 本报告测量体积，不衡量开发体验、编译速度、运行时延迟、setData 次数、内存或生态成熟度。不同框架与真实业务的结果需要另测。',
    `- 两轮一致性要求针对同一环境。首次发布另对 macOS arm64 与 Linux x64 CI 做了[跨环境核对](${reportPrefix}/cross-platform.json)：160 格的 raw/gzip 总量和全部文件路径一致，但 18 个 Panda 原生 WXSS 文件的默认广色域 token 经 Lightning CSS 转换后有约 0.000001 的浮点差异，导致 SHA-256 与部分 Brotli 值不同。两边各自重复构建均稳定，不宣称跨 CPU 架构逐位一致。该审计记录对应其 sourceCommit/buildInputSha256，不随 bench 自动更新。`,
    '- H5 使用浏览器计算样式与交互证据；headless 可验证产物和状态契约，但不能覆盖微信宿主的全部 CSS 布局与兼容行为。微信 IDE 的状态独立披露。',
    '- 独立分包已检查静态引用与 headless 包隔离。当前 IDE 路径从主包启动后经 `reLaunch` / `navigateTo` 热进入独立分包；尚无“不加载主包”的独立分包冷启动实机证据，因此不能据此宣称该冷启动路径已验收。',
    '- 历史 `weapp-stylex@0.3.1` 的动态 camelCase 属性曾有 CSS 自定义变量与 `attrs()` 序列化大小写失配。为保持本轮场景与旧报告一致，公共动态样例继续使用全小写 `padding` 字符串简写；未修改依赖包或生成产物。本轮等效校验覆盖该固定样例，不将其通过外推为所有动态 camelCase 属性均已验收。',
    '- 无样式与手写 CSS 是解释成本的参照，不代表所有项目的最优实现。没有把 npm 安装体积、构建依赖或 sourcemap 当作用户部署体积。',
    '- 排除 sourcemap、微信开发工具项目配置、操作系统元数据与构建分析产物；完整排除明细仍保留在每格 measurement.excluded。',
    ...(excluded.length ? ['', `本次实际排除：${excluded.map(value => `\`${value}\``).join('、')}。`] : ['', '本次产物中未发现需排除文件。']), '',
  ].join('\n')
}
