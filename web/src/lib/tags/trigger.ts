/**
 * When a `#` opens the tag menu. One rule for the rich editor and plain text boxes:
 *
 *  • it starts a word: the start of the text or line, or after whitespace or an
 *    opening bracket. So `C#`, `issue#4` and `example.com/#top` never open it;
 *  • the next character is not a space: `# ` is a markdown heading, `#` alone is
 *    just a `#` until a letter follows;
 *  • not inside a URL-ish word or code (the editor also checks code nodes/marks);
 *  • the query is one word of tag characters (letters, numbers, - _ / . :),
 *    at most 64 long. Anything else and the menu steps aside.
 */
import { TAG_NAME_MAX } from './names'

const QUERY_RE = /^[\p{L}\p{N}_\-/.:]*$/u
const OPENERS = new Set(['(', '[', '{', '"', "'"])

export function isTagQuery(query: string): boolean {
  return query.length <= TAG_NAME_MAX && QUERY_RE.test(query)
}

/** Whether the character before a `#` lets it start a tag (undefined: start of text). */
export function canStartTag(before: string | undefined): boolean {
  return before === undefined || /\s/.test(before) || OPENERS.has(before)
}

export interface TagTrigger {
  /** Index of the `#`. */
  start: number
  query: string
}

/** For a plain text box: the open `#query` just before the caret, or null. */
export function findTagTrigger(value: string, caret: number): TagTrigger | null {
  const lineStart = value.lastIndexOf('\n', caret - 1) + 1
  const line = value.slice(lineStart, caret)
  const at = line.lastIndexOf('#')
  if (at < 0) return null
  const query = line.slice(at + 1)
  if (!isTagQuery(query)) return null
  const before = at > 0 ? line[at - 1] : undefined
  if (!canStartTag(before)) return null
  // Inside a code span on this line (an odd number of backticks before it).
  if ((line.slice(0, at).match(/`/g) ?? []).length % 2 === 1) return null
  return { start: lineStart + at, query }
}
