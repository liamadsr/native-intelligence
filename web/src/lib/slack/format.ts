/**
 * The agent's reply (markdown, as the home thread stores and renders it) in
 * Slack's own formatting ("mrkdwn"). Pure.
 *
 *   **bold** / __bold__   → *bold*
 *   *italic* / _italic_   → _italic_
 *   ~~strike~~            → ~strike~
 *   [label](url)          → <url|label>
 *   # Heading             → *Heading*
 *   - item / * item       → • item
 *   & < >                 → &amp; &lt; &gt; (Slack's three escapes)
 *
 * Code spans and fenced blocks pass through untouched (Slack reads backticks
 * the same way). HTML comments outside code (`<!-- proposal:… -->`, a stray
 * `<!-- card:4 -->`) are dropped. A reply past Slack's practical message size
 * is cut at a line break with a pointer to the rest in Native Intelligence.
 */

import { stripHtmlComments } from '@/lib/chat/strip-comments'

/** Slack truncates a message's text well before its 40,000 limit in practice; keep replies readable. */
export const SLACK_REPLY_MAX_CHARS = 3_500

export function markdownToSlack(markdown: string, opts: { moreLink?: string } = {}): string {
  // HTML comments go first (code keeps its own): Slack would print one, escaped, as text.
  const segments = splitCode(stripHtmlComments(markdown.replace(/\r\n/g, '\n')))
  const out = segments.map((seg) => (seg.code ? seg.text : convertProse(seg.text))).join('').trim()
  return clip(out, opts.moreLink)
}

interface Segment {
  text: string
  code: boolean
}

/** Fenced blocks and inline code spans are kept as they are. */
function splitCode(text: string): Segment[] {
  const out: Segment[] = []
  const re = /```[\s\S]*?```|`[^`\n]+`/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), code: false })
    out.push({ text: escapeSlack(m[0]), code: true })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), code: false })
  return out
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function convertProse(text: string): string {
  // Links first, so their labels and URLs aren't touched by the rest.
  const links: string[] = []
  let t = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<${url}|${escapeSlack(label).replace(/\|/g, '/')}>`)
    return `\u0000${links.length - 1}\u0000`
  })
  t = escapeSlack(t)
  t = t
    .split('\n')
    .map((line) => {
      const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
      // Bold (the placeholder the bold pass uses), so the italic pass leaves it alone.
      if (heading) return `\u0001${heading[1].replace(/\*+/g, '')}\u0001`
      const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/)
      if (bullet) return `${bullet[1]}• ${bullet[2]}`
      return line
    })
    .join('\n')
  // Bold before italic: **x** and __x__ become a placeholder, then *x* / _x_ italic.
  t = t.replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '\u0001$1\u0001').replace(/__(?=\S)([^_\n]+?)__/g, '\u0001$1\u0001')
  t = t.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, '$1_$2_')
  t = t.replace(/\u0001/g, '*')
  t = t.replace(/~~(?=\S)([^~\n]+?)~~/g, '~$1~')
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)] ?? '')
}

function clip(text: string, moreLink?: string): string {
  if (text.length <= SLACK_REPLY_MAX_CHARS) return text
  const room = SLACK_REPLY_MAX_CHARS - 120
  const cut = text.lastIndexOf('\n', room)
  const head = text.slice(0, cut > room / 2 ? cut : room).trimEnd()
  return `${head}\n\n_The rest is in Native Intelligence${moreLink ? `: <${moreLink}|open it>` : ''}._`
}
