/**
 * Read-side isolation guard for EVAL captures.
 *
 * An eval capture (`captures.is_eval`, migration 252) is a synthetic mock
 * meeting: a real `captures` row, so the unmodified live-agent engine can run
 * against it. That realism is the whole design, and it is also the risk — every
 * reader of `captures` will happily hand a mock sales call to a user, a CRM
 * card, an outreach draft, or the vector index unless it is fenced.
 *
 * RLS cannot be that fence (docs/plans/evals.md §5.2): three things the feature
 * itself depends on run `SELECT ... FROM captures` as the caller's
 * `authenticated` role, and Postgres permissive policies OR together, so a
 * companion allow-policy would re-admit eval rows everywhere. The fence is an
 * app predicate, and this test is what keeps it from rotting: a reader added
 * next quarter that neither goes through the shared visibility helpers nor
 * carries its own `is_eval` predicate fails CI.
 *
 * ── What counts, and why it is PER-QUERY ────────────────────────────────────
 * The check is structural, not textual. It walks every `from('captures')`
 * OCCURRENCE over comment-stripped source and asks whether THAT query is
 * fenced. A whole-file `source.includes('is_eval')` (what this guard used to
 * do) is defeated by one prose mention: src/lib/live-agent/tools.ts has six
 * capture queries and exactly one `is_eval`, inside a JSDoc block — it passed
 * the old check on a comment, and so would any new leaker that happened to
 * mention the column in a doc comment.
 *
 * An occurrence needs a fence only when it is a BROAD READ. Two shapes are
 * exempt by construction, which is the same reasoning docs/plans/evals.md §5.2
 * used to rank readers:
 *   - a WRITE (.insert/.update/.upsert/.delete) does not surface a row to
 *     anyone, so there is nothing to leak;
 *   - an ID-ADDRESSED read (.eq('id', …)) can only reach an eval capture for a
 *     caller who already holds its id — the id is the fence.
 * Everything else (a workspace-wide list, a series lookup, a join filter) must
 * carry `is_eval` within its own chain, or the file must import one of the
 * shared visibility helpers, which default-exclude eval captures.
 *
 * The ALLOWLIST below is the honest P1 backlog — broad readers that exist today
 * and are NOT yet fenced. It is deliberately explicit rather than a pattern:
 * adding a NEW file to it is a decision someone has to write down.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(process.cwd(), 'src')

/** The reads this guard is about. */
const CAPTURES_READ = "from('captures')"

/**
 * A file is fenced wholesale if it imports one of the shared capture-visibility
 * helpers (which default-EXCLUDE eval captures — see src/lib/ai/tools/_shared.ts).
 */
const SHARED_HELPERS = [
  'applyCaptureVisibility',
  'applyEmbeddedCaptureVisibility',
  'captureRequester',
  'isCaptureVisible',
  'captureVisibleToRequester',
] as const

/**
 * P1: broad reads that are not yet fenced.
 *
 * Every entry reads `captures` without an eval predicate and without being
 * id-addressed. They are ranked below the P0 tier in docs/plans/evals.md §5.2
 * because each is either gated by `metadata.demo` (which every eval capture
 * also sets), reachable only from a surface an eval capture cannot enter, or
 * writes nothing a user reads. Fencing them is P1 work; until then this list is
 * the record of what is outstanding.
 */
const ALLOWLIST: readonly string[] = [
  'src/app/account/(dashboard)/views/project-detail-panel.tsx',
  'src/app/api/account/attachments/route.ts',
  'src/app/api/account/captures/[id]/link-event/route.ts',
  'src/app/api/account/captures/[id]/resume/route.ts',
  'src/app/api/account/captures/by-event/route.ts',
  'src/app/api/account/captures/from-event/route.ts',
  'src/app/api/account/projects/[id]/move/preflight/route.ts',
  // DELETE TEARDOWN, not a surface. The project-delete route (knowledge-pulse
  // fix, migration 263) enumerates a project's capture ids purely to feed them
  // one by one to delete_capture_with_knowledge — nothing it reads reaches a
  // user, a card, a draft or the index, which is the same reasoning that makes
  // a `.delete()` chain exempt by construction. Fencing it would be actively
  // WRONG: an eval capture that somehow carried a project_id would survive the
  // teardown with a dangling pointer, which is the orphan this route exists to
  // prevent.
  'src/app/api/account/projects/[id]/route.ts',
  'src/app/api/account/projects/route.ts',
  'src/lib/ai/system-prompt.ts',
  'src/lib/captures/series-history.ts',
  'src/lib/flows/context-pack.ts',
  'src/lib/flows/proposal-age-out.ts',
  'src/lib/inngest/flow-functions.ts',
  'src/lib/integrations/calendar-sync.ts',
  'src/lib/knowledge/claim-visibility.ts',
  'src/lib/wiki/render.ts',
]

