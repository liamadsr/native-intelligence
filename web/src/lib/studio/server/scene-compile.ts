// Compiling a code scene: a transform, never a run. A scene is one TSX module whose default export is a React
// component taking JSON props; it may import react, remotion and @studio/kit, nothing else. Sucrase strips its types
// and JSX (keeping every line where it was, so a line number is the scene's own line), acorn reads the result, and
// the checks below refuse what the scene's locked frame would never allow anyway (the frame's policy is the wall:
// scene-frame/protocol.ts), so the agent learns it at once, with the line. Then Sucrase writes the module as
// CommonJS, its imports becoming calls to the frame's own `require`. Nothing here executes the scene.
import { parse, type Node } from 'acorn'
import { transform } from 'sucrase'

/** The modules a scene may import (react/jsx-runtime is what JSX compiles to). */
export const SCENE_IMPORTS = ['react', 'remotion', '@studio/kit'] as const
const ALLOWED_IMPORTS = new Set<string>([...SCENE_IMPORTS, 'react/jsx-runtime'])

/** The largest scene source and compiled module the Studio keeps. */
export const MAX_SOURCE_BYTES = 100 * 1024
export const MAX_CODE_BYTES = 200 * 1024

/** Bumped when the compiled form changes, so the same source makes a new scene id. */
export const COMPILER_VERSION = 'scene-compiler-1'

export type SceneProblem = { error: string; line?: number; column?: number; lineText?: string }
export type CompiledSceneCode = { code: string; imports: string[]; fonts: string[] }

/**
 * Names a scene may not use, with what to do instead. Each is something that reaches outside the frame, reaches for
 * the page, runs text as code, or makes a frame depend on anything but its time (so the preview and the export would
 * differ). A scene that declares its own variable of the same name may use it.
 */
const FORBIDDEN_NAMES: Record<string, string> = {
  window: 'A scene draws only what it returns: it cannot reach the page.',
  self: 'A scene draws only what it returns: it cannot reach the page.',
  globalThis: 'A scene draws only what it returns: it cannot reach the page.',
  document: 'A scene draws only what it returns: it cannot reach the page.',
  top: 'A scene cannot reach the page around it.',
  parent: 'A scene cannot reach the page around it.',
  frames: 'A scene cannot reach the page around it.',
  opener: 'A scene cannot reach the page around it.',
  location: 'A scene cannot navigate.',
  navigator: 'A scene cannot reach the browser.',
  eval: 'A scene cannot run text as code.',
  Function: 'A scene cannot run text as code.',
  // Quoted: a bare `require` name reads as an indirect require to the eve tripwire test.
  'require': 'Import react, remotion or @studio/kit at the top instead.',
  module: 'Use export default instead.',
  exports: 'Use export default instead.',
  fetch: 'A scene cannot make requests: pass data in its props, and images through <Media> from @studio/kit.',
  XMLHttpRequest: 'A scene cannot make requests: pass data in its props.',
  WebSocket: 'A scene cannot make requests.',
  EventSource: 'A scene cannot make requests.',
  WebTransport: 'A scene cannot make requests.',
  RTCPeerConnection: 'A scene cannot make connections.',
  webkitRTCPeerConnection: 'A scene cannot make connections.',
  RTCDataChannel: 'A scene cannot make connections.',
  Worker: 'A scene cannot start workers.',
  SharedWorker: 'A scene cannot start workers.',
  importScripts: 'A scene cannot load scripts.',
  localStorage: 'A scene keeps nothing between frames: draw from the time alone.',
  sessionStorage: 'A scene keeps nothing between frames: draw from the time alone.',
  indexedDB: 'A scene keeps nothing between frames: draw from the time alone.',
  caches: 'A scene keeps nothing between frames.',
  cookieStore: 'A scene cannot read cookies.',
  postMessage: 'A scene cannot send messages.',
  open: 'A scene cannot open windows.',
  alert: 'A scene cannot open dialogs.',
  confirm: 'A scene cannot open dialogs.',
  prompt: 'A scene cannot open dialogs.',
  setTimeout: 'Frames are drawn out of order: everything is a function of t (useTime from @studio/kit), never a timer.',
  setInterval: 'Frames are drawn out of order: everything is a function of t (useTime from @studio/kit), never a timer.',
  requestAnimationFrame: 'Frames are drawn out of order: everything is a function of t (useTime from @studio/kit).',
  requestIdleCallback: 'Frames are drawn out of order: everything is a function of t (useTime from @studio/kit).',
  performance: 'Frames are drawn out of order: everything is a function of t (useTime from @studio/kit), never the clock.',
}

