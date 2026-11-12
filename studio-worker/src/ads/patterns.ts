/**
 * A brand kit's copy rules are its author's regular expressions, run on the ad's words. A pattern that backtracks
 * without end ((a+)+$ on a long word) would freeze the worker's one thread, so each match runs in a separate V8
 * context with a hard time limit (vm's `timeout` interrupts the regular expression itself). A pattern that runs
 * out of time is reported as a check error naming its rule, never waited on. The contract refuses the usual shapes
 * of such a pattern before a kit is saved (patternProblem); this is the backstop.
 */
import { createContext, Script } from 'node:vm'
import type { Finding } from '../../../web/src/lib/studio/server/ads-contract.ts'

/** How long one pattern may take on one ad's words. */
export const PATTERN_MS = 250

const script = new Script('(() => { const m = new RegExp(pattern, flags).exec(text); return m ? m[0] : null })()')

export class PatternTimeout extends Error {
  constructor(readonly pattern: string) {
    super('the pattern took too long')
    this.name = 'PatternTimeout'
  }
}

/** The first match of `pattern` in `text` (case-insensitive), or null. Throws PatternTimeout past `ms`, or for a pattern that is not one. */
export function matchPattern(pattern: string, text: string, ms = PATTERN_MS): string | null {
  const context = createContext({ pattern: String(pattern), flags: 'i', text: String(text) })
  try {
    const found = script.runInContext(context, { timeout: ms }) as unknown
    return typeof found === 'string' ? found : null
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new PatternTimeout(pattern)
    throw err
  }
}

/**
 * The copy rules that hit `text`: each an error with the words it matched. A rule with `unless` is lifted when that also
 * matches. A pattern that takes too long or can't be read is an error naming its rule.
 */
export function copyRuleFindings(rules: readonly { pattern: string; rule: string; why: string; unless?: string }[], text: string, ms = PATTERN_MS): Finding[] {
  const out: Finding[] = []
  for (const r of rules) {
    try {
      const hit = matchPattern(r.pattern, text, ms)
      if (hit === null) continue
      if (r.unless && matchPattern(r.unless, text, ms) !== null) continue
      out.push({ level: 'error', rule: r.rule, message: `${r.why}: "${hit}"` })
    } catch (err) {
      out.push({ level: 'error', rule: r.rule, message: err instanceof PatternTimeout ? `The copy rule's pattern took too long and was stopped (check it for nested repeats like (a+)+); the copy was not checked against ${r.rule}` : `The copy rule's pattern could not be run (${(err as Error).message.slice(0, 120)})` })
    }
  }
  return out
}
