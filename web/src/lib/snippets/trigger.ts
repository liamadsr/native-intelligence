/**
 * Where a `;` opens the snippet menu, read from text and a caret. Pure.
 *
 * `;` opens at the start of a word (the start of the text or a line, after a
 * space, or after an opening bracket or quote), and its query is the letters,
 * digits, `-` and `_` typed after it up to the caret: `;sig`. It does not open
 *   - in the middle of a word (`a;b`, `x;`): the character before it is a
 *     letter, digit or other punctuation;
 *   - with a word going on after the caret (`;si|g` with the caret inside);
 *   - inside code: a fenced block (an odd number of ``` lines before it) or
 *     inline code (an odd number of backticks before it on its line);
 *   - inside a link's address (`](…` before it on the line, unclosed). A bare
 *     URL never reaches here: its `;` follows a letter or `/`, mid-word.
 * A query longer than SNIPPET_QUERY_MAX is no query.
 *
 * The TipTap editors read the same rules from the document (code nodes and
 * marks, links) in components/editor/snippet-suggestion.ts, with
 * isSnippetQuery and the prefix check below.
 */

export const SNIPPET_TRIGGER = ';'
export const SNIPPET_QUERY_MAX = 32

/** What may follow `;` in a query. */
const QUERY_CHAR = /[A-Za-z0-9_-]/
/** What may come right before the `;`: nothing, white space, an opening bracket or quote. */
const PREFIX_OK = /[\s([{"'“‘]/

export interface SnippetToken {
  /** Index of the `;`. */
  start: number
  /** The caret: where the query ends. */
  caret: number
  query: string
}

/** Whether `query` reads as a snippet's shortcut being typed. */
export function isSnippetQuery(query: string): boolean {
  return query.length <= SNIPPET_QUERY_MAX && /^[A-Za-z0-9_-]*$/.test(query)
}

/** Whether the character before a `;` lets it open (undefined: the start of the text). */
export function snippetPrefixOk(before: string | undefined): boolean {
  return before === undefined || before === '' || PREFIX_OK.test(before)
}

/** Whether the caret, at `index` in `value`, is inside code (a fence or inline backticks). */
export function inMarkdownCode(value: string, index: number): boolean {
  const before = value.slice(0, index)
  const lines = before.split('\n')
  let fenced = false
  for (let i = 0; i < lines.length - 1; i++) if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
  const current = lines[lines.length - 1]
  if (/^\s*(```|~~~)/.test(current)) return true
  if (fenced) return true
  const ticks = current.match(/`/g)?.length ?? 0
  return ticks % 2 === 1
}

/** Whether `index` sits inside a markdown link's address on its line (`[text](…` not yet closed). */
function inLinkAddress(value: string, index: number): boolean {
  const lineStart = value.lastIndexOf('\n', index - 1) + 1
  const line = value.slice(lineStart, index)
  const open = line.lastIndexOf('](')
  return open !== -1 && !line.slice(open).includes(')')
}

/** The `;` token the caret is in, or null. */
export function findSnippetToken(value: string, caret: number): SnippetToken | null {
  if (caret < 1 || caret > value.length) return null
  let i = caret
  while (i > 0 && QUERY_CHAR.test(value[i - 1])) i--
  if (i === 0 || value[i - 1] !== SNIPPET_TRIGGER) return null
  const start = i - 1
  const query = value.slice(i, caret)
  if (!isSnippetQuery(query)) return null
  if (!snippetPrefixOk(start > 0 ? value[start - 1] : undefined)) return null
  if (caret < value.length && QUERY_CHAR.test(value[caret])) return null
  if (inMarkdownCode(value, start)) return null
  if (inLinkAddress(value, start)) return null
  return { start, caret, query }
}

/** The text with `insert` in place of the token (its `;query`), and the caret after it. */
export function replaceSnippetToken(value: string, token: SnippetToken, insert: string): { value: string; caret: number } {
  const next = value.slice(0, token.start) + insert + value.slice(token.caret)
  return { value: next, caret: token.start + insert.length }
}
