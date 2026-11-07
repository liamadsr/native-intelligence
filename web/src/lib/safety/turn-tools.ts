/**
 * The tools already run in one turn, for action.review's input ("the tools
 * run this turn", A5 slice 2): a call that follows read_email is judged
 * against that, a call out of nowhere against nothing. In memory and per
 * instance, like the go-ahead guard (src/lib/chat/flow-go-ahead-guard.ts): a
 * missed entry only leaves the reviewer a shorter list. Bounded: at most
 * MAX_TURNS turns, MAX_NAMES names each, dropped after TTL_MS.
 */
const MAX_TURNS = 500
const MAX_NAMES = 30
const TTL_MS = 15 * 60 * 1000

const turns = new Map<string, { names: string[]; at: number }>()

/** A turn's key from its parts (a user, a session, a turn; or a run), or null when a part is missing. */
export function turnToolsKey(...parts: unknown[]): string | null {
  if (!parts.length || parts.some((part) => typeof part !== 'string' || !part || part.length > 200)) return null
  return parts.join(':')
}

/** Record a tool that ran in the turn. */
export function noteTurnTool(key: string | null, toolName: string): void {
  if (!key) return
  const now = Date.now()
  const entry = turns.get(key)
  const names = entry && now - entry.at < TTL_MS ? entry.names : []
  turns.delete(key)
  turns.set(key, { names: [...names, toolName].slice(-MAX_NAMES), at: now })
  while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value as string)
}

/** The tools run so far in the turn, oldest first. */
export function turnTools(key: string | null): string[] {
  if (!key) return []
  const entry = turns.get(key)
  if (!entry || Date.now() - entry.at >= TTL_MS) return []
  return [...entry.names]
}

/** Tests only. */
export function resetTurnTools(): void {
  turns.clear()
}
