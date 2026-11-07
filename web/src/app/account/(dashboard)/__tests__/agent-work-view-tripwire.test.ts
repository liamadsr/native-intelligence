/**
 * Tripwire (bots-v4 Phase 7b): the Agents page is gone, and its view id with
 * it. Each bot has its own page (the teammate-chat view); nothing opens,
 * lists, labels or preloads an `'agent-work'` view.
 *
 * WHAT IT MATCHES. In every .ts / .tsx / .js / .mjs file under src/: the
 * string `agent-work` standing alone between quotes, the way a view id is
 * written: `'agent-work'`, `"agent-work"` or a backtick-quoted `agent-work`.
 * It does NOT match the route `/api/account/agent-work` (it stays: `?light=1`
 * and `?teammate=`), module and file names (`agent-work-provider`,
 * `agent-work-lanes`, `use-agent-work`), channel names
 * (`agent-work-${n}`) or log prefixes (`[agent-work]`), since none of those
 * has a quote on both sides of the bare id.
 *
 * WHERE IT MAY STAY. Only in this file: since chats hold no pages (P5), no
 * saved entry for the page is read back any more.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const VIEW_ID = /(['"`])agent-work\1/g
const ALLOWED_FILES = new Set([
  ['src', 'app', 'account', '(dashboard)', '__tests__', 'agent-work-view-tripwire.test.ts'].join(sep),
])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path)
  }
  return out
}

/** Every view-id match in `text`, as `file:line`. */
function hits(file: string, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(VIEW_ID)) {
    const at = m.index ?? 0
    out.push(`${file}:${text.slice(0, at).split('\n').length}`)
  }
  return out
}

describe('the Agents page’s view id is gone (bots-v4 Phase 7b)', () => {
  it('no quoted `agent-work` view id anywhere in src/', () => {
    const found: string[] = []
    for (const path of sourceFiles(SRC)) {
      const file = relative(ROOT, path)
      if (ALLOWED_FILES.has(file)) continue
      const text = readFileSync(path, 'utf8')
      found.push(...hits(file, text))
    }
    expect(found).toEqual([])
  })

  it('matches the view id quoted any way, and not the route, module names or channels', () => {
    const sample = [
      `view: 'agent-work'`,
      `view === "agent-work"`,
      'case `agent-work`:',
      `fetch('/api/account/agent-work?light=1')`,
      `import { x } from '@/components/work/agent-work-provider'`,
      'const CHANNEL = `agent-work-${n}`',
      `console.error('[agent-work] failed')`,
    ].join('\n')
    expect(hits('sample.ts', sample)).toEqual(['sample.ts:1', 'sample.ts:2', 'sample.ts:3'])
  })
})
