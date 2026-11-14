/**
 * What the desktop app carries to export on the person's own computer (local.ts), built into one folder:
 *
 *   node --import tsx scripts/build-local-runner.ts <out-dir> [--no-bundle]
 *     → <out>/runner/runner.cjs              the local runner, one CommonJS file (esbuild), for the app's pinned Node
 *     → <out>/runner/node_modules/…          what stays a package: @remotion/renderer and what it needs at run time
 *                                             (its platform compositor left out: see the notices)
 *     → <out>/render-bundle/                 the engine's render bundle, built here once (STUDIO_BUNDLE_DIR), with
 *                                             studio-render.json (render version, Remotion version)
 *     → <out>/NOTICES.md                     every third-party piece in it and its licence
 *     → <out>/sizes.json                     what each part weighs
 *
 * Not in it (the desktop build adds them): Node itself, FFmpeg and ffprobe (our LGPL build with the system encoders),
 * Chrome's headless shell. The runner is told where they are (local-main.ts: --ffmpeg, --ffprobe, --chrome).
 *
 * The worker's sources load the app's engine files with `createRequire(import.meta.url)`, which a bundler cannot
 * follow; here that `require` is the bundle's own, so esbuild takes the files in.
 */
import { build, type Plugin } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** The sources' `createRequire(import.meta.url)` made the bundle's own `require`, so esbuild follows those files. */
const ownRequire: Plugin = {
  name: 'own-require',
  setup(b) {
    b.onLoad({ filter: /[\\/](studio-worker[\\/]src|web[\\/]src[\\/]lib[\\/]studio)[\\/].*\.tsx?$/ }, async (args) => {
      const text = await readFile(args.path, 'utf8')
      const contents = text
        .replace(/^const require = createRequire\(import\.meta\.url\)\s*$/gm, '')
        .replace(/createRequire\(import\.meta\.url\)\(/g, 'require(')
      return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }
    })
  },
}

/** Packages kept as packages: the renderer (it finds its own files and its compositor by path) and the bundler (not shipped: a prebuilt bundle is used). */
export const EXTERNAL = ['@remotion/renderer', 'remotion', '@remotion/bundler', 'esbuild', 'playwright-core', 'fsevents']

async function size(path: string): Promise<number> {
  const s = await stat(path).catch(() => null)
  if (!s) return 0
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of await readdir(path)) n += await size(join(path, e))
  return n
}

/** The packages a package needs at run time, itself included (dependencies and required peers, recursively; optional ones only for this platform). */
function closure(name: string, from: string, seen = new Map<string, string>()): Map<string, string> {
  if (seen.has(name)) return seen
  let pkgFile: string
  try { pkgFile = createRequire(join(from, 'x.js')).resolve(`${name}/package.json`) } catch { return seen }
  const dir = dirname(pkgFile)
  seen.set(name, dir)
  const pkg = JSON.parse(require('node:fs').readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }
  for (const dep of Object.keys(pkg.dependencies ?? {})) closure(dep, dir, seen)
  // Peers too (remotion wants react and react-dom), unless they say they are optional.
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) if (!pkg.peerDependenciesMeta?.[dep]?.optional) closure(dep, dir, seen)
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (dep.includes(process.platform) && dep.includes(process.arch)) closure(dep, dir, seen)
  return seen
}

/** A package's licence as its package.json says it. */
function licence(dir: string): string {
  try { return String((JSON.parse(require('node:fs').readFileSync(join(dir, 'package.json'), 'utf8')) as { license?: unknown }).license ?? 'see the package') } catch { return 'unknown' }
}

/**
 * The render version's test (web: engine/__tests__/render-version.test.ts), run first: no bundle is built whose render
 * version disagrees with the sources it is built from (a desktop app would export as a version it is not).
 */
function renderVersionHolds(): void {
  const web = resolve(ROOT, '../web')
  const vitest = join(web, 'node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest')
  const r = spawnSync(vitest, ['run', 'src/lib/studio/engine/__tests__/render-version.test.ts'], { cwd: web, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => /render version|STUDIO_RENDER_VERSION|ledger|append|FAIL|Error/i.test(l)).slice(0, 20).join('\n'))
    throw new Error('the render version does not match its sources: append the line its test prints to web/src/lib/studio/engine/render-version.ts, then build')
  }
}

