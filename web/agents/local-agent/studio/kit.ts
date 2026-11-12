/**
 * Product components for the Studio, the pure half (no file system, no browser): what a product folder is, how its
 * components are found, and which code a capture was built from. The runner (runner.ts) does the reading and the
 * rendering, inside the job's fence on the person's Mac; this file only decides, so every rule here is unit-tested.
 *
 * A product's settings are a small typed record the app keeps (the Studio's `products` records), never files written
 * into the product: the runner reads the product's folder and never writes to it.
 *
 * Every path in a record is relative to the product's folder and stays inside it (checkRelativePath). No record
 * carries code: a fixture is either props (data) or a module the product's own folder already holds.
 */

/** A curated component: a file and export of the product, or a fixture module of the product, with a size and a note. */
export type KitComponent = {
  file?: string
  fixture?: string
  export: string
  width: number
  height: number
  help: string
  props?: Record<string, unknown>
  group?: string
}

/** One of the product's providers to mount around every component, outermost first. `from` is a folder path or an alias import. */
export type KitProvider = { from: string; export: string; props?: Record<string, unknown> }

/** The frameworks detection tells apart (all React). */
export type Framework = 'vite' | 'next' | 'remix' | 'react'

/** A product's settings: how its components are built outside the product. */
export type StudioKit = {
  slug: string
  title: string
  framework: Framework
  /** Path aliases from its tsconfig: `@` to `src`, relative to the folder. */
  alias: Record<string, string>
  /** The entry stylesheet (Tailwind's, when it has one), relative to the folder, or null. */
  css: string | null
  tailwind: 3 | 4 | null
  /** Folders whose exported components are listed. */
  discover: string[]
  components: Record<string, KitComponent>
  providers?: KitProvider[]
  /** Classes the product puts on <body>; previewClass adds its background in a preview. */
  rootClass?: string
  previewClass?: string
  htmlAttributes?: Record<string, string>
  /** The product's public files folder (images, icons), relative. */
  public?: string
  /** Discovered exports whose names match this are not listed: they render nothing by design. */
  hide?: string
}

/** One listed component. */
export type CatalogEntry = {
  id: string
  name: string
  group: string
  help: string
  curated: boolean
  file: string
  width: number
  height: number
  props?: Record<string, unknown>
}

/** What a capture is asked for (the engine's layer.style.component keeps the same names). */
export type CaptureOptions = {
  props?: Record<string, unknown>
  seconds?: number
  width?: number
  height?: number
  theme?: 'light' | 'dark'
  /** Transparent (the default) or a solid #rrggbb behind the component. */
  background?: string
  /** One frame instead of footage. */
  still?: boolean
  /** Interaction steps played with a visible cursor (stage/kit-script.ts). */
  script?: Record<string, unknown>[]
  cursor?: boolean
  scale?: number
  fps?: number
}

/** A product slug: lowercase letters, digits, dash and underscore, as the engine's component layer requires. */
export const SLUG = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Bump when the way stages are built changes, so every capture made before counts as stale. */
export const STAGE_VERSION = 1

/** The slug for a product name: lowercase, dashes, at most 41 characters, never empty. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 41)
  return SLUG.test(slug) ? slug : 'product'
}

/**
 * A path a record may name: relative, inside the folder, no `..`, no NUL, no home shorthand. Answers the cleaned path
 * (no leading `./`), or null when it may not be used.
 */
export function checkRelativePath(path: unknown): string | null {
  if (typeof path !== 'string') return null
  const cleaned = path.trim().replace(/^\.\/+/, '')
  if (!cleaned || cleaned.length > 300) return null
  if (cleaned.startsWith('/') || cleaned.startsWith('~') || cleaned.includes('\0') || cleaned.includes('\\')) return null
  if (cleaned.split('/').some((part) => part === '..')) return null
  return cleaned
}

/** What onboarding reads of a folder: package.json, tsconfig's text, candidate stylesheets with their text, and what is installed. */
export type FolderFacts = {
  packageJson: unknown
  tsconfigText: string | null
  /** Folder-relative paths that exist at the top two levels (`src`, `src/components`, `app`, `components`, `tailwind.config.ts`...). */
  entries: string[]
  /** Candidate stylesheets (relative path to text), searched in src/, app/, styles/. */
  stylesheets: Record<string, string>
  installed: { react: boolean; reactDom: boolean; esbuild: boolean; tailwindCli: boolean }
}

/** Why a folder cannot be a product yet, in one sentence the person can act on, or the product's settings. */
export type DetectResult = { ok: true; kit: StudioKit; notes: string[] } | { ok: false; reason: string }

/** The dependency names a package.json lists (dependencies and devDependencies). */
function dependencyNames(pkg: unknown): Set<string> {
  const record = (pkg && typeof pkg === 'object' ? pkg : {}) as Record<string, unknown>
  const names = new Set<string>()
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = record[field]
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name)
  }
  return names
}

