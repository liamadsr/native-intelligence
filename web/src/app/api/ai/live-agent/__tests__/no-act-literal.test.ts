/**
 * Guard test (evals spec §5.1): NO extraction call site may hardcode
 * `mode: 'act'` into `decideAutoApply`.
 *
 * WHY THIS EXISTS: the extraction authority has no mode of its own, so its call
 * sites historically passed the literal `'act'`. The eval isolation depends on
 * every one deriving the mode from the CAPTURE (`gateModeForCapture`) instead.
 * The failure this guards is the obvious one: someone copies the
 * loop again, or reverts it, and a synthetic mock sales call auto-files real
 * actions onto a real board — silently, because everything else about the eval
 * path keeps working.
 *
 * It reads the SOURCE rather than executing it: the routes pull in the whole
 * server import graph (next/headers, the gateway, Supabase), and the invariant
 * is textual anyway — "this literal does not appear here".
 *
 * SCOPE: every source under the live-agent route directory, AND `src/lib/evals/`
 * — another copy of the same call shape. The eval engine has one earned
 * exemption, spelled out and itself tested at the bottom of this file.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE_DIR = join(process.cwd(), 'src/app/api/ai/live-agent')
const EVALS_DIR = join(process.cwd(), 'src/lib/evals')

/**
 * The ONE `authority: 'extraction'` call site allowed to carry the literal, and
 * why. Written down here rather than left outside the glob so the exemption is a
 * decision a future reader can weigh, not a gap they never notice.
 *
 * `run-trial.ts` re-runs the pure gate over a proposal that has ALREADY been
 * staged, purely to record `gate.would_have_applied` in the trace. `act` is the
 * correct mode for a counterfactual — asking "would this have applied on a real
 * capture" in report mode would always answer no — and nothing acts on the
 * result: it is a boolean in a jsonb blob. If this file ever grows a code path
 * that WRITES from that decision, it belongs on the routes' rule, not here.
 */
const EVAL_ACT_LITERAL_ALLOWLIST = ['run-trial.ts'] as const

/** Every .ts file under a tree, excluding tests. */
function tsSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsSources(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = tsSources(ROUTE_DIR)

// `mode:'act'` / `mode: "act"` in any spacing or quote style.
const ACT_LITERAL = /\bmode\s*:\s*['"]act['"]/

describe('live-agent routes — no hardcoded gate mode', () => {
  it('finds the route sources it is supposed to police', () => {
    // A silently-empty glob would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThanOrEqual(1)
    const rel = files.map((f) => f.slice(ROUTE_DIR.length + 1))
    expect(rel).toContain('route.ts')
  })

  it("contains no `mode: 'act'` literal anywhere", () => {
    const offenders = files
      .filter((f) => ACT_LITERAL.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(ROUTE_DIR.length + 1))
    expect(offenders).toEqual([])
  })

  it('derives the mode from the capture at every decideAutoApply call site', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const calls = src.split('decideAutoApply(').length - 1
      if (calls === 0) continue
      // Every call site passes gateModeForCapture(...), and the module is
      // imported rather than shadowed by a local helper of the same name.
      expect(src).toMatch(/from '@\/lib\/proposed-changes\/auto-apply-gate'/)
      expect(src).toContain('gateModeForCapture')
      const derived = src.split(/mode:\s*gateModeForCapture\(/).length - 1
      expect(derived).toBe(calls)
    }
  })

  it('the extraction route selects is_eval from the capture row it reads', () => {
    // gateModeForCapture is total — a row missing the column resolves to 'act'.
    // So forgetting the column in the SELECT is exactly the failure that would
    // make the helper look correct while fencing nothing.
    const src = readFileSync(join(ROUTE_DIR, 'route.ts'), 'utf8')
    expect(src).toMatch(/\.select\('[^']*\bis_eval\b[^']*'\)/)
  })
})

/**
 * The same rule, extended to the Evals engine — because the failure this whole
 * file guards is "someone copies the loop a THIRD time", and the third copy now
 * exists in `src/lib/evals/`. It calls `decideAutoApply` with the same
 * `authority: 'extraction'` the two routes do, so the glob that polices them has
 * to reach it or the guard is aimed at the two sites least likely to drift.
 */
describe('evals engine — no unaudited gate mode', () => {
  const evalFiles = tsSources(EVALS_DIR)

  it('finds the eval sources it is supposed to police', () => {
    expect(evalFiles.length).toBeGreaterThan(0)
    expect(evalFiles.map((f) => f.slice(EVALS_DIR.length + 1))).toContain('run-trial.ts')
  })

  it("contains no `mode: 'act'` literal outside the counterfactual allowlist", () => {
    const offenders = evalFiles
      .filter((f) => ACT_LITERAL.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(EVALS_DIR.length + 1))
      .filter((rel) => !(EVAL_ACT_LITERAL_ALLOWLIST as readonly string[]).includes(rel))
    expect(offenders).toEqual([])
  })

  it('keeps the allowlist honest — an entry that no longer carries the literal is stale', () => {
    // An allowlist nobody prunes is how an exemption outlives its reason.
    for (const rel of EVAL_ACT_LITERAL_ALLOWLIST) {
      expect(ACT_LITERAL.test(readFileSync(join(EVALS_DIR, rel), 'utf8'))).toBe(true)
    }
  })

  it('the allowlisted counterfactual never applies what it decides', () => {
    // The exemption is earned by the result being INERT. `run-trial` may read
    // the gate's answer into the trace; it must not create entities, mark
    // proposals applied, or write the board off the back of it.
    const src = readFileSync(join(EVALS_DIR, 'run-trial.ts'), 'utf8')
    expect(src).toContain('would_have_applied')
    expect(src).not.toMatch(/auto_accepted/)
    expect(src).not.toMatch(/status:\s*['"]applied['"]/)
  })
})
