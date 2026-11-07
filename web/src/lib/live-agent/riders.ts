/**
 * Live-agent riders: sections of the system prompt a turn carries only when it
 * needs them (live sidekick Phase 7, "skills by need", v1).
 *
 * A turn used to carry instructions for tools or context it does not have: a
 * notes or batch turn was told about say_to_user, a turn with no attached
 * packages read the packages section, a turn with no connected-MCP block read
 * the propose_mcp_call lines. Each rider below names one such section by
 * anchors into the existing prompt constants (prompts.ts), and the pure rules
 * in selectRiderOmissions decide, per turn, which ones the turn does without.
 *
 * Three rules hold everywhere:
 *   - Riders only ever REMOVE a section. With no omissions the composed prompt
 *     is byte-identical to the full one (composeLiveAgentSystemPrompt).
 *   - The constants themselves never change: cutRiders cuts a COPY at
 *     composition time, so every test that reads BASE_SYSTEM_PROMPT /
 *     LIVE_ASSIST_BASE_PROMPT / ASSISTANT_PERSONA reads them unchanged.
 *   - Fail open: an unknown input keeps the section, and a cut whose anchors
 *     are missing from the text cuts nothing. The persona cuts apply to the
 *     built-in ASSISTANT_PERSONA only, never to a DB recipe's text.
 *
 * Selection is server-side rules over values the cloud route already holds (no
 * new reads, no model call). The route signs the result into the run token
 * (`omit`), and the spec rebuild passes it to the composer, so the route and
 * the eve session agree on one prompt. The inputs only change when the prompt
 * should change (a package attached or detached mid-call, MCP availability,
 * the turn type), so within a call the cached prefix stays stable; there is no
 * per-call latch in v1.
 */
import type { LiveAgentTurnType } from './ceiling'

/** The v1 riders. */
export type RiderId = 'packages' | 'mcp-propose' | 'talk'

/**
 * Which text a cut applies to: BASE_SYSTEM_PROMPT, LIVE_ASSIST_BASE_PROMPT, or
 * the built-in ASSISTANT_PERSONA.
 */
export type RiderScope = 'base' | 'assist' | 'persona'

/**
 * One cut: everything from `start` (inclusive) up to the first `end` after it
 * (exclusive). Both are exact substrings of the scope's constant, each found
 * exactly once there (pinned by test). Anchors end a section at the start of
 * the next one, so a cut takes the section's trailing blank line with it and
 * the remaining sections keep their `\n\n` joins.
 */
export interface RiderCut {
  in: RiderScope
  start: string
  end: string
}

export interface Rider {
  id: RiderId
  cuts: readonly RiderCut[]
}

/** The registry, in the canonical order omissions are listed in. */
export const RIDERS: readonly Rider[] = [
  {
    // Kept on a live turn whose package manifest is non-empty.
    id: 'packages',
    cuts: [
      { in: 'base', start: '## Attached Context Packages\n\n', end: '## Research Before Proposing' },
      { in: 'assist', start: '## Attached Context Packages\n\n', end: '## Voice ID and Speaker Names' },
    ],
  },
  {
    // Kept on a writer turn (not assist-only) whose connected-MCP block is
    // non-empty. The assist-only base never mentions propose_mcp_call.
    id: 'mcp-propose',
    cuts: [
      { in: 'base', start: '- **propose_mcp_call** — ', end: '- **edit_proposal** — ' },
      { in: 'base', start: '**External MCP proposals:**', end: '**Accepted items are NOT frozen.**' },
    ],
  },
  {
    // Kept on a copilot turn: notes and batch turns have no one to talk to
    // (the paired note-taker's map withholds the talk tools). The persona's
    // self-harm exception, which names say_to_user, is NOT in this cut.
    id: 'talk',
    cuts: [
      { in: 'base', start: '\n- **say_to_user** — ', end: '\n\n## Tool Usage' },
      {
        in: 'persona',
        start: '## While the conversation is live, be useful in it',
        end: 'A commitment is a commitment whatever the context.',
      },
    ],
  },
]

/** Every registered rider id, in registry order. */
export const RIDER_IDS: readonly RiderId[] = RIDERS.map((r) => r.id)

export function isRiderId(value: unknown): value is RiderId {
  return typeof value === 'string' && (RIDER_IDS as readonly string[]).includes(value)
}

/**
 * A validated omission list: registered ids only (unknown values dropped),
 * once each, in registry order. Anything that is not an array is no list.
 */
export function normalizeRiderOmissions(value: unknown): RiderId[] {
  if (!Array.isArray(value)) return []
  const wanted = new Set(value.filter(isRiderId))
  return RIDER_IDS.filter((id) => wanted.has(id))
}

export interface RiderSelectionInput {
  turnType: LiveAgentTurnType | null | undefined
  /** The resolved persona is assist-only (the turn reads LIVE_ASSIST_BASE_PROMPT). */
  assistOnly: boolean | null | undefined
  /** The turn's package manifest is non-empty (always false on a batch). */
  hasPackages: boolean | null | undefined
  /** The turn's connected-MCP block is non-empty. */
  hasMcpBlock: boolean | null | undefined
  /** No recipe persona resolved: the turn reads the built-in ASSISTANT_PERSONA. */
  builtInPersona: boolean | null | undefined
}

/**
 * The riders this turn does without, in registry order. Pure.
 *
 * A rider is omitted only when its keep-condition is KNOWN to be false (any
 * unknown input keeps it), and only when one of its cuts applies to a text the
 * turn actually renders (the base it reads, and the persona when built-in), so
 * the list names exactly what was cut. An unknown `assistOnly` (which base?)
 * keeps everything.
 */
export function selectRiderOmissions(input: RiderSelectionInput): RiderId[] {
  const { turnType, assistOnly, hasPackages, hasMcpBlock, builtInPersona } = input
  if (typeof assistOnly !== 'boolean') return []

  const omit = new Set<RiderId>()
  if (hasPackages === false) omit.add('packages')
  if (assistOnly || hasMcpBlock === false) omit.add('mcp-propose')
  if (turnType === 'notes' || turnType === 'batch') omit.add('talk')

  const scopes = new Set<RiderScope>([assistOnly ? 'assist' : 'base'])
  if (builtInPersona === true) scopes.add('persona')
  return RIDERS.filter((r) => omit.has(r.id) && r.cuts.some((c) => scopes.has(c.in))).map((r) => r.id)
}

/**
 * `text` with every cut of the omitted riders for `scope` removed. Pure. With
 * nothing to omit it returns `text` itself. A cut whose start or end anchor is
 * not found cuts nothing (fail open to the full text).
 */
export function cutRiders(text: string, omit: readonly RiderId[] | null | undefined, scope: RiderScope): string {
  if (!omit || omit.length === 0) return text
  let out = text
  for (const rider of RIDERS) {
    if (!omit.includes(rider.id)) continue
    for (const cut of rider.cuts) {
      if (cut.in !== scope) continue
      const start = out.indexOf(cut.start)
      if (start < 0) continue
      const end = out.indexOf(cut.end, start + cut.start.length)
      if (end < 0) continue
      out = out.slice(0, start) + out.slice(end)
    }
  }
  return out
}