/** The framework a package.json shows. */
export function detectFramework(pkg: unknown): Framework {
  const deps = dependencyNames(pkg)
  if (deps.has('next')) return 'next'
  if ([...deps].some((name) => name.startsWith('@remix-run/') || name.startsWith('@react-router/'))) return 'remix'
  if (deps.has('vite')) return 'vite'
  return 'react'
}

/** tsconfig.json text with its comments and trailing commas removed, parsed, or null. */
export function parseLooseJson(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"])\/\/.*$/gm, '$1').replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return null
  }
}

/** Path aliases from a tsconfig (`"@/*": ["src/*"]` gives `@` to `src`), relative to the folder; only ones that stay inside it. */
export function aliasesFromTsconfig(tsconfigText: string | null): Record<string, string> {
  const parsed = parseLooseJson(tsconfigText) as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } } | null
  const options = parsed?.compilerOptions
  const base = checkRelativePath(options?.baseUrl ?? '.') ?? ''
  const out: Record<string, string> = {}
  for (const [key, targets] of Object.entries(options?.paths ?? {})) {
    const target = Array.isArray(targets) ? targets[0] : undefined
    if (!key.endsWith('/*') || typeof target !== 'string' || !target.endsWith('/*')) continue
    const joined = [base, target.slice(0, -2)].filter((part) => part && part !== '.').join('/')
    const path = joined === '' ? '.' : checkRelativePath(joined)
    if (path) out[key.slice(0, -2)] = path
  }
  return out
}

