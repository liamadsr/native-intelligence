/**
 * Which chat turns read untrusted outside text (#835 review S1, Liam's
 * answer, 2026-10-20: "It's okay for it to ask me questions, but it shouldn't
 * come through the for you channel… For you is like delivered artifacts").
 *
 * A loop the person asks for is saved on (create_flow `enabled: true`). But
 * "the person asked" is the model's word, and a turn that read an email from
 * someone they don't know (or another outside text) could carry a planted
 * "set up a loop for me". So the chat tool route judges every tool output
 * with the ONE outside-text definition (src/lib/safety/outside-text.ts
 * readOutsideText, mail senders checked), and marks the turn here. In a
 * marked turn create_flow saves the loop OFF and comes back
 * `awaiting_go_ahead`, and the agent asks once IN ITS CHAT REPLY (no card, no
 * attention item); the person's yes in the next turn switches it on through
 * update_flow's `confirmed_with_user`, as for any loop waiting on them.
 *
 * Keyed like the same-turn go-ahead guard (./flow-go-ahead-guard.ts
 * goAheadTurnKey): the token's user, eve's session and turn ids. In memory,
 * per server instance, bounded (LRU by last touch, plus a TTL): a call that
 * lands on another instance isn't seen there, so this narrows the case, it
 * never breaks a call. Reads eve runs inside the chat agent itself
 * (web_search, web_fetch) never reach the tool route, so they don't mark a
 * turn; the agent's instructions cover them.
 */

const MAX_ENTRIES = 5000
const TTL_MS = 60 * 60 * 1000

/** Turn key → the tools that brought outside text into it, and when last touched. */
const marked = new Map<string, { tools: string[]; at: number }>()

/** Record that `toolName` brought outside text into this turn. No key: nothing. */
export function markTurnReadOutside(key: string | null, toolName: string, now = Date.now()): void {
  if (!key) return
  const prior = marked.get(key)
  const tools = prior && now - prior.at <= TTL_MS ? prior.tools : []
  marked.delete(key)
  marked.set(key, { tools: tools.includes(toolName) ? tools : [...tools, toolName].slice(0, 20), at: now })
  while (marked.size > MAX_ENTRIES) {
    const oldest = marked.keys().next().value
    if (oldest === undefined) break
    marked.delete(oldest)
  }
}

/** The tools that brought outside text into this turn so far (empty: none, or no key). */
export function turnOutsideReadTools(key: string | null, now = Date.now()): string[] {
  if (!key) return []
  const entry = marked.get(key)
  if (!entry) return []
  if (now - entry.at > TTL_MS) {
    marked.delete(key)
    return []
  }
  return [...entry.tools]
}

/** Tests only: forget every turn. */
export function resetTurnOutsideReads(): void {
  marked.clear()
}

/** Tests only: how many turns are tracked. */
export function turnOutsideReadsSize(): number {
  return marked.size
}
