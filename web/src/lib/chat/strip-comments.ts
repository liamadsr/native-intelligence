/**
 * HTML comments out of a chat reply, for every surface that shows it as text:
 * copy, read-aloud and previews in the web and Mac chat, the texted reply
 * (sms-format.ts) and the Slack reply (slack/format.ts). The chat agent marks
 * a suggestion with `<!-- proposal:ID -->`, and sometimes copies that shape
 * for things that aren't proposals (`<!-- card:4 -->`). A comment is never
 * meant to be read, and a plain-text surface would print it.
 *
 * Code is left as written: fenced blocks and `code spans` keep their comments.
 * A comment must open and close on one line (a proposal marker may wrap), so a
 * literal `<!--` in prose never eats the text after it. Line breaks stay where
 * they were, unless a line held nothing but comments. Pure; the iPhone chat
 * has the same rules in ios/Core/Models/ChatReplyText.swift.
 *
 * Every pattern is linear: a comment's body can't hold `-->` or another `<!--`
 * (so neither a run of comments nor a run of unclosed openers is re-scanned),
 * and each run of spaces is matched only from its start.
 */

const COMMENT = String.raw`<!--(?:(?!-->|<!--)[^\n])*-->`
/** Fenced blocks (to their closing fence, or the end of the text) and code spans. */
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
/** Stands in for a piece of code while the comments go; NUL never appears in a reply. */
const CODE_SLOT_RE = /\u0000(\d+)\u0000/g
/** A proposal marker that wraps, folded onto one line for the rules below. */
const WRAPPED_MARKER_RE = /<!--\s*(proposal:[a-zA-Z0-9-]+)\s*-->/g
/** A line of nothing but comments goes, with its line break. */
const COMMENT_LINE_RE = new RegExp(String.raw`^[ \t]*(?:${COMMENT}[ \t]*)+(?:\n|$)`, 'gm')
/** Comments between two words leave one space, so the words don't run together (none before punctuation). */
const BETWEEN_WORDS_RE = new RegExp(String.raw`(?<=\S)[ \t]*(?:${COMMENT}[ \t]*)+(?=[^\s.,;:!?)\]}])`, 'g')
/** Any other comment goes with the spaces around it; the line break after it stays. */
const INLINE_RE = new RegExp(String.raw`(?<![ \t])[ \t]*(?:${COMMENT}[ \t]*)+`, 'g')

export function stripHtmlComments(markdown: string): string {
  if (!markdown.includes('<!--')) return markdown
  // Code is set aside first, so a comment just before a code span still
  // leaves a space between the word and the span.
  const code: string[] = []
  const prose = markdown.replace(CODE_RE, (m) => `\u0000${code.push(m) - 1}\u0000`)
  return prose
    .replace(WRAPPED_MARKER_RE, '<!-- $1 -->')
    .replace(COMMENT_LINE_RE, '')
    .replace(BETWEEN_WORDS_RE, ' ')
    .replace(INLINE_RE, '')
    .replace(CODE_SLOT_RE, (m, i: string) => code[Number(i)] ?? m)
}
