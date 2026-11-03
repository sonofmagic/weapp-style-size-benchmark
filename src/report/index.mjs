import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { scalingChart } from './chart.mjs'
import { readme } from './readme.mjs'
import { validateReport } from './validate.mjs'

export { validateReport } from './validate.mjs'

function csvCell(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csv(report) {
  const headings = ['scheme', 'profile', 'scenario', 'target', 'raw', 'gzip', 'brotli', 'styleRaw', 'scriptRaw', 'templateRaw', 'jsonRaw', 'assetRaw', 'deltaUnstyledRaw', 'deltaReferenceRaw', 'mainRaw', 'subpackageRaw', 'nativeCssBeforeRaw', 'nativeCssAfterRaw', 'files', 'repeatable']
  const lines = report.rows.map(row => {
    const matching = scheme => report.rows.find(other => other.scheme === scheme && other.profile === row.profile && other.scenario === row.scenario && other.target === row.target).measurement.totals.raw
    const m = row.measurement
    return [row.scheme, row.profile, row.scenario, row.target, m.totals.raw, m.totals.gzip, m.totals.brotli, ...['style', 'script', 'template', 'json', 'asset'].map(kind => m.byKind[kind].raw), m.totals.raw - matching('unstyled'), m.totals.raw - matching('reference'), m.byPackage.main?.raw ?? '', row.target === 'weapp' ? Object.entries(m.byPackage).filter(([name]) => name !== 'main').reduce((sum, [, group]) => sum + group.raw, 0) : '', row.cssMinification?.before ?? '', row.cssMinification?.after ?? '', m.files.length, row.repeatable]
  })
  return [headings, ...lines].map(line => line.map(csvCell).join(',')).join('\n') + '\n'
}

export function fileCsv(report) {
  const headings = ['scheme', 'profile', 'scenario', 'target', 'path', 'kind', 'package', 'raw', 'gzip', 'brotli', 'sha256']
  const rows = report.rows.flatMap(row => row.measurement.files.map(file => [row.scheme, row.profile, row.scenario, row.target, file.path, file.kind, file.package, file.raw, file.gzip, file.brotli, file.sha256]))
  return [headings, ...rows].map(line => line.map(csvCell).join(',')).join('\n') + '\n'
}

export async function writeReports(report, { directory, readmePath }) {
  validateReport(report)
  await mkdir(directory, { recursive: true })
  await mkdir(path.dirname(readmePath), { recursive: true })
  const relative = path.relative(path.dirname(readmePath), directory).split(path.sep).join('/') || '.'
  await writeFile(path.join(directory, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(directory, 'results.csv'), csv(report))
  await writeFile(path.join(directory, 'files.csv'), fileCsv(report))
  await writeFile(path.join(directory, 'scaling.svg'), scalingChart(report))
  await writeFile(readmePath, readme(report, relative, path.dirname(readmePath)))
  return { json: path.join(directory, 'results.json'), csv: path.join(directory, 'results.csv'), filesCsv: path.join(directory, 'files.csv'), chart: path.join(directory, 'scaling.svg'), readme: readmePath }
}
