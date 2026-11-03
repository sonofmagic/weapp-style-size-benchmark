import { MEDIA_STYLE, STYLE_SPEC } from './spec.mjs'
import { kebab } from './styles.mjs'

function tw(style) {
  const values = []
  const prefixes = { padding: 'p', paddingLeft: 'pl', marginTop: 'mt', width: 'w', height: 'h', minHeight: 'min-h', gap: 'gap', borderRadius: 'rounded', borderWidth: 'border', lineHeight: 'leading', opacity: 'opacity' }
  for (const [property, value] of Object.entries(style)) {
    if (property === 'display') values.push({ flex: 'flex', block: 'block', 'inline-block': 'inline-block', 'inline-flex': 'inline-flex' }[value])
    else if (property === 'flexDirection') values.push(value === 'column' ? 'flex-col' : 'flex-row')
    else if (property === 'flexWrap') values.push('flex-wrap')
    else if (property === 'alignItems') values.push('items-center')
    else if (property === 'justifyContent') values.push(value === 'center' ? 'justify-center' : 'justify-between')
    else if (property === 'fontWeight') values.push(value === '700' ? 'font-bold' : 'font-normal')
    else if (property === 'fontSize') values.push(`text-[length:${value}]`)
    else if (property === 'color') values.push(`text-[color:${value}]`)
    else if (property === 'backgroundColor') values.push(`bg-[${value}]`)
    else if (property === 'borderColor') values.push(`border-[color:${value}]`)
    else if (property === 'borderStyle') values.push('border-solid')
    else if (prefixes[property]) values.push(`${prefixes[property]}-[${value.replaceAll(' ', '_')}]`)
    else values.push(`[${kebab(property)}:${value.replaceAll(' ', '_')}]`)
  }
  return values.join(' ')
}

export function classFor(key, scheme, styles) {
  if (scheme === 'unstyled') return ''
  if (scheme === 'tailwind') {
    let base = tw(styles[key])
    if (key === 'tokenProbe') base = base.replace('p-[16px]', 'p-bench-space').replace('rounded-[12px]', 'rounded-bench-radius')
    if (key === 'variant') return `{{active ? '${tw({ ...styles.variant, ...STYLE_SPEC.variantActive })}' : '${base}'}}`
    if (key === 'slotRoot') return `{{active ? '${tw({ ...styles.slotRoot, ...STYLE_SPEC.slotRootActive })}' : '${base}'}}`
    if (key === 'slotLabel') return `{{active ? '${tw({ ...styles.slotLabel, ...STYLE_SPEC.slotLabelActive })}' : '${base}'}}`
    if (key === 'condition') return `{{active ? '${tw({ ...styles.condition, ...STYLE_SPEC.conditionActive })}' : '${base}'}}`
    if (key === 'mediaProbe') return `${base} ${tw(MEDIA_STYLE).split(' ').map(value => `min-[640px]:${value}`).join(' ')}`
    return base
  }
  if (scheme === 'reference') {
    const conditional = { variant: 'variantActive', slotRoot: 'slotRootActive', slotLabel: 'slotLabelActive', condition: 'conditionActive' }[key]
    return `b-${key}${conditional ? ` {{active ? 'b-${conditional}' : ''}}` : ''}`
  }
  return `{{classes.${key}${scheme === 'stylex' ? '.class' : ''}}}`
}

export function renderNodes(nodes, scheme, styles, indentation = '  ') {
  return nodes.map(item => {
    const identity = `id="${item.id}" data-testid="${item.id}"`
    if (item.component) return `${indentation}<${item.component} ${identity} label="${item.label}" value="${item.value}" />`
    const classes = item.styles.map(key => classFor(key, scheme, styles)).filter(Boolean).join(' ')
    const dynamic = item.styles.includes('dynamic') && scheme !== 'unstyled'
    const style = dynamic ? ` style="{{${scheme === 'stylex' ? 'classes.dynamic.style' : 'dynamicStyle'}}}"` : ''
    const action = item.action ? ` bindtap="${item.action}"` : ''
    const content = item.children.length ? `\n${renderNodes(item.children, scheme, styles, `${indentation}  `)}\n${indentation}` : item.text ?? ''
    return `${indentation}<${item.tag} ${identity}${classes ? ` class="${classes}"` : ''}${style}${action}>${content}</${item.tag}>`
  }).join('\n')
}

