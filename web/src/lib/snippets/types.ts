/**
 * Snippets (docs/plans/snippets.md, migration 699): saved pieces of text a
 * person types in with `;` and a few letters. Client-safe, plain data and
 * checks; the store (./store.ts) and the routes use the same checks.
 */

export type SnippetVisibility = 'personal' | 'workspace'
export const SNIPPET_VISIBILITIES: readonly SnippetVisibility[] = ['personal', 'workspace']

export const SNIPPET_NAME_MAX = 80
export const SNIPPET_SHORTCUT_MAX = 32
export const SNIPPET_BODY_MAX = 20_000

/** Lowercase letters, digits, `-` and `_`, starting with a letter or digit (the database's check). */
export const SNIPPET_SHORTCUT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

/** A snippet as the app reads it (the API's shape). */
export interface Snippet {
  id: string
  name: string
  shortcut: string
  /** Markdown, as documents store it. */
  body: string
  visibility: SnippetVisibility
  /** The reader made it (only its maker sees a personal one). */
  mine: boolean
  /** The reader may change or delete it (its maker; a shared one also an owner or admin). */
  canEdit: boolean
  updatedAt: string
}

/** A shortcut as typed, made into one the database takes: lowercase, spaces to `-`, the rest dropped. */
export function normalizeShortcut(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^;+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[-_]+/, '')
    .slice(0, SNIPPET_SHORTCUT_MAX)
}

/** A shortcut from a name ("Meeting follow-up" → `meeting-follow-up`), for a new snippet's default. */
export function shortcutFromName(name: string): string {
  return normalizeShortcut(name.normalize('NFKD').replace(/[̀-ͯ]/g, ''))
}

export interface SnippetInput {
  name?: unknown
  shortcut?: unknown
  body?: unknown
  visibility?: unknown
}

export type CheckedSnippet = { name: string; shortcut: string; body: string; visibility: SnippetVisibility }

/**
 * A create (`partial` false: name, shortcut and body required) or a change
 * (`partial` true: only what is given), checked. The error says what to fix.
 */
export function checkSnippetInput(
  input: SnippetInput,
  partial: boolean,
): { ok: true; value: Partial<CheckedSnippet> } | { ok: false; error: string } {
  const value: Partial<CheckedSnippet> = {}
  if (input.name !== undefined || !partial) {
    if (typeof input.name !== 'string' || !input.name.trim()) return { ok: false, error: 'A snippet needs a name.' }
    const name = input.name.trim()
    if (name.length > SNIPPET_NAME_MAX) return { ok: false, error: `A name is at most ${SNIPPET_NAME_MAX} characters.` }
    value.name = name
  }
  if (input.shortcut !== undefined || !partial) {
    const shortcut = typeof input.shortcut === 'string' ? normalizeShortcut(input.shortcut) : ''
    if (!SNIPPET_SHORTCUT_RE.test(shortcut)) {
      return { ok: false, error: `A shortcut is one word of letters, digits, - or _ (at most ${SNIPPET_SHORTCUT_MAX}).` }
    }
    value.shortcut = shortcut
  }
  if (input.body !== undefined || !partial) {
    if (typeof input.body !== 'string' || !input.body.trim()) return { ok: false, error: 'A snippet needs some text.' }
    if (input.body.length > SNIPPET_BODY_MAX) return { ok: false, error: `A snippet is at most ${SNIPPET_BODY_MAX.toLocaleString('en-US')} characters.` }
    value.body = input.body.replace(/\s+$/, '')
  }
  if (input.visibility !== undefined) {
    if (!SNIPPET_VISIBILITIES.includes(input.visibility as SnippetVisibility)) return { ok: false, error: 'A snippet is personal or shared with the workspace.' }
    value.visibility = input.visibility as SnippetVisibility
  } else if (!partial) {
    value.visibility = 'personal'
  }
  return { ok: true, value }
}

/** The body's first line, as words (a list's hint): markdown marks dropped. */
export function snippetPreview(body: string, max = 90): string {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^(```|---|\*\*\*)/.test(l)) ?? ''
  // Fill-ins keep their underscores: set aside while the marks go.
  const fillIns: string[] = []
  const words = line
    .replace(/\{\{[^}]*\}\}/g, (m) => `\u0000${fillIns.push(m) - 1}\u0000`)
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => fillIns[Number(i)] ?? '')
    .trim()
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words
}