/** Every .ts/.tsx under src/, minus __tests__ dirs and the evals lib itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      sourceFiles(full, out)
      continue
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
    out.push(full)
  }
  return out
}

/** Repo-relative, POSIX-separated, so the allowlist reads the same everywhere. */
function repoPath(full: string): string {
  return join('src', relative(SRC, full)).split(sep).join('/')
}

/**
 * Blank out comments so nothing in prose can satisfy the fence, preserving byte
 * offsets and newlines so reported line numbers stay true. String and template
 * literals are copied through verbatim — a `//` inside a URL is not a comment.
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const d = source[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '')
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i++
          break
        }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** The query chain a builder opens with: enough to see its filters, bounded so
 *  one query's fence can never be credited to the next one. */
const CHAIN_WINDOW = 900
/** A write surfaces no row, so there is nothing for an eval capture to leak into. */
const WRITE_CHAIN = /^\s*\.(insert|update|upsert|delete)\s*\(/
/** An id-addressed read is fenced by the id: reaching an eval row needs its id. */
const ID_ADDRESSED = /\.eq\(\s*'id'\s*,/
/** A real predicate/guard on the column, not a mention of its name in prose. */
const EVAL_PREDICATE = /is_eval/

const IMPORT_BLOCK = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]*['"]/g

/**
 * Only an actual IMPORT of a shared helper counts — a file that merely mentions
 * `isCaptureVisible` in a comment (flows/emit-capture-processed.ts does) is not
 * fenced by it. Comments are already stripped, but the import shape is what
 * makes the intent unambiguous.
 */
function importsSharedHelper(stripped: string): boolean {
  for (const [, named] of stripped.matchAll(IMPORT_BLOCK)) {
    const imported = named.split(',').map((n) => n.trim().split(/\s+as\s+/)[0].trim())
    if (SHARED_HELPERS.some((h) => imported.includes(h))) return true
  }
  return false
}

/**
 * The 1-based line of every BROAD `from('captures')` read in this source that
 * carries no eval fence. Empty means the file is clean.
 *
 * Exported so the self-test below can drive it with synthetic sources — the
 * guard is only worth having if it is itself proven to fail on a leaker.
 */
export function unfencedCaptureReads(source: string): number[] {
  const stripped = stripComments(source)
  const helperFenced = importsSharedHelper(stripped)
  const lines: number[] = []
  let idx = stripped.indexOf(CAPTURES_READ)
  while (idx !== -1) {
    const start = idx + CAPTURES_READ.length
    const rest = stripped.slice(start, start + CHAIN_WINDOW)
    // Stop at the next captures query so a later fence can't cover this one.
    const next = rest.indexOf(CAPTURES_READ)
    const chain = next === -1 ? rest : rest.slice(0, next)
    const exempt = WRITE_CHAIN.test(chain) || ID_ADDRESSED.test(chain)
    if (!exempt && !helperFenced && !EVAL_PREDICATE.test(chain)) {
      lines.push(stripped.slice(0, idx).split('\n').length)
    }
    idx = stripped.indexOf(CAPTURES_READ, idx + 1)
  }
  return lines
}

const unfenced = sourceFiles(SRC)
  .map((full) => ({ path: repoPath(full), source: readFileSync(full, 'utf8') }))
  // The Evals lib is the ONE surface that reads eval captures on purpose.
  .filter(({ path }) => !path.startsWith('src/lib/evals/'))
  .filter(({ source }) => source.includes(CAPTURES_READ))
  .filter(({ source }) => unfencedCaptureReads(source).length > 0)
  .map(({ path }) => path)

describe('captures read-side eval isolation', () => {
  it('every broad captures read is fenced, or explicitly allowlisted as P1', () => {
    const unexpected = unfenced.filter((p) => !ALLOWLIST.includes(p))
    expect(
      unexpected,
      unexpected.length === 0
        ? ''
        : `These files have a BROAD ${CAPTURES_READ} read with no eval fence:\n` +
            unexpected.map((p) => `  - ${p}`).join('\n') +
            `\n\nFix ONE of:\n` +
            `  1. add an explicit .neq('is_eval', true) to that query (or select ` +
            `is_eval and skip the row), or\n` +
            `  2. route the read through a shared helper in src/lib/ai/tools/_shared.ts ` +
            `(${SHARED_HELPERS.join(' / ')}), which default-excludes eval captures, or\n` +
            `  3. if the reader genuinely cannot be fenced yet, add it to ALLOWLIST in ` +
            `this file with a note saying why.\n` +
            `Writes and .eq('id', …) reads need nothing — they are exempt by construction.\n` +
            `See docs/plans/evals.md §5.2.`,
    ).toEqual([])
  })

  it('the allowlist has no stale entries', () => {
    const stale = ALLOWLIST.filter((p) => !unfenced.includes(p))
    expect(
      stale,
      stale.length === 0
        ? ''
        : `These ALLOWLIST entries are no longer unfenced readers — delete them:\n` +
            stale.map((p) => `  - ${p}`).join('\n'),
    ).toEqual([])
  })

  it('the P0 readers are fenced (they must never regress into the allowlist)', () => {
    const p0 = [
      'src/app/api/account/captures/route.ts',
      'src/lib/ai/index-capture-finished.ts',
      'src/lib/inngest/capture-reindex.ts',
      'src/lib/crm/company-context.ts',
      'src/lib/crm/person-context.ts',
      'src/lib/email/outreach-draft-generator.ts',
      'src/lib/views/query-engine.ts',
      'src/app/api/account/dashboard/route.ts',
    ]
    for (const p of p0) {
      expect(ALLOWLIST, `${p} must stay fenced, never allowlisted`).not.toContain(p)
      expect(unfenced, `${p} lost its eval fence`).not.toContain(p)
    }
  })

  // ── The guard's own self-test ─────────────────────────────────────────────
  // A guard nobody has watched fail is a guard that cannot fail. These drive
  // `unfencedCaptureReads` with synthetic sources covering exactly the holes
  // the old whole-file `source.includes('is_eval')` left open.

  const BROAD_READ = `
    const { data } = await supabase
      .from('captures')
      .select('id, title, transcript')
      .eq('workspace_id', ws)
      .order('started_at')
  `

  it('SELF-TEST: a plain broad read is reported', () => {
    expect(unfencedCaptureReads(BROAD_READ)).toHaveLength(1)
  })

  it('SELF-TEST: a doc comment naming is_eval does NOT fence a broad read', () => {
    // The exact hole the old guard had: one prose mention cleared the file.
    const planted = `/** This runs against an EVAL capture (\`captures.is_eval\`). */${BROAD_READ}`
    expect(unfencedCaptureReads(planted)).toHaveLength(1)
    // …and a line comment is no different.
    expect(unfencedCaptureReads(`// see captures.is_eval\n${BROAD_READ}`)).toHaveLength(1)
  })

  it('SELF-TEST: one fenced query does NOT cover a second unfenced one', () => {
    const fenced = BROAD_READ.replace(".order('started_at')", ".neq('is_eval', true)")
    const both = `${fenced}\n${BROAD_READ}`
    // Only the second is reported, and it is reported by its own line.
    expect(unfencedCaptureReads(both)).toHaveLength(1)
    expect(unfencedCaptureReads(both)[0]).toBeGreaterThan(fenced.split('\n').length - 2)
  })

  it('SELF-TEST: a real predicate fences, in either of its shapes', () => {
    expect(
      unfencedCaptureReads(BROAD_READ.replace(".order('started_at')", ".neq('is_eval', true)")),
    ).toEqual([])
    // Selecting the column for a downstream TS guard (capture-reindex.ts's shape).
    expect(
      unfencedCaptureReads(BROAD_READ.replace("'id, title, transcript'", "'id, title, is_eval'")),
    ).toEqual([])
  })

  it('SELF-TEST: writes and id-addressed reads are exempt', () => {
    expect(unfencedCaptureReads(`await s.from('captures').update({ title }).eq('workspace_id', ws)`)).toEqual([])
    expect(unfencedCaptureReads(`await s.from('captures').insert(row).select('id').single()`)).toEqual([])
    expect(unfencedCaptureReads(`await s.from('captures').select('title').eq('id', captureId)`)).toEqual([])
  })

  it('SELF-TEST: a shared-helper IMPORT fences, a mention of one does not', () => {
    const withImport = `import { applyCaptureVisibility } from '@/lib/ai/tools/_shared'\n${BROAD_READ}`
    expect(unfencedCaptureReads(withImport)).toEqual([])
    expect(unfencedCaptureReads(`// we should use applyCaptureVisibility here\n${BROAD_READ}`)).toHaveLength(1)
  })
})
