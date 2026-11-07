/**
 * What the `cards` turn-context section cost this turn
 * (docs/plans/one-agent-and-chat-pages.md, "The agent sees what the card
 * shows", rule 7: measured). The turn-context resolver
 * (../instructions/turn-context.ts) records the tokens it actually sent for
 * the section, 0 when the diff left it out, and the usage meter
 * (../hooks/usage-meter.ts) adds the figure to the turn's usage report, so it
 * lands next to the turn's tokens in the usage row's metadata.
 *
 * Durable per-session state, keyed by the turn it was measured for: the meter
 * settles at the turn's end, often in another process, and a figure from an
 * earlier turn is never reported for this one.
 */
import { defineState } from 'eve/context'

export interface CardContextSize {
  turnId: string | null
  tokens: number
}

const size = defineState<CardContextSize>('chat-agent.card-context-size', () => ({ turnId: null, tokens: 0 }))

/** The tokens of one section's body in a rendered turn-context block (four characters a token), 0 when the block does not carry it. */
export function sectionTokens(block: string | null, key: string): number {
  if (!block) return 0
  const open = new RegExp(`^<section key="${key}" v="[0-9a-f]{12}">$`, 'm')
  const m = open.exec(block)
  if (!m) return 0
  const start = m.index + m[0].length + 1
  const end = block.indexOf('\n</section>', start)
  return end < 0 ? 0 : Math.ceil((end - start) / 4)
}

/** Record what the section cost for `turnId`. Never throws: a measurement must not break a turn. */
export function recordCardContextSize(turnId: string | null, tokens: number): void {
  try {
    size.update(() => ({ turnId, tokens }))
  } catch {
    /* no eve context (a test, a replay without state): nothing to record */
  }
}

/** The section's cost for `turnId`, or null when this turn recorded none. */
export function cardContextSizeFor(turnId: string): number | null {
  try {
    const s = size.get()
    return s && s.turnId === turnId && typeof s.tokens === 'number' ? s.tokens : null
  } catch {
    return null
  }
}
