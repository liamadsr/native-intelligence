/**
 * The agent's reply, made fit for a text message: plain words (no markdown,
 * no emoji, ASCII punctuation so the text stays in the GSM-7 alphabet and
 * costs 153 characters a segment instead of 67) and links made absolute.
 * Never cut (Liam, 2026-10-31: a guest read a trailing "..." as the agent
 * holding something back): a reply longer than one text's
 * {@link SMS_MESSAGE_SEGMENTS} segments goes as several texts, split at a
 * paragraph, a line, a sentence or a word.
 */

/** The segments one text may take (Twilio sends it as one concatenated message; 10 stays deliverable on every US carrier). */
export const SMS_MESSAGE_SEGMENTS = 10
/** Characters per segment of a multi-part text: GSM-7, and UCS-2 when any character is outside it. */
const GSM_SEGMENT = 153
const GSM_SINGLE = 160
const UCS2_SEGMENT = 67
const UCS2_SINGLE = 70

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
/** GSM-7 extension characters: each takes two septets. */
const GSM_EXTENDED = '^{}\\[~]|€'
const GSM_BASIC_SET = new Set(GSM_BASIC)
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED)

/** The text's length in GSM-7 septets, or null when a character is outside GSM-7 (the text goes as UCS-2). */
export function gsmLength(text: string): number | null {
  let n = 0
  for (const ch of text) {
    if (GSM_BASIC_SET.has(ch)) n += 1
    else if (GSM_EXTENDED_SET.has(ch)) n += 2
    else return null
  }
  return n
}

/** How many segments a text takes. */
export function smsSegments(text: string): number {
  const gsm = gsmLength(text)
  if (gsm !== null) return gsm <= GSM_SINGLE ? 1 : Math.ceil(gsm / GSM_SEGMENT)
  const units = text.length // UTF-16 code units, as UCS-2 counts them
  return units <= UCS2_SINGLE ? 1 : Math.ceil(units / UCS2_SEGMENT)
}

/** Punctuation that would force UCS-2, as its ASCII twin. */
const ASCII_PUNCTUATION: ReadonlyArray<[RegExp, string]> = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐‑‒–—―]/g, '-'],
  [/…/g, '...'],
  [/[•·▪●◦]/g, '-'],
  [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
  [/→/g, '->'],
  [/←/g, '<-'],
]

/** Make an app-relative link absolute (`/account/…` → `https://…/account/…`). */
function absoluteLink(url: string, origin: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? `${origin}${url}` : url
}

/** Markdown → plain text for a phone. Exported for the tests. */
export function stripMarkdown(markdown: string, origin: string): string {
  let text = markdown.replace(/\r\n?/g, '\n')
  // Fenced code: keep what is inside.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => body.trimEnd())
  // Images: their alt text. Links: "text (url)", or the url alone when they match.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) => {
    if (!/^(https?:\/\/|\/)/.test(url)) return label
    const abs = absoluteLink(url, origin)
    return label === url || label === abs ? abs : `${label} (${abs})`
  })
  text = text.replace(/<((?:https?:\/\/)[^>\s]+)>/g, '$1')
  // Inline code, bold, italics, strikethrough.
  text = text.replace(/`([^`\n]+)`/g, '$1')
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
  text = text.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
  text = text.replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
  text = text.replace(/~~([^~\n]+)~~/g, '$1')
  // Line-level: headings, quotes, rules, list markers, table rules.
  text = text
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '- ')
        .replace(/^\s*[*+]\s+/, '- ')
        .replace(/^\s*-\s+/, '- ')
        .replace(/\s+$/, ''),
    )
    .filter((line) => !/^\s*([-*_]\s*){3,}$/.test(line) && !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line))
    .join('\n')
  return text
}

/** Plain, GSM-friendly text: markdown and emoji gone, punctuation ASCII, blank lines collapsed. */
export function plainSmsText(markdown: string, origin: string): string {
  let text = stripMarkdown(markdown, origin)
  for (const [re, ascii] of ASCII_PUNCTUATION) text = text.replace(re, ascii)
  text = text.replace(/\p{Extended_Pictographic}[\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]*/gu, '').replace(/[\u{FE0F}\u{200D}]/gu, '')
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The reply as it is texted: plain, in as many texts as it takes, each at
 * most {@link SMS_MESSAGE_SEGMENTS} segments, never a word dropped. Empty in,
 * no texts out (nothing is sent).
 */
export function formatSmsReply(markdown: string, opts: { origin: string }): string[] {
  const text = plainSmsText(markdown, opts.origin)
  return text ? splitSmsText(text) : []
}

/**
 * Split plain text into texts of at most {@link SMS_MESSAGE_SEGMENTS} segments
 * each, at the latest paragraph break that fits, else a line break, else a
 * sentence end, else a space, else (one unbroken run) mid-word. Pure.
 */
export function splitSmsText(text: string): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest) {
    if (smsSegments(rest) <= SMS_MESSAGE_SEGMENTS) {
      out.push(rest)
      break
    }
    const fit = fittingLength(rest)
    const head = rest.slice(0, fit)
    const at = [/\n\n(?=\S)/g, /\n(?=\S)/g, /[.!?](?=\s)/g, /\s(?=\S)/g]
      .map((re) => lastBreak(head, re))
      .find((b) => b > fit * 0.5)
    const cut = at ?? fit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return out
}

/**
 * How many characters of `text` fit in one text, on the measure the whole text
 * goes as (GSM-7 septets, else UCS-2 code units). A GSM-7 extension pair never
 * straddles a segment boundary, so each segment may lose a septet: one spare
 * septet per segment keeps the text within its segments.
 */
function fittingLength(text: string): number {
  const gsm = gsmLength(text) !== null
  const budget = gsm ? (GSM_SEGMENT - 1) * SMS_MESSAGE_SEGMENTS : UCS2_SEGMENT * SMS_MESSAGE_SEGMENTS
  let used = 0
  let cut = 0
  for (const ch of text) {
    const cost = gsm ? (GSM_EXTENDED_SET.has(ch) ? 2 : 1) : ch.length
    if (used + cost > budget) break
    used += cost
    cut += ch.length
  }
  return cut
}

/** The index just after the last match of `re` in `text` (a sentence keeps its full stop), or -1. */
function lastBreak(text: string, re: RegExp): number {
  let at = -1
  for (const m of text.matchAll(re)) at = m.index + (m[0].trim() ? m[0].length : 0)
  return at
}
