export const SCHEMES = ['tailwind', 'panda', 'stylex', 'reference', 'unstyled']
export const SCENARIOS = ['gallery', 'application', ...['reuse', 'unique'].flatMap(kind => [10, 100, 1000].map(count => `${kind}-${count}`))]
export const PROFILES = ['standard', 'optimized']
export const TARGETS = ['weapp', 'web']

export const TOKENS = {
  light: { surface: '#f8fafc', panel: '#ffffff', text: '#0f172a', muted: '#475569', border: '#cbd5e1', accent: '#2563eb' },
  dark: { surface: '#0f172a', panel: '#1e293b', text: '#f8fafc', muted: '#cbd5e1', border: '#475569', accent: '#60a5fa' },
}
export const LAYOUT_TOKENS = { space: '16px', radius: '12px' }
export const PANDA_THEME = { tokens: { spacing: { benchSpace: { value: LAYOUT_TOKENS.space } }, radii: { benchRadius: { value: LAYOUT_TOKENS.radius } } } }
export const SHARED_RESET = 'page,view,text{box-sizing:border-box}page{margin:0;font-family:sans-serif}view,text{margin:0;padding:0;border:0 solid}\n'
export const MEDIA_QUERY = '@media (min-width: 640px)'

// The spec describes computed effects. Each adapter keeps its customary binding API.
export const STYLE_SPEC = {
  shell: { minHeight: '100vh', backgroundColor: 'var(--bench-surface)', color: 'var(--bench-text)', padding: '24px', fontFamily: 'sans-serif' },
  stack: { display: 'flex', flexDirection: 'column', gap: '16px' },
  row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  title: { display: 'block', fontSize: '28px', fontWeight: '700', lineHeight: '36px' },
  subtitle: { display: 'block', fontSize: '14px', lineHeight: '20px', color: 'var(--bench-muted)' },
  panel: { backgroundColor: 'var(--bench-panel)', borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--bench-border)', borderRadius: '12px', padding: '16px' },
  control: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '10px 14px', borderRadius: '8px', backgroundColor: '#e2e8f0', color: '#0f172a', fontSize: '14px', lineHeight: '20px' },
  tokenProbe: { padding: '16px', borderRadius: '12px', backgroundColor: 'var(--bench-accent)', color: '#ffffff', fontSize: '14px', lineHeight: '20px' },
  variant: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '160px', height: '56px', borderRadius: '8px', backgroundColor: '#e2e8f0', color: '#334155', fontSize: '14px', lineHeight: '20px', fontWeight: '400' },
  variantActive: { backgroundColor: '#2563eb', color: '#ffffff', fontWeight: '700' },
  slotRoot: { padding: '12px', borderRadius: '8px', backgroundColor: '#f1f5f9' },
  slotRootActive: { backgroundColor: '#dbeafe' },
  slotLabel: { display: 'block', color: '#475569', fontSize: '14px', lineHeight: '20px', fontWeight: '400' },
  slotLabelActive: { color: '#2563eb', fontWeight: '700' },
  condition: { display: 'block', opacity: '1', color: '#7c3aed', fontSize: '14px', lineHeight: '20px' },
  conditionActive: { opacity: '0.5' },
  dynamic: { width: 'var(--bench-width)', height: '20px', padding: '0 0 0 var(--bench-space)', color: 'var(--bench-tone)', backgroundColor: '#ccfbf1', fontSize: '12px', lineHeight: '20px' },
  mediaProbe: { width: '120px', height: '32px', backgroundColor: '#dbeafe', color: '#0f172a', fontSize: '12px', lineHeight: '20px' },
  metricValue: { display: 'block', fontSize: '24px', lineHeight: '32px', fontWeight: '700', color: 'var(--bench-accent)' },
  listItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px', borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--bench-border)', borderRadius: '8px' },
  badge: { display: 'inline-block', padding: '4px 8px', fontSize: '12px', lineHeight: '16px', borderRadius: '6px', backgroundColor: '#dbeafe', color: '#1d4ed8' },
  rpxProbe: { width: '200rpx', height: '40rpx', backgroundColor: '#fde68a', borderRadius: '8rpx' },
  decorativeProbe: { width: '160px', height: '48px', borderRadius: '12px', backgroundImage: 'linear-gradient(135deg, #dbeafe 0%, #e0e7ff 100%)', boxShadow: '0 4px 12px rgba(15, 23, 42, 0.12)' },
}
export const MEDIA_STYLE = { width: '240px', backgroundColor: '#dcfce7' }

export function scaleStyle(index, unique) {
  if (!unique) return { display: 'block', width: '120px', height: '28px', paddingLeft: '8px', borderRadius: '6px', backgroundColor: '#2563eb', color: '#ffffff', fontSize: '12px', lineHeight: '20px', marginTop: '4px' }
  return { display: 'block', width: `${96 + index % 41}px`, height: `${24 + index % 17}px`, paddingLeft: `${4 + index % 13}px`, borderRadius: `${2 + index % 19}px`, backgroundColor: `#${((index * 7919 + 0x224466) % 0xffffff).toString(16).padStart(6, '0')}`, color: '#ffffff', fontSize: `${10 + index % 7}px`, lineHeight: '20px', marginTop: `${4 + index % 11}px` }
}

export function rgb(hex) {
  return `rgb(${[1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).join(', ')})`
}
