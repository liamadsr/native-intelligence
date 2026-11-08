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
 * literal `<!--` in prose never eats the text after it. Pure; the iPhone chat
 * has the same rules in ios/Core/Models/ChatReplyText.swift.
 */

/** Fenced blocks (to their closing fence, or the end of the text) and code spans. */
const CODE_RE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
/** Stands in for a piece of code while the comments go; NUL never appears in a reply. */
const CODE_SLOT_RE = /\u0000(\d+)\u0000/g

export function stripHtmlComments(markdown: string): string {
  if (!markdown.includes('<!--')) return markdown
  // Code is set aside first, so a comment just before a code span still
  // leaves a space between the word and the span.
  const code: string[] = []
  const prose = markdown.replace(CODE_RE, (m) => `\u0000${code.push(m) - 1}\u0000`)
  return (
    prose
      // Comments between two words leave one space, so the words don't run
      // together. A body can't hold `-->`, so a failed match can't re-split
      // the run: linear, not exponential.
      .replace(/(?<=\S)[ \t]*(?:<!--(?:(?!-->)[^\n])*-->[ \t]*)+(?=\S)/g, ' ')
      .replace(/[ \t]*<!--\s*proposal:[a-zA-Z0-9-]+\s*-->[ \t]*\n?/g, '')
      .replace(/[ \t]*<!--[^\n]*?-->[ \t]*\n?/g, '')
      .replace(CODE_SLOT_RE, (_m, i: string) => code[Number(i)] ?? '')
  )
}
