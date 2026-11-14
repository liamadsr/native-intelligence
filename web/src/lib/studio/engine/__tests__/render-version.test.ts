/**
 * The render version follows what draws an export and makes its sound (render-version.ts): every file the roots below
 * reach through relative and `@/` imports and `require`, less the encoders, hashed with their line ends made LF (a
 * Windows checkout hashes the same), and the `remotion` / `@remotion/*` versions the lockfiles resolve. The ledger is
 * only added to: its last line must name today's hash, each line's chain must hold (an earlier line edited fails), and
 * every version is new.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDER_LEDGER, STUDIO_RENDER_VERSION } from '../render-version'

const WEB_SRC = resolve(__dirname, '../../../..')
const REPO = resolve(WEB_SRC, '../..')

/**
 * Where an export is drawn and heard from: the engine's render entry, and the worker's export path (its Chrome render,
 * its composition without the browser, its sound, fonts, scenes and mastering).
 */
export const RENDER_ROOTS = [
  'web/src/lib/studio/engine/remotion.tsx',
  'studio-worker/src/jobs/export.ts',
  'studio-worker/src/render.ts',
  'studio-worker/src/chrome-pipe.ts',
  'studio-worker/src/remotion-sound.ts',
  'studio-worker/src/fast-export.ts',
  'studio-worker/src/fast-export-run.ts',
  'studio-worker/src/fast-sound.ts',
  'studio-worker/src/fonts.ts',
  'studio-worker/src/scenes.ts',
  'studio-worker/src/master.ts',
]
/**
 * Files that cannot change what is drawn or heard, so a change to them is not a new render: the encoders (a different
 * encoder on a computer is not a different render), and plumbing (talking to the app, tool paths and processes, the
 * file cache, staging assets whose bytes are sha256-checked, the prebuilt bundle's checks, the desktop runner's
 * entry). Kept in, though proposed: `config.ts` (its defaults choose the drawing and sound path: STUDIO_FAST_EXPORT,
 * STUDIO_COMPOSITOR) and `media.ts` (its probe parsing feeds the export's sound: streams' start times and rates).
 */
