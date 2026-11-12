/**
 * The Studio's server code never loads the video player. A server module that imports an engine module that imports
 * React, Remotion or a `@remotion/` package fails at module load, and with it every Studio API route (it happened
 * once: an engine helper that imported `@remotion/fonts`). This walks the import graph from every Studio server,
 * agent and tool module and every Studio route, by reading the files (no TypeScript program: fast), following
 * relative and `@/` imports (static, re-exports and dynamic `import()`), skipping type-only ones, and fails naming
 * the chain to any module that imports one of those packages.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** The packages the server must never load. */
export function forbidden(specifier: string): boolean {
  return /^(react|react-dom|remotion)(\/|$)/.test(specifier) || specifier.startsWith('@remotion/')
}

/** Comments out of the way (block comments and whole-line `//` comments), so an example in a doc comment is not an import. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** True when an import's clause brings in only types: `type X`, `type { X }`, or `{ type X, type Y }`. */
function typeOnly(clause: string): boolean {
  const c = clause.trim()
  if (/^type\b/.test(c)) return true
  const braces = /^\{([\s\S]*)\}$/.exec(c)
  if (!braces) return false
  const names = braces[1]!.split(',').map((n) => n.trim()).filter(Boolean)
  return names.length > 0 && names.every((n) => /^type\s/.test(n))
}

/**
 * The modules a source file loads at run time: `import … from`, `export … from`, `import '…'` and `import('…')`,
 * leaving out type-only imports and re-exports.
 */
export function runtimeImports(source: string): string[] {
  const text = withoutComments(source)
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|[;\n])\s*(import|export)\s+([\w*{}\s,$]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (!typeOnly(m[2]!)) out.push(m[3]!)
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/g)) out.push(m[1]!)
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']

/** A relative or `@/` specifier as a file under src/, or null (a package, or something that isn't code). */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/') ? join(SRC, specifier.slice(2)) : specifier.startsWith('.') ? resolve(dirname(from), specifier) : null
  if (!base) return null
  for (const ext of EXTENSIONS) {
    const path = base + ext
    if (existsSync(path) && statSync(path).isFile() && /\.(ts|tsx|js|mjs)$/.test(path)) return path
  }
  return null
}

/** Every .ts/.tsx file under a folder, tests left out. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : filesUnder(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Where the walk starts: the Studio's server, agent and tool modules and its routes. */
function entryFiles(): string[] {
  const tools = readdirSync(join(SRC, 'lib/ai/tools')).filter((n) => /^studio.*\.ts$/.test(n)).map((n) => join(SRC, 'lib/ai/tools', n))
  return [
    ...filesUnder(join(SRC, 'lib/studio/server')),
    ...filesUnder(join(SRC, 'lib/studio/agent')),
    ...tools,
    ...filesUnder(join(SRC, 'app/api/account/studio')),
    ...filesUnder(join(SRC, 'app/api/internal/studio')),
  ]
}

/** Each chain (entry → … → module → package) to a forbidden package, one per offending module. */
export function forbiddenChains(entries: string[], read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string[][] {
  const parent = new Map<string, string | null>()
  const queue: string[] = []
  for (const e of entries) if (!parent.has(e)) { parent.set(e, null); queue.push(e) }
  const chains: string[][] = []
  const chainTo = (file: string) => {
    const chain: string[] = []
    for (let at: string | null | undefined = file; at; at = parent.get(at)) chain.unshift(relative(ROOT, at))
    return chain
  }
  while (queue.length) {
    const file = queue.shift()!
    for (const specifier of runtimeImports(read(file))) {
      if (forbidden(specifier)) { chains.push([...chainTo(file), specifier]); continue }
      const next = resolveLocal(file, specifier)
      if (next && !parent.has(next)) { parent.set(next, file); queue.push(next) }
    }
  }
  return chains
}

describe('the Studio server never imports the video player', () => {
  it('reads runtime imports and skips type-only ones', () => {
    const source = [
      "import type { EditorProject } from '../engine/contracts'",
      "import { type A, type B } from './types-only'",
      "import { value, type C } from './mixed'",
      "import React from 'react'",
      "export { x } from './again'",
      "export type { Y } from './just-types'",
      "export * from './star'",
      "import './side-effect'",
      "const lazy = () => import('@/lib/lazy')",
      '/** import { Player } from "@remotion/player" in a comment */',
      "// import { Composition } from 'remotion'",
      "import {\n  Thing,\n  type Other,\n} from './multi-line'",
    ].join('\n')
    expect(runtimeImports(source).sort()).toEqual(['./again', './mixed', './multi-line', './side-effect', './star', '@/lib/lazy', 'react'].sort())
    expect(['react', 'react-dom/server', 'react/jsx-runtime', 'remotion', '@remotion/fonts'].every(forbidden)).toBe(true)
    expect(['react-markdown', 'remotion-x', 'zod', '@/lib/react'].some(forbidden)).toBe(false)
  })

  it('names the chain when a server module imports an engine module that loads the player', () => {
    // A made-up server module importing the engine's composition (React and Remotion), the real files after it.
    const entry = join(SRC, 'lib/studio/server/made-up-entry.ts')
    const read = (p: string) => (p === entry ? "import { StudioComposition } from '../engine/composition'" : readFileSync(p, 'utf8'))
    const chains = forbiddenChains([entry], read)
    expect(chains.length).toBeGreaterThan(0)
    expect(chains[0]!.slice(0, 2)).toEqual(['src/lib/studio/server/made-up-entry.ts', 'src/lib/studio/engine/composition.tsx'])
    expect(forbidden(chains[0]!.at(-1)!)).toBe(true)
    // The same import as a type only is fine.
    expect(forbiddenChains([entry], (p) => (p === entry ? "import type { StudioComposition } from '../engine/composition'" : ''))).toEqual([])
  })

  it('from every Studio server, agent and tool module and every Studio route', () => {
    const entries = entryFiles()
    expect(entries.length).toBeGreaterThan(30)
    expect(entries.some((e) => e.endsWith('lib/ai/tools/studio.ts'))).toBe(true)
    expect(entries.some((e) => e.includes('app/api/account/studio') && e.endsWith('route.ts'))).toBe(true)
    const chains = forbiddenChains(entries)
    expect(chains.map((c) => c.join(' → ')), 'a server module reaches the video player (import it with `import type`, or move the value out of the engine module that imports React or Remotion)').toEqual([])
  })
})
