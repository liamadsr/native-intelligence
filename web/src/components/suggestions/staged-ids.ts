/**
 * The suggestion ids a suggest_changes result staged (or found already staged),
 * from its tool output. Refused ones have no id. Tolerates the head+tail
 * truncated string a huge output becomes (tool-output-truncation.ts) by
 * scraping marker ids from it.
 */
export function stagedSuggestionIds(output: unknown): string[] {
  if (typeof output === 'string') {
    return [...output.matchAll(/proposal:([0-9a-f-]{36})/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i)
  }
  const list = (output as { suggestions?: Array<{ id?: unknown; result?: unknown }> } | null)?.suggestions
  if (!Array.isArray(list)) return []
  return list
    .filter((s) => s && typeof s.id === 'string' && s.result !== 'refused')
    .map((s) => s.id as string)
}