/** Properties a scene may not read or write, whatever object they are on. */
const FORBIDDEN_PROPERTIES: Record<string, string> = {
  cookie: 'A scene cannot read cookies.',
  innerHTML: 'Draw with JSX, not HTML text.',
  outerHTML: 'Draw with JSX, not HTML text.',
  insertAdjacentHTML: 'Draw with JSX, not HTML text.',
  srcdoc: 'A scene cannot make frames.',
  dangerouslySetInnerHTML: 'Draw with JSX, not HTML text.',
  constructor: 'A scene cannot reach constructors.',
  __proto__: 'A scene cannot reach prototypes.',
  ownerDocument: 'A scene cannot reach the page.',
  defaultView: 'A scene cannot reach the page.',
  contentWindow: 'A scene cannot reach other frames.',
  contentDocument: 'A scene cannot reach other frames.',
}

/** Member calls that make a frame depend on more than its time. */
const NONDETERMINISTIC: Record<string, string> = {
  'Math.random': 'Frames are drawn out of order: use rand(i) or noise(x) from @studio/kit, not Math.random().',
  'Date.now': 'Frames are drawn out of order: use the time t from useTime(), not the clock.',
}

/** The font families a scene names (font('…'), fontFamily: '…', and `export const fonts = [...]`). Pure. */
export function sceneFonts(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/font\(\s*['"]([^'"]{1,80})['"]\s*\)/g)) out.add(m[1]!)
  for (const m of source.matchAll(/fontFamily:\s*['"]([^'",]{1,80})['"]/g)) out.add(m[1]!.replace(/^"|"$/g, ''))
  const list = /export\s+const\s+fonts\s*=\s*\[([^\]]*)\]/.exec(source)?.[1]
  if (list) for (const m of list.matchAll(/['"]([^'"]{1,80})['"]/g)) out.add(m[1]!)
  return [...out].filter((f) => !/^(inherit|initial|system-ui|sans-serif|serif|monospace|ui-\w+|-apple-system|sans|display|heavy|mono)$/i.test(f)).slice(0, 12)
}

/**
 * Text from the source quoted inside a problem's sentence (an import's name): one short line, at most 80 characters,
 * so a problem the agent reads carries no more of the source than the one line `lineText` quotes. Pure.
 */
