import { createHash } from 'node:crypto'

/**
 * The catalog stamp — a fingerprint of the tool list this server is currently
 * exposing.
 *
 * THE PROBLEM IT NAMES. An MCP client fetches `tools/list` once, at connect,
 * and holds it for the life of the session; our transport refuses the
 * server→client SSE stream (see the GET handler in /api/mcp), so there is no
 * channel to tell a connected client the list changed. A client that connected
 * last week is working from last week's catalog and cannot know it. The
 * failure mode is silent and indistinguishable from the tool not existing:
 * "I don't see a tool for that."
 *
 * The stamp makes it legible. It goes in the `initialize` instructions, in
 * `dial8_search_tools` results, and in the dispatcher's unknown-name error —
 * the three places where an agent is asking "what can you do?" and a stale
 * answer would mislead it. Deliberately NOT on every tool response: the
 * instructions already say it once, and a second envelope key on ~165 tools
 * buys nothing.
 */

/** Short, stable fingerprint of a set of tool names. Order-independent. */
export function catalogFingerprint(names: Iterable<string>): string {
  const unique = [...new Set(names)].sort()
  return createHash('sha256').update(unique.join('\n')).digest('hex').slice(0, 8)
}

export interface CatalogStamp {
  /** Changes exactly when the exposed tool NAMES change. */
  version: string
  tool_count: number
}

export function describeCatalog(names: Iterable<string>): CatalogStamp {
  const unique = [...new Set(names)]
  return { version: catalogFingerprint(unique), tool_count: unique.length }
}

/**
 * The sentence every stale-catalog path ends with. One wording, so the advice
 * a user gets is the same whether it came from a search that found nothing or
 * a dispatch that could not resolve a name.
 */
export function staleCatalogHint(stamp: CatalogStamp): string {
  return (
    `This server currently exposes ${stamp.tool_count} tools (catalog ${stamp.version}). ` +
    'If a tool listed here is missing from your own tool list, your client cached an older ' +
    'catalog at connect time — call it through dial8_call_tool, and tell the user to ' +
    'reconnect the Dial8 connector to refresh the list.'
  )
}
