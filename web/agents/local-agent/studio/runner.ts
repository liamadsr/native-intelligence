/**
 * The Studio's product-component runner: renders a product's real React components, from the product's own code, into
 * transparent footage or a still. It runs on the person's Mac as ONE command of a local agent job, inside the job's
 * fence (lib/seatbelt.ts: no network, the folder read-only, writes only in the job's scratch dir), started by the
 * Mac-only tool studio_product (../tools/studio_product.ts). It reads the product's folder and never writes to it.
 *
 *   node runner.cjs onboard <out dir>                    what the folder is: its settings (a kit) or what to fix first
 *   node runner.cjs list    <request.json> <out dir>     its components, which render, and each one's code key
 *   node runner.cjs capture <request.json> <out dir>     one component as footage (.webm) or a still (.png)
 *
 * The product's folder is the working directory. The answer is one JSON object, printed and written to
 * `<out dir>/result.json`. Ported from the standalone editor's capture pipeline with what this home needs: the kit is
 * the app's typed record (request.json), the stage is served to the browser from memory (no local server, so no
 * network inside the fence), there are no web fonts, and the code key is per component, from the content of the
 * product's own files that component was built from (kit.ts componentKey).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { Browser, Page } from 'playwright-core'
import {
  buildCatalog,
  checkRelativePath,
  chunkInputs,
  commitFromGit,
  componentKey,
  detectProduct,
  isComponentFile,
  isPackagePath,
  type CaptureOptions,
  type CatalogEntry,
  type FolderFacts,
  type Metafile,
  type StudioKit,
} from './kit.js'

const run = promisify(execFile)

/** The origin the stage is served on, from memory (page.route): nothing listens there. */
const STAGE_ORIGIN = 'http://stage.localhost'
/** The stage page's own clock starts here, so relative times in sample data read naturally. */
const SAMPLE_NOW = Date.parse('2026-10-20T15:30:00Z')
/** Most components a listing renders to check them. */
const HEALTH_MAX = 60

/** SHA-256 hex of text or bytes. */
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

/** Where the runner's own files are (stage/ beside runner.cjs). */
function runnerDir(): string {
  return dirname(realpathSync(process.argv[1] ?? '.'))
}

/** Read a file as text, or null. */
async function readText(path: string, max = 512 * 1024): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > max) return null
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------------------------------------ onboard

/** Stylesheets under a folder, at most `depth` levels down (no dot folders, no packages). */
async function findStylesheets(root: string, base: string, out: Record<string, string>, depth = 0): Promise<void> {
  if (depth > 5 || Object.keys(out).length >= 40) return
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await findStylesheets(path, base, out, depth + 1)
    else if (entry.name.endsWith('.css')) {
      const text = await readText(path, 200 * 1024)
      if (text !== null) out[relative(base, path)] = text
    }
  }
}

/** What onboarding needs to know about the folder. */
async function readFacts(folder: string): Promise<FolderFacts> {
  const probe = ['src', 'src/components', 'components', 'app', 'app/components', 'src/ui', 'public', 'styles', 'tailwind.config.ts', 'tailwind.config.js']
  const stylesheets: Record<string, string> = {}
  for (const dir of ['src', 'app', 'styles']) if (existsSync(join(folder, dir))) await findStylesheets(join(folder, dir), folder, stylesheets)
  const nm = join(folder, 'node_modules')
  const packageText = await readText(join(folder, 'package.json'))
  let packageJson: unknown = null
  try {
    packageJson = packageText ? JSON.parse(packageText) : null
  } catch {
    packageJson = null
  }
  return {
    packageJson,
    tsconfigText: await readText(join(folder, 'tsconfig.json')),
    entries: probe.filter((p) => existsSync(join(folder, p))),
    stylesheets,
    installed: {
      react: existsSync(join(nm, 'react/package.json')),
      reactDom: existsSync(join(nm, 'react-dom/package.json')),
      esbuild: existsSync(join(nm, 'esbuild/package.json')),
      tailwindCli: existsSync(join(nm, '.bin/tailwindcss')),
    },
  }
}