/** The Tailwind major a stylesheet is written for, or null when it is not a Tailwind entry. */
export function tailwindVersionOf(cssText: string): 3 | 4 | null {
  if (/@import\s+['"]tailwindcss['"]/.test(cssText)) return 4
  if (/@tailwind\s+base/.test(cssText)) return 3
  return null
}

/** Folders to list components from: the conventional ones the folder has, `src/components` first. */
export function discoverFolders(entries: readonly string[]): string[] {
  const have = new Set(entries)
  const found = ['src/components', 'components', 'app/components', 'src/ui'].filter((dir) => have.has(dir))
  return found.length ? found : have.has('src') ? ['src'] : ['.']
}

/**
 * Onboarding's decision: a React product whose packages are installed becomes a kit (settings the app keeps); anything
 * else is one sentence saying what to do first.
 */
export function detectProduct(facts: FolderFacts, title?: string): DetectResult {
  const pkg = (facts.packageJson && typeof facts.packageJson === 'object' ? facts.packageJson : null) as { name?: unknown } | null
  if (!pkg) return { ok: false, reason: 'That folder has no package.json: choose the root of a web app.' }
  const deps = dependencyNames(pkg)
  if (!deps.has('react')) return { ok: false, reason: 'That product does not use React, so its components cannot be rendered here.' }
  if (!facts.installed.react || !facts.installed.reactDom) return { ok: false, reason: "The product's packages are not installed: run npm install in that folder on the Mac first." }
  if (!facts.installed.esbuild) return { ok: false, reason: 'The product has no esbuild installed: add it as a dev dependency (npm install -D esbuild) on the Mac, then onboard again.' }
  const notes: string[] = []
  const sheets = Object.entries(facts.stylesheets).sort(([a], [b]) => a.localeCompare(b))
  const tailwindSheet = sheets.find(([, text]) => tailwindVersionOf(text) !== null)
  const css = tailwindSheet?.[0] ?? sheets[0]?.[0] ?? null
  const tailwind = tailwindSheet ? tailwindVersionOf(tailwindSheet[1]) : null
  if (tailwind && !facts.installed.tailwindCli) notes.push("Tailwind's command line is not installed in the product, so its classes are not compiled: install @tailwindcss/cli (Tailwind 4) or tailwindcss (Tailwind 3).")
  if (!css) notes.push('No stylesheet was found in src/, app/ or styles/: components render without the product\'s styles.')
  const name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : 'product'
  const kit: StudioKit = {
    slug: slugOf(name),
    title: (title ?? name).slice(0, 80),
    framework: detectFramework(pkg),
    alias: aliasesFromTsconfig(facts.tsconfigText),
    css,
    tailwind,
    discover: discoverFolders(facts.entries),
    components: {},
    ...(facts.entries.includes('public') ? { public: 'public' } : {}),
  }
  if (kit.framework === 'next') notes.push('Next.js links, images and navigation are stood in for, so server components and data fetching on the server do not render here.')
  return { ok: true, kit, notes }
}

/** An exported React component: `export function Name(`, `export default function Name(`, `export const Name = (`, memo and forwardRef too. */
const EXPORT_RE = /export\s+(?:default\s+)?(?:const\s+([A-Z]\w+)\s*(?::[^=]+)?=\s*(?:memo|forwardRef|React\.memo|React\.forwardRef)?\s*\(|function\s+([A-Z]\w+)\s*\()/g

/** Exports whose names say they render nothing by design. */
export const DEFAULT_HIDE = '(Provider|Listener|Handler|Script|Watchdog|Mount|Subscriber|Boundary)$'

/** A component's id: its file without the extension, dashed, then `--` and its export (as the source's ids). */
export function componentId(rel: string, exportName: string): string {
  return `${rel.replace(/\.tsx$/, '').replace(/[^a-zA-Z0-9]+/g, '-')}--${exportName}`
}

/** The components one file exports (a `'use server'` file has none). */
export function discoverExports(text: string, rel: string, hide: string = DEFAULT_HIDE): CatalogEntry[] {
  if (/^\s*['"]use server['"]/.test(text)) return []
  let hidden: RegExp
  try {
    hidden = new RegExp(hide)
  } catch {
    hidden = new RegExp(DEFAULT_HIDE)
  }
  const out: CatalogEntry[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(EXPORT_RE)) {
    const name = match[1] ?? match[2]
    if (!name || seen.has(name) || hidden.test(name)) continue
    seen.add(name)
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.'
    out.push({ id: componentId(rel, name), name, group: dir.split('/').slice(-2).join('/'), help: '', curated: false, file: rel, width: 720, height: 420 })
  }
  return out
}

/** A file the walk lists: a .tsx that is not a test, a spec or a story. */
export function isComponentFile(name: string): boolean {
  return /\.tsx$/.test(name) && !/\.(test|spec|stories)\.tsx$/.test(name)
}

/** The catalog: curated components first (each with its help and size), then every discovered export not already curated. */
export function buildCatalog(kit: Pick<StudioKit, 'components' | 'hide'>, files: { rel: string; text: string }[]): CatalogEntry[] {
  const entries: CatalogEntry[] = []
  for (const [id, c] of Object.entries(kit.components)) {
    entries.push({ id, name: c.export, group: c.group ?? 'Featured', help: c.help, curated: true, file: c.fixture ?? c.file ?? '', width: c.width, height: c.height, ...(c.props ? { props: c.props } : {}) })
  }
  const seen = new Set(entries.map((e) => `${e.file}#${e.name}`))
  for (const f of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    for (const entry of discoverExports(f.text, f.rel, kit.hide)) {
      if (seen.has(`${entry.file}#${entry.name}`)) continue
      seen.add(`${entry.file}#${entry.name}`)
      entries.push(entry)
    }
  }
  return entries
}

/** esbuild's metafile, the parts read here. */
export type Metafile = { outputs: Record<string, { imports?: { path: string; kind: string }[]; inputs?: Record<string, unknown>; entryPoint?: string }> }

/**
 * The source files one lazily loaded component chunk was built from: its own inputs and those of every chunk it
 * imports statically (shared code), never the chunks it loads on demand (other components).
 */
export function chunkInputs(metafile: Metafile, chunk: string): string[] {
  const inputs = new Set<string>()
  const seen = new Set<string>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    const output = metafile.outputs[name]
    if (!output) return
    for (const input of Object.keys(output.inputs ?? {})) inputs.add(input)
    for (const imported of output.imports ?? []) if (imported.kind === 'import-statement') visit(imported.path)
  }
  visit(chunk)
  return [...inputs].sort()
}

/**
 * A component's code key: what changes when the code it shows changes. Every input that is the product's own (not a
 * package) counts by its content hash, with the product's settings and the stage version. `hash` is SHA-256 hex.
 */
export function componentKey(parts: { inputs: { path: string; sha256: string }[]; settings: unknown; css: string | null }, hash: (text: string) => string): string {
  const lines = [`stage ${STAGE_VERSION}`, `settings ${JSON.stringify(parts.settings)}`, `css ${parts.css ?? ''}`]
  for (const input of [...parts.inputs].sort((a, b) => a.path.localeCompare(b.path))) lines.push(`${input.path} ${input.sha256}`)
  return hash(lines.join('\n')).slice(0, 32)
}

/**
 * The commit a folder is on, read from its git files without running git: `.git/HEAD`, then the branch's ref file or
 * packed-refs. Null when the folder is not a checkout or the commit cannot be read.
 */
export function commitFromGit(files: { head: string | null; ref: (name: string) => string | null; packedRefs: string | null }): string | null {
  const head = files.head?.trim() ?? ''
  if (/^[0-9a-f]{40}$/.test(head)) return head
  const name = /^ref:\s*(refs\/[\w./-]+)$/.exec(head)?.[1]
  if (!name || name.includes('..')) return null
  const direct = files.ref(name)?.trim() ?? ''
  if (/^[0-9a-f]{40}$/.test(direct)) return direct
  for (const line of (files.packedRefs ?? '').split('\n')) {
    const [sha, ref] = line.trim().split(' ')
    if (ref === name && sha && /^[0-9a-f]{40}$/.test(sha)) return sha
  }
  return null
}

/** True when a path esbuild names is a package's, not the product's own code. */
export function isPackagePath(path: string): boolean {
  return path.includes('node_modules/') || path.startsWith('kit-stub:')
}
