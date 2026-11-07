import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

/**
 * Keeps shiki and framer-motion off the dashboard shell's first-load path.
 *
 * Every module the shell reaches through STATIC imports ships in the JS the
 * browser fetches and parses before the dashboard hydrates (measured on a
 * production build: 37 chunks, ~4.2 MB). Two heavy libraries rode that path
 * for surfaces that rarely show anything:
 *   shiki          184 KB chunk — needed only once a reply has a code block
 *                  (code-block.tsx now imports it on first use)
 *   framer-motion  118 KB chunk — among others, via the onboarding coach,
 *                  spotlight and checklist (since deleted: onboarding is the
 *                  main agent's getting-started skill now)
 * And one that never rode it: border-beam, listen mode's pulse around the
 * window being read, which every content window mounts the frame for
 * (components/read-aloud/listen-frame.tsx) but which only draws once listen
 * mode is on, so the frame fetches it then. Likewise metal-fx, the liquid-metal
 * pill the Listen mode toggle sits in while listen mode is off: the toggle is
 * in the top bar the shell draws, and fetches ./listen-metal (and with it
 * metal-fx) the first time it shows, which only the desktop app ever does.
 *
 * Sibling of views/__tests__/heavy-dep-splitting.test.ts, which pins single
 * import sites. This one walks the whole static graph from the shell's client
 * entries, because the property is about MODULE GRAPH SHAPE: a new static
 * import anywhere below the shell re-adds the library, which no render of the
 * component tree can observe.
 */

const ROOT = process.cwd()
const DASHBOARD = 'src/app/account/(dashboard)'
/** The shell's client entries, as `(dashboard)/layout.tsx` renders them. */
const ENTRIES = [`${DASHBOARD}/dashboard-shell.tsx`, `${DASHBOARD}/dashboard-error-boundary.tsx`]
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs']

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/')
    ? join(ROOT, 'src', spec.slice(2))
    : resolve(dirname(from), spec)
  const candidates = [
    base,
    ...EXTENSIONS.map((e) => base + e),
    ...EXTENSIONS.map((e) => join(base, `index${e}`)),
  ]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null
}

/**
 * Specifiers a module imports at load time: every `import … from` and
 * `export … from`, except the `import type` / `export type` forms, which are
 * erased. Inline `{ type X }` specifiers still count — under
 * verbatimModuleSyntax the import itself survives. `import()` is not a
 * top-level statement, so dynamic imports are (correctly) not edges.
 */
function staticSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const specs: string[] = []
  for (const st of source.statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) {
      specs.push((st.moduleSpecifier as ts.StringLiteral).text)
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) {
      specs.push((st.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return specs
}

/** Walk the static graph: local files reached, and which of them import each package. */
function walk(entries: string[]) {
  const files = new Set(entries.map((e) => join(ROOT, e)))
  const importers = new Map<string, Set<string>>()
  const queue = [...files]
  while (queue.length) {
    const file = queue.shift()!
    if (!/\.(tsx?|jsx?|mjs)$/.test(file)) continue
    for (const spec of staticSpecifiers(file)) {
      if (spec.startsWith('.') || spec.startsWith('@/')) {
        const target = resolveLocal(file, spec)
        if (target && !files.has(target)) {
          files.add(target)
          queue.push(target)
        }
        continue
      }
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!importers.has(pkg)) importers.set(pkg, new Set())
      importers.get(pkg)!.add(relative(ROOT, file))
    }
  }
  return {
    has: (path: string) => files.has(join(ROOT, path)),
    importersOf: (pkg: string) => [...(importers.get(pkg) ?? [])].sort(),
    size: files.size,
  }
}

const shell = walk(ENTRIES)
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('dashboard shell static import graph', () => {
  it('actually walks the shell (guards against a resolver that silently finds nothing)', () => {
    expect(shell.size).toBeGreaterThan(200)
    expect(shell.has(`${DASHBOARD}/chat/chat-panel.tsx`)).toBe(true)
    expect(shell.has('src/components/ui/code-block.tsx')).toBe(true)
  })

  it('reaches no static import of shiki', () => {
    expect(shell.importersOf('shiki')).toEqual([])
  })

  it('code-block fetches shiki on first use instead', () => {
    const src = strip(readFileSync(join(ROOT, 'src/components/ui/code-block.tsx'), 'utf8'))
    expect(src).toMatch(/import\("shiki"\)/)
    // Type-only imports are erased and cost nothing; a value import is the regression.
    expect(src).not.toMatch(/^import (?!type\b)[^\n]* from ["']shiki["']/m)
  })

  it('reaches no static import of border-beam: the listen frame fetches it on its first pulse', () => {
    expect(shell.has('src/components/read-aloud/listen-frame.tsx')).toBe(true)
    expect(shell.importersOf('border-beam')).toEqual([])
    const frame = strip(readFileSync(join(ROOT, 'src/components/read-aloud/listen-frame.tsx'), 'utf8'))
    expect(frame).toMatch(/import\('border-beam'\)/)
    // Type-only imports are erased and cost nothing; a value import is the regression.
    expect(frame).not.toMatch(/^import (?!type\b)[^\n]* from ["']border-beam["']/m)
  })

  it('reaches no static import of metal-fx: the Listen mode toggle fetches its metal the first time one shows', () => {
    expect(shell.has('src/components/read-aloud/listen-mode-toggle.tsx')).toBe(true)
    expect(shell.has('src/components/read-aloud/listen-metal.tsx')).toBe(false)
    expect(shell.importersOf('metal-fx')).toEqual([])
    const toggle = strip(readFileSync(join(ROOT, 'src/components/read-aloud/listen-mode-toggle.tsx'), 'utf8'))
    expect(toggle).toMatch(/import\('\.\/listen-metal'\)/)
    // Type-only imports are erased and cost nothing; a value import is the regression.
    expect(toggle).not.toMatch(/^import (?!type\b)[^\n]* from ["'](metal-fx|\.\/listen-metal)["']/m)
  })

  it('reaches framer-motion only through the surfaces not yet deferred', () => {
    // A ratchet. These three still import framer-motion statically and show at
    // first paint or react instantly (the voice nudge,
    // confetti, the create-workspace modal), so deferring them is a visible
    // trade-off of its own. Adding an importer fails here; so does deferring
    // one — then delete it from the list. When the list is empty, framer-motion
    // is off the first-load path.
    expect(shell.importersOf('framer-motion')).toEqual([
      'src/app/account/create-workspace-wizard.tsx',
      'src/components/celebration/celebration-overlay.tsx',
      'src/components/voice-enrollment/voice-nudge-card.tsx',
    ])
  })
})
