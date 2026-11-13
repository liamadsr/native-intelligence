/**
 * The render version follows what draws an export (render-version.ts): every file the render's entry point imports
 * and the worker's composition without the browser, followed through relative and `@/` imports, hashed with their line
 * ends made LF (a Windows checkout hashes the same). A change to any of them without a new version fails here, with
 * the hash to write.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDER_SOURCES_SHA256, STUDIO_RENDER_VERSION } from '../render-version'

const WEB_SRC = resolve(__dirname, '../../../..')
const REPO = resolve(WEB_SRC, '../..')
/** Where an export is drawn from: the engine's render entry, and the worker's composition without the browser. */
export const RENDER_ROOTS = [
  'web/src/lib/studio/engine/remotion.tsx',
  'studio-worker/src/fast-export.ts',
  'studio-worker/src/fast-export-run.ts',
  'studio-worker/src/fast-sound.ts',
]

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(WEB_SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  // A worker file names another by its .js or .ts name.
  const bare = base.replace(/\.(js|mjs)$/, '')
  for (const candidate of [`${bare}.ts`, `${bare}.tsx`]) if (existsSync(candidate)) return candidate
  return null
}

const IMPORT = /(?:import|export)\s[^'";]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g

/** The files the roots draw on, as repository paths, sorted. */
export function renderSources(roots = RENDER_ROOTS): string[] {
  const seen = new Set<string>()
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const found = resolveImport(file, match[1] ?? match[2] ?? match[3] ?? '')
      if (found) walk(found)
    }
  }
  for (const root of roots) walk(join(REPO, root))
  return [...seen].map((file) => relative(REPO, file).split('\\').join('/')).sort()
}

/** Their hash: each path and its contents with LF line ends, in order. */
export function renderSourcesHash(files = renderSources(), read = (file: string) => readFileSync(join(REPO, file), 'utf8')): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`${file}\n`)
    hash.update(read(file).replace(/\r\n/g, '\n'))
    hash.update('\n\0')
  }
  return hash.digest('hex')
}

describe('the render version', () => {
  it('covers the engine’s render and the worker’s composition', () => {
    const files = renderSources()
    expect(files).toContain('web/src/lib/studio/engine/remotion.tsx')
    expect(files).toContain('web/src/lib/studio/engine/composition.tsx')
    expect(files).toContain('studio-worker/src/fast-export.ts')
    expect(files.some((f) => f.includes('__tests__') || f.endsWith('.test.ts'))).toBe(false)
  })

  it('changes whenever what draws an export changes', () => {
    const now = renderSourcesHash()
    expect(
      now,
      `What draws an export changed: set STUDIO_RENDER_VERSION in web/src/lib/studio/engine/render-version.ts to a new value (it is now ${STUDIO_RENDER_VERSION}) and RENDER_SOURCES_SHA256 to '${now}'. A desktop app built before this change then exports on the server.`,
    ).toBe(RENDER_SOURCES_SHA256)
  })

  it('reads a Windows checkout the same', () => {
    // The same files checked out with CRLF line ends hash the same.
    const windows = (file: string) => readFileSync(join(REPO, file), 'utf8').replace(/\r?\n/g, '\r\n')
    expect(renderSourcesHash(renderSources(), windows)).toBe(renderSourcesHash())
  })
})