/** The commit the folder is on (read from its git files), or null. */
async function readCommit(folder: string): Promise<string | null> {
  const git = join(folder, '.git')
  const refs = new Map<string, string | null>()
  const head = await readText(join(git, 'HEAD'))
  const name = /^ref:\s*(refs\/[\w./-]+)$/.exec(head?.trim() ?? '')?.[1]
  if (name && !name.includes('..')) refs.set(name, await readText(join(git, name)))
  return commitFromGit({ head, ref: (ref) => refs.get(ref) ?? null, packedRefs: await readText(join(git, 'packed-refs'), 4 * 1024 * 1024) })
}

// -------------------------------------------------------------------------------------------------------------- stage

/** Every .tsx component file under the kit's discovery folders, with its text. */
async function componentFiles(folder: string, kit: StudioKit): Promise<{ rel: string; text: string }[]> {
  const out: { rel: string; text: string }[] = []
  const walk = async (dir: string, depth: number) => {
    if (depth > 8 || out.length >= 2000) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'test') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (isComponentFile(entry.name)) {
        const text = await readText(path)
        if (text !== null) out.push({ rel: relative(folder, path), text })
      }
    }
  }
  for (const dir of kit.discover) {
    const rel = dir === '.' ? '.' : checkRelativePath(dir)
    if (rel) await walk(resolve(folder, rel), 0)
  }
  return out
}

/** A folder-relative path the kit names, as an absolute path inside the folder, or a throw. */
function inFolder(folder: string, rel: string, what: string): string {
  const checked = checkRelativePath(rel.split('#')[0])
  const path = checked ? resolve(folder, checked) : null
  if (!path || !(path === folder || path.startsWith(folder + sep))) throw new Error(`${what} must be a path inside the product's folder`)
  return path
}

/** The product's own esbuild (its node_modules), loaded from the folder. */
/**
 * The product's own esbuild. The bundle keeps 'esbuild' external, and the job runs the runner with the product's
 * node_modules on NODE_PATH (job.ts runnerCommand), so this literal require resolves to the product's package.
 */
async function productEsbuild(): Promise<typeof import('esbuild')> {
  try {
    // A CommonJS require (the runner ships as runner.cjs): an ESM import() would not read NODE_PATH.
    return require('esbuild') as typeof import('esbuild')
  } catch {
    throw new Error('The product has no esbuild installed: add it as a dev dependency (npm install -D esbuild) on the Mac.')
  }
}

/** A built stage: where it is, what was built, and each component's code key. */
type Stage = { dir: string; entries: CatalogEntry[]; keys: Record<string, string>; commit: string | null }

/**
 * Build the stage: one page that can mount any component of the product, each in its own lazily loaded chunk so a
 * component that cannot render outside the product never breaks the others. Its React is the product's own.
 */