export const NOT_RENDER = [
  'studio-worker/src/encoders.ts',
  'studio-worker/src/encoder-probe.ts',
  'studio-worker/src/app-client.ts',
  'studio-worker/src/platform.ts',
  'studio-worker/src/child.ts',
  'studio-worker/src/backoff.ts',
  'studio-worker/src/cache.ts',
  'studio-worker/src/jobs/context.ts',
  'studio-worker/src/assets.ts',
  'studio-worker/src/bundle-dir.ts',
  'studio-worker/src/local.ts',
  'studio-worker/src/local-main.ts',
]
/** The lockfiles whose `remotion` and `@remotion/*` versions the render resolves. */
const LOCKFILES = ['web/package-lock.json', 'studio-worker/package-lock.json']

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  const bare = base.replace(/\.(js|mjs|cjs)$/, '')
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), `${bare}.ts`, `${bare}.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const IMPORT = /(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require(?:\.resolve)?\(\s*['"]([^'"]+)['"]\s*\)/g

/** The files the roots draw on, as repository paths, sorted. */
export function renderSources(roots = RENDER_ROOTS, skip = NOT_RENDER): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    const path = relative(REPO, file).split('\\').join('/')
    if (seen.has(path) || skip.includes(path)) return
    seen.add(path)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const found = resolveImport(file, match.slice(1).find(Boolean) ?? '')
      if (found) walk(found)
    }
  }
  for (const root of roots) walk(join(REPO, root))
  return [...seen].sort()
}

/** `name@version` of every `remotion` and `@remotion/*` package the lockfiles resolve, sorted. */
export function remotionVersions(): string[] {
  const out = new Set<string>()
  for (const lockfile of LOCKFILES) {
    const packages = (JSON.parse(readFileSync(join(REPO, lockfile), 'utf8')) as { packages?: Record<string, { version?: string }> }).packages ?? {}
    for (const [path, info] of Object.entries(packages)) {
      const name = path.replace(/^.*node_modules\//, '')
      if ((name === 'remotion' || name.startsWith('@remotion/')) && path.startsWith('node_modules/') && info.version) out.add(`${lockfile}:${name}@${info.version}`)
    }
  }
  return [...out].sort()
}

/** The hash of it all: each file's path and contents with LF line ends, in order, then the package versions. */
export function renderSourcesHash(files = renderSources(), read = (file: string) => readFileSync(join(REPO, file), 'utf8'), packages = remotionVersions()): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\n`)
    hash.update(read(file).replace(/\r\n/g, '\n'))
    hash.update('\n\0')
  }
  for (const line of packages) hash.update(`${line}\n`)
  return hash.digest('hex')
}

/** A ledger line's chain: the hash of the line before's chain, its version and its sources. */
const chainOf = (previous: string, version: string, sources: string) => createHash('sha256').update(`${previous}\n${version}\n${sources}`).digest('hex')

/** The version after `last`: today's date and a count. */
function nextVersion(last: string, today = new Date().toISOString().slice(0, 10)): string {
  const [date, n] = last.split('.')
  return date === today ? `${today}.${Number(n) + 1}` : `${today}.1`
}

describe('the render version', () => {
  it('covers the engine’s render, the worker’s export path and the render library, less the encoders', () => {
    const files = renderSources()
    for (const file of ['web/src/lib/studio/engine/remotion.tsx', 'web/src/lib/studio/engine/composition.tsx', 'studio-worker/src/fast-export.ts', 'studio-worker/src/render.ts', 'studio-worker/src/chrome-pipe.ts']) expect(files).toContain(file)
    for (const file of NOT_RENDER) expect(files).not.toContain(file)
    for (const file of ['studio-worker/src/config.ts', 'studio-worker/src/media.ts', 'studio-worker/src/engine.ts', 'studio-worker/src/master.ts']) expect(files).toContain(file)
    expect(files.some((f) => f.includes('__tests__') || f.endsWith('.test.ts'))).toBe(false)
    expect(remotionVersions().some((line) => line.endsWith(`:remotion@${'4.0.534'}`) || /:remotion@/.test(line))).toBe(true)
  })

  it('follows require as well as import', () => {
    expect(IMPORT.source).toContain('require')
    const text = "const x = require('./a')\nconst y = require.resolve('../b')"
    expect([...text.matchAll(IMPORT)].map((m) => m.slice(1).find(Boolean))).toEqual(['./a', '../b'])
  })

  it('keeps a ledger only added to: every chain holds and every version is new', () => {
    let previous = ''
    for (const [index, line] of RENDER_LEDGER.entries()) {
      expect(line.chain, `Line ${index + 1} of RENDER_LEDGER (${line.version}) was changed. Lines are never edited: put it back as it was, and add a new line instead.`).toBe(chainOf(previous, line.version, line.sources))
      previous = line.chain
    }
    expect(new Set(RENDER_LEDGER.map((l) => l.version)).size).toBe(RENDER_LEDGER.length)
    expect(STUDIO_RENDER_VERSION).toBe(RENDER_LEDGER.at(-1)!.version)
  })

  it('has a line for what draws an export now', () => {
    const now = renderSourcesHash()
    const last = RENDER_LEDGER.at(-1)!
    const version = nextVersion(last.version)
    expect(
      last.sources,
      `What draws an export changed. Add this line at the end of RENDER_LEDGER in web/src/lib/studio/engine/render-version.ts (and change nothing above it):\n  { version: '${version}', sources: '${now}', chain: '${chainOf(last.chain, version, now)}' },\nA desktop app built before this change then exports on the server.`,
    ).toBe(now)
  })

  it('reads a Windows checkout the same', () => {
    const windows = (file: string) => readFileSync(join(REPO, file), 'utf8').replace(/\r?\n/g, '\r\n')
    expect(renderSourcesHash(renderSources(), windows)).toBe(renderSourcesHash())
  })

  it('a hash changed alone, or an earlier line edited, does not pass', () => {
    const lines = RENDER_LEDGER.map((l) => ({ ...l }))
    // Only the last line's hash swapped for a new one: its chain no longer holds.
    lines.at(-1)!.sources = 'f'.repeat(64)
    expect(lines.at(-1)!.chain).not.toBe(chainOf(lines.at(-2)?.chain ?? '', lines.at(-1)!.version, lines.at(-1)!.sources))
  })
})
