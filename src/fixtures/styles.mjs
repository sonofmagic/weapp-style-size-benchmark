import path from 'node:path'
import { MEDIA_QUERY, MEDIA_STYLE, STYLE_SPEC, TOKENS } from './spec.mjs'

export const kebab = value => value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
const cssDeclarations = style => Object.entries(style).map(([property, value]) => `${kebab(property)}:${value}`).join(';')
export const themeCss = Object.entries(TOKENS).map(([theme, values]) => `.theme-${theme}{${Object.entries(values).map(([name, value]) => `--bench-${name}:${value}`).join(';')}}`).join('\n') + '\n'
function serializeStylex(style) {
  let serialized = JSON.stringify(style, null, 2)
  for (const key of Object.keys(TOKENS.light)) serialized = serialized.replaceAll(JSON.stringify(`var(--bench-${key})`), `tokens.${key}`)
  return serialized
}

function sourceImport(from, to) {
  const relative = path.relative(path.dirname(from), to).replaceAll(path.sep, '/')
  return relative.startsWith('.') ? relative : `./${relative}`
}

export function styleModule({ scheme, styles, keys, file, directory, independent }) {
  const chosen = Object.fromEntries([...keys].map(key => [key, styles[key]]))
  if (scheme === 'panda') {
    const runtime = sourceImport(file, path.join(directory, 'styled-system/css/index.mjs'))
    const declarations = Object.entries(chosen).map(([key, style]) => {
      if (['variant', 'slotRoot', 'slotLabel', 'condition'].includes(key)) return ''
      const actual = key === 'mediaProbe' ? { ...style, [MEDIA_QUERY]: MEDIA_STYLE } : key === 'tokenProbe' ? { ...style, padding: 'benchSpace', borderRadius: 'benchRadius' } : style
      return `  ${JSON.stringify(key)}: css(${JSON.stringify(actual)}),`
    }).filter(Boolean).join('\n')
    return `import { css, cva, sva } from '${runtime}'\nconst base = {\n${declarations}\n}\n${keys.has('variant') ? `const variant = cva({base:${JSON.stringify(chosen.variant)},variants:{tone:{neutral:{},accent:{backgroundColor:'#2563eb'}},size:{large:{}}},compoundVariants:[{tone:'accent',size:'large',css:{color:'#ffffff',fontWeight:'700'}}]})` : ''}\n${keys.has('slotRoot') || keys.has('slotLabel') ? `const slots = sva({slots:['root','label'],base:{root:${JSON.stringify(styles.slotRoot)},label:${JSON.stringify(styles.slotLabel)}},variants:{active:{true:{root:${JSON.stringify(STYLE_SPEC.slotRootActive)},label:${JSON.stringify(STYLE_SPEC.slotLabelActive)}}}}})` : ''}\n${keys.has('condition') ? `const condition = cva({base:${JSON.stringify(styles.condition)},variants:{active:{true:${JSON.stringify(STYLE_SPEC.conditionActive)}}}})` : ''}\nexport function getStyles(active=false,dark=false,width=120) {\n  ${keys.has('slotRoot') || keys.has('slotLabel') ? 'const slot = slots({active})' : ''}\n  return {...base${keys.has('variant') ? ",variant:variant({tone:active?'accent':'neutral',size:'large'})" : ''}${keys.has('slotRoot') ? ',slotRoot:slot.root' : ''}${keys.has('slotLabel') ? ',slotLabel:slot.label' : ''}${keys.has('condition') ? ',condition:condition({active})' : ''}}\n}\n`
  }
  if (scheme === 'stylex') {
    const tokenFile = path.join(directory, 'src', independent ? 'independent/styles/tokens.stylex.ts' : 'styles/tokens.stylex.ts')
    const tokenImport = sourceImport(file, tokenFile).replace(/\.ts$/, '')
    const definitions = Object.entries(chosen).map(([key, style]) => {
      if (key === 'dynamic') return `dynamic:(width:number,space:number,tone:string)=>(${serializeStylex({ ...style, width: '__WIDTH__', padding: '__SPACE__', color: '__TONE__' }).replace('"__WIDTH__"', 'width').replace('"__SPACE__"', "'0 0 0 '+space+'px'").replace('"__TONE__"', 'tone')})`
      const actual = key === 'mediaProbe' ? Object.fromEntries(Object.entries(style).map(([property, value]) => [property, MEDIA_STYLE[property] ? { default: value, [MEDIA_QUERY]: MEDIA_STYLE[property] } : value])) : key === 'tokenProbe' ? { ...style, padding: '__SPACE_TOKEN__', borderRadius: '__RADIUS_TOKEN__' } : style
      return `${JSON.stringify(key)}:${serializeStylex(actual).replace('"__SPACE_TOKEN__"', 'tokens.space').replace('"__RADIUS_TOKEN__"', 'tokens.radius')}`
    })
    for (const [base, active] of [['variant', 'variantActive'], ['slotRoot', 'slotRootActive'], ['slotLabel', 'slotLabelActive'], ['condition', 'conditionActive']]) if (keys.has(base)) definitions.push(`${active}:${serializeStylex(STYLE_SPEC[active])}`)
    return `import * as stylex from 'weapp-stylex'\nimport {tokens,lightTheme,darkTheme} from '${tokenImport}'\nconst styles=stylex.create({${definitions.join(',\n')}})\nexport function getStyles(active=false,dark=false,width=120) {\n return {${[...keys].map(key => `${JSON.stringify(key)}:stylex.attrs(${key === 'shell' ? 'dark?darkTheme:lightTheme,' : ''}styles.${key}${key === 'dynamic' ? "(width,width===120?8:20,width===120?'#0f766e':'#be123c')" : ''}${{ variant: ',active&&styles.variantActive', slotRoot: ',active&&styles.slotRootActive', slotLabel: ',active&&styles.slotLabelActive', condition: ',active&&styles.conditionActive' }[key] ?? ''})`).join(',\n')}}\n}\n`
  }
  return ''
}

export function referenceCss(styles, keys) {
  const output = [...keys].map(key => `.b-${key}{${cssDeclarations(styles[key])}}`)
  for (const [base, active] of [['variant', 'variantActive'], ['slotRoot', 'slotRootActive'], ['slotLabel', 'slotLabelActive'], ['condition', 'conditionActive']]) if (keys.has(base)) output.push(`.b-${active}{${cssDeclarations(STYLE_SPEC[active])}}`)
  if (keys.has('mediaProbe')) output.push(`${MEDIA_QUERY}{.b-mediaProbe{${cssDeclarations(MEDIA_STYLE)}}}`)
  return output.join('\n') + '\n'
}