async function buildStage(folder: string, kit: StudioKit, stageDir: string, log: (line: string) => void): Promise<Stage> {
  const nm = join(folder, 'node_modules')
  const own = join(runnerDir(), 'stage')
  const entries = buildCatalog(kit, await componentFiles(folder, kit))
  const work = join(stageDir, 'build')
  await rm(stageDir, { recursive: true, force: true })
  await mkdir(join(work, 'out'), { recursive: true })
  const source = (e: CatalogEntry) => inFolder(folder, e.file, `${e.name}'s file`)
  const aliasKeys = Object.keys(kit.alias)
  const importPath = (from: string) => (aliasKeys.some((a) => from === a || from.startsWith(`${a}/`)) ? from : inFolder(folder, from, 'A provider'))
  const providers = kit.providers ?? []
  const registry = join(work, 'stage.tsx')
  const lines = [
    `import { mountStage } from ${JSON.stringify(join(own, 'stage-runtime.tsx'))}`,
    'mountStage({',
    '  loaders: {',
    ...entries.map((e) => `    ${JSON.stringify(e.id)}: { export: ${JSON.stringify(e.name)}, load: () => import(${JSON.stringify(source(e))}) },`),
    '  },',
    '  providers: [',
    ...providers.map((p) => `    { name: ${JSON.stringify(p.export)}, export: ${JSON.stringify(p.export)}, load: () => import(${JSON.stringify(importPath(p.from))}), props: ${JSON.stringify(p.props ?? {})} },`),
    '  ],',
    `  rootClass: ${JSON.stringify(kit.rootClass ?? '')}, previewClass: ${JSON.stringify(kit.previewClass ?? '')}, htmlAttributes: ${JSON.stringify(kit.htmlAttributes ?? {})},`,
    '})',
  ]
  await writeFile(registry, lines.join('\n') + '\n')
  const { build } = await productEsbuild()
  // Imports that do not resolve outside the product (server-only modules, missing optional packages) become empty
  // modules instead of failing the whole stage; the component that needs them shows its error.
  const soften = {
    name: 'soften',
    setup(b: import('esbuild').PluginBuild) {
      b.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'soft' || args.kind === 'entry-point' || args.importer.includes(`${sep}node_modules${sep}`)) return undefined
        const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: 'soft' })
        return r.errors.length ? { path: args.path, namespace: 'kit-stub' } : r
      })
      b.onLoad({ filter: /.*/, namespace: 'kit-stub' }, () => ({
        contents: 'const stub = new Proxy(function(){}, { get: (t, k) => k === "__esModule" ? true : stub, apply: () => stub }); export default stub;',
        loader: 'js' as const,
      }))
    },
  }
  log('Building the stage')
  const result = await build({
    entryPoints: [registry],
    absWorkingDir: folder,
    bundle: true,
    splitting: true,
    format: 'esm',
    outdir: join(work, 'out'),
    jsx: 'automatic',
    platform: 'browser',
    logLevel: 'silent',
    metafile: true,
    nodePaths: [nm],
    plugins: [soften],
    alias: {
      react: join(nm, 'react'),
      'react-dom': join(nm, 'react-dom'),
      ...Object.fromEntries(Object.entries(kit.alias).map(([k, v]) => [k, resolve(folder, v)])),
      'next/navigation': join(own, 'shims/next-navigation.ts'),
      'next/link': join(own, 'shims/next-link.tsx'),
      'next/image': join(own, 'shims/next-image.tsx'),
      'next/dynamic': join(own, 'shims/next-dynamic.tsx'),
    },
    // Environment the product reads: its backend URLs point at the stage itself (the stand-in backend answers them).
    banner: {
      js: "globalThis.process = globalThis.process || { env: new Proxy({ NODE_ENV: 'production' }, { get: (t, k) => k in t ? t[k] : (/(URL|HOST|ORIGIN|ENDPOINT)$/.test(String(k)) ? location.origin : 'kit-stage') }) };",
    },
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.webp': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl' },
  })
  await buildStyles(folder, kit, work, log)
  await writeFile(
    join(work, 'out', 'stage.html'),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="stage.css"></head><body><div id="root"></div><script type="module" src="stage.js"></script></body></html>',
  )
  // The stand-in backend answers every call with an empty, safe value (no sample routes are generated here).
  await writeFile(join(work, 'out', 'backend.json'), JSON.stringify({ now: SAMPLE_NOW, routes: [] }))
  await writeFile(join(work, 'out', 'selects.json'), '{}')
  const keys = await stageKeys(folder, kit, entries, result.metafile as Metafile)
  const dir = join(stageDir, 'stage')
  await rm(dir, { recursive: true, force: true })
  await rename(join(work, 'out'), dir)
  return { dir, entries, keys, commit: await readCommit(folder) }
}

