/**
 * The `;` menu's list: the person's snippets, narrowed by what is typed after
 * the `;`. Pure. Order: a shortcut that starts with the query, then one that
 * holds it, then a name word that starts with it, then a name or body that
 * holds it; the person's own before the shared ones at each step, then by
 * shortcut. An empty query lists them all, the same way.
 */
import type { Snippet } from './types'

/** The most the menu lists. */
export const SNIPPET_MENU_LIMIT = 50

function rank(s: Snippet, q: string): number | null {
  if (!q) return 0
  const shortcut = s.shortcut
  if (shortcut === q) return 0
  if (shortcut.startsWith(q)) return 1
  const name = s.name.toLowerCase()
  if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2
  if (shortcut.includes(q)) return 3
  if (name.replace(/[^a-z0-9]+/g, '').includes(q.replace(/[-_]/g, ''))) return 4
  if (q.length >= 3 && s.body.toLowerCase().includes(q)) return 5
  return null
}

export function filterSnippets(snippets: readonly Snippet[], query: string, limit = SNIPPET_MENU_LIMIT): Snippet[] {
  const q = query.trim().toLowerCase()
  const ranked: Array<{ s: Snippet; r: number }> = []
  for (const s of snippets) {
    const r = rank(s, q)
    if (r !== null) ranked.push({ s, r })
  }
  ranked.sort(
    (a, b) =>
      a.r - b.r ||
      Number(b.s.visibility === 'personal') - Number(a.s.visibility === 'personal') ||
      a.s.shortcut.localeCompare(b.s.shortcut) ||
      a.s.name.localeCompare(b.s.name),
  )
  return ranked.slice(0, limit).map((x) => x.s)
}