async function main() {
  const out = resolve(process.argv[2] ?? join(ROOT, '.local-runner'))
  const withBundle = !process.argv.includes('--no-bundle')
  if (!process.argv.includes('--skip-version-check')) renderVersionHolds()
  await rm(out, { recursive: true, force: true })
  const runner = join(out, 'runner')
  await mkdir(runner, { recursive: true })

  // ---- the runner ------------------------------------------------------------------------------------------------
  const result = await build({
    entryPoints: [join(ROOT, 'src/local-main.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    outfile: join(runner, 'runner.cjs'), external: EXTERNAL, plugins: [ownRequire], logLevel: 'warning', metafile: true,
    // import.meta.url in a CommonJS file: this file's own URL.
    define: { 'import.meta.url': '__runner_url', 'import.meta.dirname': '__dirname' },
    banner: { js: "const __runner_url = require('node:url').pathToFileURL(__filename).href;" },
    loader: { '.py': 'text' },
  })
  const inputs = Object.keys(result.metafile.inputs)

  // ---- the packages it keeps -------------------------------------------------------------------------------------
  // Remotion's compositor package carries a GPL FFmpeg with x264, x265 and fdk-aac: it is left out (NOTICES.md says
  // what that costs: the paths that ask Remotion to stitch or mix with its own FFmpeg).
  const keep = closure('@remotion/renderer', ROOT)
  const left: string[] = []
  for (const [name, dir] of keep) {
    if (/^@remotion\/compositor-/.test(name)) { left.push(name); continue }
    await cp(dir, join(runner, 'node_modules', name), { recursive: true, dereference: true })
  }

  // ---- the render bundle -----------------------------------------------------------------------------------------
  if (withBundle) {
    const { buildRenderBundle } = await import('../src/render.ts')
    await buildRenderBundle(resolve(ROOT, '../web/src/lib/studio/engine'), join(out, 'render-bundle'), join(out, '.bundling'))
  }

  // ---- notices ---------------------------------------------------------------------------------------------------
  const packages = [...keep.entries()].filter(([n]) => !left.includes(n)).map(([n, d]) => `- ${n} (${licence(d)})`)
  // Each compiled-in package, by the folder its files came from (the worker's node_modules or the app's).
  const bundledDirs = new Map<string, string>()
  for (const i of inputs) {
    const m = /^(.*node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+))/.exec(i)
    if (m && !bundledDirs.has(m[2]!)) bundledDirs.set(m[2]!, resolve(m[1]!))
  }
  const bundled = [...bundledDirs.keys()].sort()
  const notices = [
    '# Third-party pieces in the Studio\'s local runner', '',
    'Kept as packages (runner/node_modules):', ...packages, '',
    'Compiled into runner.cjs:', ...bundled.map((n) => `- ${n} (${licence(bundledDirs.get(n)!)})`), '',
    'Left out:', ...left.map((n) => `- ${n}: Remotion's FFmpeg build (GPL, with libx264, libx265 and libfdk-aac).`), '',
    'Not in this folder, added by the desktop build: Node.js (MIT), FFmpeg and ffprobe (LGPL build, system encoders), Chrome headless shell (BSD-3-Clause and its own notices).',
    'Remotion (@remotion/*) is under the Remotion License: its terms are the owner\'s matter.', '',
  ].join('\n')
  await writeFile(join(out, 'NOTICES.md'), notices)

  const sizes = { runnerCjs: await size(join(runner, 'runner.cjs')), runnerNodeModules: await size(join(runner, 'node_modules')),
    renderBundle: await size(join(out, 'render-bundle')), sourcesCompiled: inputs.length, packagesKept: packages.length, leftOut: left }
  await writeFile(join(out, 'sizes.json'), JSON.stringify(sizes, null, 2))
  console.log(JSON.stringify({ out: relative(process.cwd(), out) || out, ...sizes }))
  if (!existsSync(join(runner, 'runner.cjs'))) process.exit(1)
}

main().catch((err) => { console.error(err); process.exit(1) })