/** Compile the product's styles: its own Tailwind (3 or 4) when it has one, else its stylesheet as it is. */
async function buildStyles(folder: string, kit: StudioKit, work: string, log: (line: string) => void): Promise<void> {
  const out = join(work, 'out', 'stage.css')
  const tail = '\nhtml,body{background:transparent!important;margin:0}\n'
  const css = kit.css ? inFolder(folder, kit.css, 'The stylesheet') : null
  const bin = join(folder, 'node_modules/.bin/tailwindcss')
  if (!css) return writeFile(out, tail)
  if (!kit.tailwind || !existsSync(bin)) return writeFile(out, ((await readText(css)) ?? '') + tail)
  log(`Compiling the styles (Tailwind ${kit.tailwind})`)
  const cli = realpathSync(bin)
  if (kit.tailwind === 3) {
    const config = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs'].map((f) => join(folder, f)).find((f) => existsSync(f))
    await run(process.execPath, [cli, '-i', css, ...(config ? ['-c', config] : []), '-o', out], { cwd: folder, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  } else {
    const sources = ['src', 'app', 'components', 'pages', 'lib']
      .filter((d) => existsSync(join(folder, d)))
      .map((d) => `@source ${JSON.stringify(join(folder, d))};`)
      .join('\n')
    const input = join(work, 'stage.input.css')
    await writeFile(input, `@import ${JSON.stringify(css)};\n${sources}\n`)
    await run(process.execPath, [cli, '-i', input, '-o', out], { cwd: folder, maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  }
  await writeFile(out, ((await readText(out, 64 * 1024 * 1024)) ?? '') + tail)
}

/** Each component's code key, from the product's own files its chunk was built from (by content). */
async function stageKeys(folder: string, kit: StudioKit, entries: CatalogEntry[], metafile: Metafile): Promise<Record<string, string>> {
  const byEntry = new Map<string, string>()
  for (const [name, output] of Object.entries(metafile.outputs)) if (output.entryPoint) byEntry.set(output.entryPoint, name)
  const shaOf = new Map<string, string>()
  const contentSha = async (rel: string) => {
    if (!shaOf.has(rel)) shaOf.set(rel, sha256(new Uint8Array(await readFile(join(folder, rel)).catch(() => new Uint8Array()))))
    return shaOf.get(rel)!
  }
  const cssSha = kit.css ? sha256((await readText(join(folder, kit.css), 4 * 1024 * 1024)) ?? '') : null
  const settings = { alias: kit.alias, tailwind: kit.tailwind, providers: kit.providers ?? [], rootClass: kit.rootClass ?? '', htmlAttributes: kit.htmlAttributes ?? {} }
  const keys: Record<string, string> = {}
  for (const entry of entries) {
    const chunk = byEntry.get(entry.file.split('#')[0])
    const inputs = chunk ? chunkInputs(metafile, chunk) : [entry.file.split('#')[0]!]
    const own = inputs.filter((p) => !isPackagePath(p) && !p.startsWith('..') && !p.startsWith('/'))
    const hashed = await Promise.all(own.map(async (path) => ({ path, sha256: await contentSha(path) })))
    keys[entry.id] = componentKey({ inputs: hashed, settings: { ...settings, component: kit.components[entry.id] ?? null }, css: cssSha }, sha256)
  }
  return keys
}

// ------------------------------------------------------------------------------------------------------------ browser

/** The headless browser to use: STUDIO_BROWSER, one in the product's packages, or Playwright's on this Mac. */
export function findBrowser(folder: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (env.STUDIO_BROWSER && exists(env.STUDIO_BROWSER)) return env.STUDIO_BROWSER
  const shell = (dir: string) => {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((n) => n.startsWith('chromium_headless_shell-')).sort().reverse()
    } catch {
      return null
    }
    for (const name of names) {
      for (const arch of ['mac-arm64', 'mac-x64']) {
        const path = join(dir, name, `chrome-headless-shell-${arch}`, 'chrome-headless-shell')
        if (exists(path)) return path
      }
    }
    return null
  }
  const candidates = [
    join(folder, 'node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell'),
    shell(join(folder, 'node_modules/playwright-core/.local-browsers')),
    shell(join(homedir(), 'Library/Caches/ms-playwright')),
  ]
  return candidates.find((p): p is string => !!p && exists(p)) ?? null
}

/** Start the browser (Playwright over a pipe: no port, no network). */
async function launch(folder: string): Promise<Browser> {
  const path = findBrowser(folder)
  if (!path) throw new Error('No headless browser is readable here. The desktop app provides one for captures (STUDIO_BROWSER); until it does, run npx playwright install chromium-headless-shell on the Mac with PLAYWRIGHT_BROWSERS_PATH=0 in the product folder.')
  const { chromium } = await import('playwright-core')
  return chromium.launch({ executablePath: path, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check'] })
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
}

/**
 * Serve the stage to a page from memory: the stage at /__stage/, the product's public files at the root where its code
 * expects them, /api/ answered empty, and anything on another origin refused (nothing leaves the Mac).
 */
async function serveStage(page: Page, stageDir: string, publicDir: string | null): Promise<void> {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== STAGE_ORIGIN) return route.abort('blockedbyclient')
    const path = decodeURIComponent(url.pathname)
    const [root, rel] = path.startsWith('/__stage/') ? [stageDir, path.slice(9)] : [publicDir, path.slice(1)]
    const file = root ? resolve(root, rel) : null
    if (file && root && file.startsWith(root + sep) && existsSync(file) && (await stat(file)).isFile()) {
      return route.fulfill({ status: 200, headers: { 'content-type': TYPES[file.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' }, body: await readFile(file) })
    }
    return route.fulfill({ status: path.startsWith('/api/') ? 204 : 404, body: '' })
  })
}

/** The stage URL for one job (the job rides in the hash, as the stage runtime reads it). */
const stageUrl = (job: Record<string, unknown>) => `${STAGE_ORIGIN}/__stage/stage.html#${encodeURIComponent(JSON.stringify(job))}`

/** Window state the stage runtime keeps. */
type StageWindow = Window & Record<string, any>

/**
 * Wait until the component mounted, its data calls are answered and the page stopped changing. `advance` moves the
 * page's clock only until the component mounted; then it stays put so the component's animation starts at its beginning.
 */
async function settle(page: Page, advance: (ms: number) => Promise<void>, limitMs = 6000): Promise<void> {
  let last = -1
  let quiet = 0
  const started = Date.now()
  while (Date.now() - started < limitMs) {
    const s = await page.evaluate(() => {
      const w = window as StageWindow
      return { done: w.__mounted === true || String(w.__status ?? '').startsWith('error'), pending: w.__pending ?? 0, changes: w.__changes ?? 0, loading: !!w.__loading?.() }
    })
    if (!s.done) {
      await advance(50)
      quiet = 0
      continue
    }
    if (s.pending > 0) {
      await page.waitForTimeout(30)
      quiet = 0
      continue
    }
    if (s.loading && s.changes === last) await advance(100)
    quiet = s.changes === last && !s.loading ? quiet + 1 : 0
    last = s.changes
    if (quiet >= 4) return
    await page.waitForTimeout(s.loading ? 150 : 120)
  }
}

// -------------------------------------------------------------------------------------------------------------- list

/** Which components render on their own, and the natural size of those that do (two pages at a time). */
async function checkHealth(browser: Browser, stage: Stage, publicDir: string | null): Promise<Record<string, { status: string; w?: number; h?: number }>> {
  const results: Record<string, { status: string; w?: number; h?: number }> = {}
  const queue = stage.entries.slice(0, HEALTH_MAX)
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } })
      await serveStage(page, stage.dir, publicDir)
      for (let e = queue.shift(); e; e = queue.shift()) {
        const job = { component: e.id, props: e.props ?? {}, width: e.width, height: e.curated ? e.height : 0, pad: 0 }
        try {
          await page.goto(stageUrl(job), { timeout: 10_000 })
          await page.waitForFunction(() => (window as StageWindow).__mounted || String((window as StageWindow).__status ?? '').startsWith('error'), null, { timeout: 5000 }).catch(() => {})
          await settle(page, (ms) => page.waitForTimeout(ms), 6000)
          results[e.id] = await page.evaluate(() => {
            const status = String((window as StageWindow).__status ?? 'blank')
            const cap = document.getElementById('cap')!
            const origin = cap.getBoundingClientRect()
            let area = 0
            let right = 0
            let bottom = 0
            for (const el of Array.from(cap.querySelectorAll('#fit *'))) {
              const b = el.getBoundingClientRect()
              const cs = getComputedStyle(el)
              if (b.width < 2 || b.height < 2 || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
              right = Math.max(right, b.right - origin.left)
              bottom = Math.max(bottom, b.bottom - origin.top)
              if (el.children.length === 0 || (el as HTMLElement).innerText?.trim()) area += Math.min(b.width * b.height, 200_000)
            }
            return { status: status !== 'ok' ? status : area > 400 ? 'ok' : 'blank', w: Math.ceil(right), h: Math.ceil(bottom) }
          })
        } catch (x) {
          results[e.id] = { status: 'error: ' + (x as Error).message.split('\n')[0]!.slice(0, 160) }
        }
      }
      await page.close()
    }),
  )
  return results
}

/** List the components: catalog, code keys, and (when a browser is readable) which render and at what size. */
async function list(folder: string, kit: StudioKit, out: string, log: (line: string) => void) {
  const stage = await buildStage(folder, kit, join(out, 'stage'), log)
  let health: Record<string, { status: string; w?: number; h?: number }> = {}
  let browserNote: string | null = null
  try {
    const browser = await launch(folder)
    try {
      health = await checkHealth(browser, stage, kit.public ? inFolder(folder, kit.public, 'The public folder') : null)
    } finally {
      await browser.close()
    }
  } catch (error) {
    browserNote = `Not checked in a browser: ${(error as Error).message.split('\n')[0]}`
  }
  const components = stage.entries.map((e) => {
    const h = health[e.id]
    const sized = !e.curated && h?.status === 'ok' && (h.h ?? 0) >= 24
    return {
      id: e.id,
      name: e.name,
      file: e.file,
      group: e.group,
      help: e.help,
      curated: e.curated,
      width: sized ? Math.round(Math.min(1200, Math.max(240, h!.w!))) : e.width,
      height: sized ? Math.round(Math.min(900, Math.max(40, h!.h!))) : e.height,
      status: h?.status ?? 'unchecked',
      key: stage.keys[e.id]!,
    }
  })
  return { ok: true, components, commit: stage.commit, ...(browserNote ? { note: browserNote } : {}) }
}

// ------------------------------------------------------------------------------------------------------------ capture

/**
 * Render one component on a virtual clock (timers, requestAnimationFrame, CSS and Web Animations advance exactly one
 * frame per shot) into transparent 60 fps footage, or one still. Answers the file, its poster and the code key.
 */
async function capture(folder: string, kit: StudioKit, id: string, options: CaptureOptions, out: string, log: (line: string) => void) {
  const stage = await buildStage(folder, kit, join(out, 'stage'), log)
  const entry = stage.entries.find((e) => e.id === id)
  if (!entry) throw new Error(`${kit.title} has no component "${id}"`)
  const { compileScript } = await import('./stage/kit-script.js')
  const script = (options.script ?? []) as import('./stage/kit-script.js').ScriptStep[]
  const scriptEnd = script.length ? compileScript(script).end / 1000 + 0.8 : 0
  const fps = options.fps ?? 60
  const seconds = Math.min(60, Math.max(0.5, options.seconds ?? 6, scriptEnd))
  const scale = options.scale ?? 2
  const pad = 32
  const width = options.width ?? entry.width
  const height = options.height ?? entry.height
  const solid = typeof options.background === 'string' && /^#[0-9a-fA-F]{6}$/.test(options.background) ? options.background : null
  const ffmpeg = options.still ? null : await findFfmpeg()
  const still = options.still || !ffmpeg
  const frames = still ? 1 : Math.round(seconds * fps)
  const job = {
    component: id,
    props: { ...(entry.props ?? {}), ...(options.props ?? {}) },
    width,
    height,
    theme: options.theme ?? 'light',
    pad,
    ...(script.length ? { script, cursor: options.cursor !== false, drive: 'capture' } : {}),
  }
  await mkdir(join(out, 'frames'), { recursive: true })
  log(`Rendering ${entry.name}${still ? ' (a still)' : ' frame by frame'}`)
  const browser = await launch(folder)
  try {
    const page = await browser.newPage({ viewport: { width: width + pad * 2, height: height + pad * 2 }, deviceScaleFactor: scale })
    await serveStage(page, stage.dir, kit.public ? inFolder(folder, kit.public, 'The public folder') : null)
    await page.clock.install({ time: new Date(SAMPLE_NOW - 1000) })
    await page.clock.pauseAt(new Date(SAMPLE_NOW))
    await page.goto(stageUrl(job), { waitUntil: 'load' })
    await settle(page, async (ms) => {
      await page.clock.runFor(ms)
      await page.waitForTimeout(20)
    }, 8000)
    const status = await page.evaluate(() => (window as StageWindow).__status as string | undefined)
    if (status?.startsWith('error')) throw new Error(`${entry.name} can't render outside the product: ${status.slice(7)}`)
    if (solid) await page.evaluate((color) => { document.body.style.background = color }, solid)
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(() => {
      const w = window as StageWindow
      w.__virtual = 0
      w.__born = new WeakMap()
      w.__syncAnimations = () => {
        for (const a of document.getAnimations()) {
          if (!w.__born.has(a)) w.__born.set(a, w.__virtual)
          a.pause()
          a.currentTime = w.__virtual - w.__born.get(a)
        }
      }
    })
    const advance = async (ms: number) => {
      await page.clock.runFor(ms)
      await page.evaluate((step) => {
        const w = window as StageWindow
        w.__virtual += step
        w.__syncAnimations()
      }, ms)
    }
    await advance(50)
    if (still && options.seconds && options.still) await advance(Math.min(60_000, options.seconds * 1000))
    const box = await page.evaluate(() => {
      const r = document.getElementById('cap')!.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    // Input the script performs by each frame's time, done for real (hover styles, focus and typing as in the product),
    // then a beat for the product to render it before the frame is taken.
    const perform = async (ops: { kind: string; x?: number; y?: number; text?: string; key?: string }[]) => {
      for (const op of ops) {
        if (op.kind === 'move') await page.mouse.move(op.x!, op.y!)
        else if (op.kind === 'down') await page.mouse.down()
        else if (op.kind === 'up') await page.mouse.up()
        else if (op.kind === 'type') await page.keyboard.type(op.text!)
        else await page.keyboard.press(op.key!)
      }
      if (ops.length) await page.evaluate(() => new Promise((done) => { const c = new MessageChannel(); c.port1.onmessage = () => done(null); c.port2.postMessage(0) }))
    }
    for (let i = 0; i < frames; i++) {
      if (script.length && !still) await perform(await page.evaluate((t) => (window as StageWindow).__scriptAt?.(t) ?? [], (i * 1000) / fps))
      await page.screenshot({ path: join(out, 'frames', `${String(i).padStart(5, '0')}.png`), omitBackground: !solid, animations: 'allow', clip: box, timeout: 15_000 })
      if (!still) await advance(1000 / fps)
      if (i % 60 === 0 && i) log(`${Math.round((i / frames) * 100)}%`)
    }
  } finally {
    await browser.close()
  }
  const base = `${kit.slug}-${id.slice(0, 60)}`
  const poster = join(out, `${base}-poster.png`)
  await copyFile(join(out, 'frames', '00000.png'), poster)
  let file = poster
  if (!still && ffmpeg) {
    log('Encoding the footage')
    file = join(out, `${base}.webm`)
    const args = ['-nostdin', '-y', '-v', 'error', '-framerate', String(fps), '-i', join(out, 'frames', '%05d.png'), '-c:v', 'libvpx-vp9', '-pix_fmt', solid ? 'yuv420p' : 'yuva420p', '-b:v', '0', '-crf', '18', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', file]
    await run(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, timeout: 900_000 })
  }
  await rm(join(out, 'frames'), { recursive: true, force: true })
  const fullWidth = width + pad * 2
  const fullHeight = height + pad * 2
  return {
    ok: true,
    kind: file === poster ? 'still' : 'video',
    file,
    poster,
    name: `${kit.title} · ${entry.name}${file === poster ? '.png' : '.webm'}`,
    width: fullWidth,
    height: fullHeight,
    aspect: +(fullWidth / fullHeight).toFixed(4),
    seconds: file === poster ? 0 : seconds,
    key: stage.keys[id]!,
    commit: stage.commit,
    ...(!options.still && !ffmpeg ? { note: 'ffmpeg is not on this Mac, so this is a still. Install ffmpeg (brew install ffmpeg) for footage.' } : {}),
  }
}

/** ffmpeg on the PATH (or Homebrew's), or null. */
async function findFfmpeg(): Promise<string | null> {
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const path = join(dir, 'ffmpeg')
    if (dir && existsSync(path)) return path
  }
  return null
}

// --------------------------------------------------------------------------------------------------------------- main

/** The request a list or capture reads: the kit (the app's record) and, for a capture, the component and its options. */
type Request = { kit: StudioKit; component?: string; options?: CaptureOptions }

/** Run one command and answer its JSON. Errors answer `{ ok: false, error }`. */
export async function main(argv: string[], folder = process.cwd()): Promise<number> {
  const [command, a, b] = argv
  const out = resolve(command === 'onboard' ? (a ?? '.') : (b ?? '.'))
  const log = (line: string) => process.stderr.write(`${line}\n`)
  let answer: unknown
  try {
    await mkdir(out, { recursive: true })
    if (command === 'onboard') {
      const detected = detectProduct(await readFacts(folder))
      answer = detected.ok ? { ...detected, commit: await readCommit(folder) } : { ok: false, error: detected.reason }
    } else if (command === 'list' || command === 'capture') {
      const request = JSON.parse(await readFile(resolve(a ?? ''), 'utf8')) as Request
      if (!request.kit || typeof request.kit !== 'object') throw new Error('The request has no product settings')
      answer = command === 'list' ? await list(folder, request.kit, out, log) : await capture(folder, request.kit, String(request.component ?? ''), request.options ?? {}, out, log)
    } else {
      answer = { ok: false, error: 'Usage: runner.cjs onboard <out> | list <request.json> <out> | capture <request.json> <out>' }
    }
  } catch (error) {
    answer = { ok: false, error: error instanceof Error ? error.message.split('\n')[0]!.slice(0, 500) : String(error) }
  }
  const text = JSON.stringify(answer)
  await writeFile(join(out, 'result.json'), text).catch(() => {})
  process.stdout.write(text + '\n')
  return (answer as { ok?: boolean }).ok ? 0 : 1
}

if (process.argv[1] && /runner\.(cjs|ts)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