function shortText(text: string): string {
  const flat = text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** The problem at a line of the source, with that line's text. */
function at(source: string, error: string, line?: number, column?: number): SceneProblem {
  const lineText = line ? source.split('\n')[line - 1]?.slice(0, 300) : undefined
  return { error, ...(line ? { line } : {}), ...(column !== undefined ? { column } : {}), ...(lineText !== undefined ? { lineText } : {}) }
}

type Located = Node & { loc?: { start: { line: number; column: number } } }

/** Every node of a tree with its parent, depth first. */
function* walk(node: Node, parent: Node | null = null, key = ''): Generator<{ node: Node; parent: Node | null; key: string }> {
  yield { node, parent, key }
  for (const [childKey, value] of Object.entries(node)) {
    if (childKey === 'loc' || childKey === 'start' || childKey === 'end') continue
    const children = Array.isArray(value) ? value : [value]
    for (const child of children) if (child && typeof child === 'object' && typeof (child as Node).type === 'string') yield* walk(child as Node, node, childKey)
  }
}

/** The names a module declares anywhere (variables, functions, classes, parameters, imports), a scope-free view. */
function declaredNames(program: Node): Set<string> {
  const names = new Set<string>()
  const addPattern = (pattern: Node | null | undefined): void => {
    if (!pattern) return
    const p = pattern as Node & Record<string, unknown>
    if (p.type === 'Identifier') names.add(p.name as string)
    else if (p.type === 'ObjectPattern') for (const prop of p.properties as (Node & Record<string, unknown>)[]) addPattern((prop.type === 'RestElement' ? prop.argument : prop.value) as Node)
    else if (p.type === 'ArrayPattern') for (const el of p.elements as Node[]) addPattern(el)
    else if (p.type === 'RestElement') addPattern(p.argument as Node)
    else if (p.type === 'AssignmentPattern') addPattern(p.left as Node)
  }
  for (const { node } of walk(program)) {
    const n = node as Node & Record<string, unknown>
    if (n.type === 'VariableDeclarator') addPattern(n.id as Node)
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      if (n.id) addPattern(n.id as Node)
      for (const param of n.params as Node[]) addPattern(param)
    } else if (n.type === 'ClassDeclaration' && n.id) addPattern(n.id as Node)
    else if (n.type === 'CatchClause') addPattern(n.param as Node)
    else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') addPattern(n.local as Node)
  }
  return names
}

