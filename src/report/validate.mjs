export const schemes = ['tailwind', 'panda', 'stylex', 'reference', 'unstyled']
export const profiles = ['standard', 'optimized']
export const scenarios = ['gallery', 'application', 'reuse-10', 'reuse-100', 'reuse-1000', 'unique-10', 'unique-100', 'unique-1000']
export const targets = ['weapp', 'web']

export function passed(gate) { return gate?.status === 'passed' }
export function key(row) { return [row.scheme, row.profile, row.scenario, row.target].join(':') }

export function validateReport(report) {
  if (report.schemaVersion !== 1) throw new Error('Unsupported benchmark report schema')
  if (!report.environment || !report.protocol) throw new Error('Report lacks environment or protocol evidence')
  for (const gate of ['web', 'headless']) {
    if (!passed(report.validation?.[gate])) throw new Error(`Required validation gate has not passed: ${gate}`)
  }
  const expected = new Set(schemes.flatMap(scheme => profiles.flatMap(profile => scenarios.flatMap(scenario => targets.map(target => key({ scheme, profile, scenario, target }))))))
  const actual = new Set()
  for (const row of report.rows ?? []) {
    const identity = key(row)
    if (!expected.has(identity) || actual.has(identity)) throw new Error(`Unexpected or duplicate benchmark row: ${identity}`)
    actual.add(identity)
    if (row.repeatable !== true) throw new Error(`Production output has not passed repeatability: ${identity}`)
    if (row.validation?.status !== 'passed') throw new Error(`Row validation has not passed: ${identity}`)
    if (row.referenceValidation?.status !== 'passed') throw new Error(`Static output references have not passed: ${identity}`)
    const measurement = row.measurement
    if (!measurement?.files?.length || !measurement.byKind || !measurement.byPackage || !Array.isArray(measurement.excluded)) throw new Error(`Incomplete measurement: ${identity}`)
    if (new Set(measurement.files.map(file => file.path)).size !== measurement.files.length) throw new Error(`Duplicate measured file: ${identity}`)
    for (const metric of ['raw', 'gzip', 'brotli']) {
      const sum = measurement.files.reduce((value, file) => value + file[metric], 0)
      if (!Number.isSafeInteger(sum) || sum < 0 || sum !== measurement.totals?.[metric]) throw new Error(`Invalid measurement totals: ${identity}/${metric}`)
      for (const group of ['byKind', 'byPackage']) {
        if (Object.values(measurement[group]).reduce((value, part) => value + part[metric], 0) !== sum) throw new Error(`Invalid measurement grouping: ${identity}/${group}/${metric}`)
      }
    }
    if (row.target === 'weapp') {
      const minification = row.cssMinification
      if (minification?.tool !== 'lightningcss@1.33.0' || !Array.isArray(minification.files)) throw new Error(`Missing native final CSS minification evidence: ${identity}`)
      for (const metric of ['before', 'after']) {
        if (minification.files.reduce((sum, file) => sum + file[metric], 0) !== minification[metric]) throw new Error(`Invalid CSS minification totals: ${identity}/${metric}`)
      }
      const wxss = measurement.files.filter(file => file.path.endsWith('.wxss'))
      if (wxss.length !== minification.files.length || wxss.some(file => !minification.files.some(item => item.path === file.path && item.after === file.raw))) throw new Error(`Native measured CSS differs from minification evidence: ${identity}`)
    }
  }
  if (actual.size !== expected.size) throw new Error(`Incomplete benchmark matrix: expected ${expected.size}, got ${actual.size}`)
  return report
}