/** Whether an identifier is a name being read (not a property name, a label or a declaration's own name). */
function isReference(node: Node, parent: Node | null, key: string): boolean {
  if (!parent) return true
  const p = parent as Node & Record<string, unknown>
  if ((p.type === 'MemberExpression') && key === 'property' && !p.computed) return false
  if ((p.type === 'Property' || p.type === 'PropertyDefinition' || p.type === 'MethodDefinition') && key === 'key' && !p.computed) return p.type === 'Property' && p.shorthand === true
  if (p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') return false
  if (p.type === 'ExportSpecifier' && key === 'exported') return false
  if ((p.type === 'ImportSpecifier' && key === 'imported')) return false
  return true
}

/** The first thing in a parsed scene the frame would refuse, or null. */
function refuse(program: Node, source: string): SceneProblem | null {
  const declared = declaredNames(program)
  let hasDefault = false
  for (const { node, parent, key } of walk(program)) {
    const n = node as Located & Record<string, unknown>
    const line = n.loc?.start.line, column = n.loc?.start.column
    if (n.type === 'ImportDeclaration' || ((n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source)) {
      const from = String((n.source as { value: unknown }).value)
      if (!ALLOWED_IMPORTS.has(from)) return at(source, `Scenes can import only react, remotion and @studio/kit (not "${shortText(from)}").`, line, column)
    }
    if (n.type === 'ExportDefaultDeclaration') hasDefault = true
    if (n.type === 'ExportNamedDeclaration' && Array.isArray(n.specifiers) && (n.specifiers as { exported: { name?: string; value?: string } }[]).some((s) => (s.exported.name ?? s.exported.value) === 'default')) hasDefault = true
    if (n.type === 'ImportExpression') return at(source, 'A scene cannot load code with import(): import react, remotion or @studio/kit at the top.', line, column)
    if (n.type === 'MetaProperty') return at(source, `A scene cannot use ${(n.meta as { name: string }).name}.${(n.property as { name: string }).name}.`, line, column)
    if (n.type === 'Identifier' && isReference(node, parent, key)) {
      const name = n.name as string
      if (Object.prototype.hasOwnProperty.call(FORBIDDEN_NAMES, name) && !declared.has(name)) return at(source, `A scene cannot use "${name}": ${FORBIDDEN_NAMES[name]}`, line, column)
    }
    const propertyName = n.type === 'MemberExpression' ? memberName(n) : (n.type === 'Property' && !n.computed) ? keyName(n.key as Node) : null
    if (propertyName && Object.prototype.hasOwnProperty.call(FORBIDDEN_PROPERTIES, propertyName)) return at(source, `A scene cannot use "${propertyName}": ${FORBIDDEN_PROPERTIES[propertyName]}`, line, column)
    if (n.type === 'MemberExpression') {
      const object = n.object as Node & { type: string; name?: string }
      const whole = object.type === 'Identifier' && propertyName ? `${object.name}.${propertyName}` : ''
      if (whole && Object.prototype.hasOwnProperty.call(NONDETERMINISTIC, whole) && !declared.has(object.name!)) return at(source, NONDETERMINISTIC[whole]!, line, column)
    }
  }
  if (!hasDefault) return at(source, 'A scene needs a default export: export default function Scene() { … }')
  return null
}

/** A member's property name when it is fixed (a.b, a['b']), else null. */
function memberName(n: Record<string, unknown>): string | null {
  const property = n.property as Node & { name?: string; value?: unknown }
  if (!n.computed && property.type === 'Identifier') return property.name ?? null
  if (n.computed && property.type === 'Literal' && typeof property.value === 'string') return property.value
  if (n.computed && property.type === 'TemplateLiteral' && (property as unknown as { expressions: unknown[]; quasis: { value: { cooked: string } }[] }).expressions.length === 0)
    return (property as unknown as { quasis: { value: { cooked: string } }[] }).quasis[0]?.value.cooked ?? null
  return null
}
/** An object key's name when it is fixed. */
function keyName(key: Node & { name?: string; value?: unknown }): string | null {
  return key.type === 'Identifier' ? key.name ?? null : key.type === 'Literal' && typeof key.value === 'string' ? key.value : null
}

/** A Sucrase or acorn error as a problem at its line. */
function syntaxProblem(source: string, error: unknown): SceneProblem {
  const e = error as { message?: string; loc?: { line: number; column: number } }
  const message = (e.message ?? String(error)).replace(/^Error transforming [^:]*: /, '').replace(/\s*\(\d+:\d+\)\s*$/, '')
  return at(source, `${message}.`.replace(/\.\.$/, '.'), e.loc?.line, e.loc?.column)
}

/**
 * Compile a scene's source into the module its frame runs, or say exactly what is wrong and where. Pure: the source
 * is transformed and read, never run.
 */
export function compileSceneSource(source: string, name = 'scene'): CompiledSceneCode | SceneProblem {
  if (typeof source !== 'string' || !source.trim()) return { error: 'The scene has no source.' }
  const bytes = Buffer.byteLength(source)
  if (bytes > MAX_SOURCE_BYTES) return { error: `The scene is ${Math.ceil(bytes / 1024)} KB: at most ${MAX_SOURCE_BYTES / 1024} KB. Split it, or pass long data in its props.` }
  const filePath = `${name.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'scene'}.tsx`
  let esm: string
  try {
    esm = transform(source, { transforms: ['typescript', 'jsx'], jsxRuntime: 'automatic', production: true, keepUnusedImports: true, filePath }).code
  } catch (error) {
    return syntaxProblem(source, error)
  }
  let program: Node
  try {
    program = parse(esm, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  } catch (error) {
    return syntaxProblem(source, error)
  }
  const problem = refuse(program, source)
  if (problem) return problem
  const imports = [...new Set((program as Node & { body: Node[] }).body.flatMap((n) => (n.type === 'ImportDeclaration' ? [String((n as unknown as { source: { value: string } }).source.value)] : [])))].filter((m) => m !== 'react/jsx-runtime')
  let code: string
  try {
    code = transform(source, { transforms: ['typescript', 'jsx', 'imports'], jsxRuntime: 'automatic', production: true, keepUnusedImports: true, filePath }).code
  } catch (error) {
    return syntaxProblem(source, error)
  }
  const codeBytes = Buffer.byteLength(code)
  if (codeBytes > MAX_CODE_BYTES) return { error: `The compiled scene is ${Math.ceil(codeBytes / 1024)} KB: at most ${MAX_CODE_BYTES / 1024} KB.` }
  return { code, imports, fonts: sceneFonts(source) }
}

export const isSceneProblem = (value: CompiledSceneCode | SceneProblem): value is SceneProblem => 'error' in value
