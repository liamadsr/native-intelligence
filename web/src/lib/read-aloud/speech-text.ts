/**
 * Markdown → speakable sentences, for read-aloud (docs/plans/local-modules.md
 * §3.5, the web half). The desktop's `local-tts` module speaks one sentence
 * per `tts_speak` and expands numbers and symbols itself; this side only turns
 * a chat reply's markdown into plain prose and cuts it into sentences.
 *
 * Pure and synchronous, no DOM. The block parser is line-based and
 * append-stable — a block, once followed by another, never changes — which is
 * what lets `SentenceStream` (./sentence-stream) speak a reply while it streams
 * and still say exactly what `markdownToSentences` says for the finished text.
 */

// ── Blocks ─────────────────────────────────────────────────────────────────

export type SpeechBlockKind = 'text' | 'heading' | 'list' | 'code' | 'table'

export interface SpeechBlock {
  kind: SpeechBlockKind
  /** Raw source lines (blockquote markers and list markers already removed). */
  lines: string[]
  /** For `code`: a fence (or $$ math block) that has not been closed yet. */
  open?: boolean
}

// Fences take any indentation: one nested in a list item sits 4+ spaces in,
// and must still be skipped, not read as indented code or lazy text. A
// backtick fence's info string has no backticks ("```npm i``` first" is text).
const FENCE_RE = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/
const MATH_FENCE_RE = /^[ \t]*\$\$/
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]+|$)/
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/
const TASK_BOX_RE = /^\[[ xX]\][ \t]+/
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?/
const TABLE_LINE_RE = /^[ \t]*\|/
const TABLE_SEPARATOR_RE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/
const INDENTED_CODE_RE = /^(?: {4}|\t)/
const FOOTNOTE_DEF_RE = /^ {0,3}\[\^[^\]]+\]:/
const LINK_REF_DEF_RE = /^ {0,3}\[[^\]]+\]:[ \t]*\S+/

/**
 * Parse markdown into blocks. Code (fenced, indented, $$ math) and tables are
 * kept as blocks so a streaming reader knows to wait on them, but they carry
 * no speech. Thematic breaks, footnote and link-reference definitions are
 * dropped.
 */
export function parseSpeechBlocks(markdown: string): SpeechBlock[] {
  return parseSpeechBlocksWithState(markdown).blocks
}

/**
 * `parseSpeechBlocks`, plus whether the last block is still open: more lines
 * could still join it (a paragraph with no blank line after it, an unclosed
 * fence, indented code). A blank line, a closing fence, or a one-line block
 * such as an ATX heading ends it.
 */
export function parseSpeechBlocksWithState(markdown: string): { blocks: SpeechBlock[]; lastOpen: boolean } {
  const blocks: SpeechBlock[] = []
  let current: SpeechBlock | null = null
  // `quoted`: opened inside a blockquote, so it also ends where the quote does.
  let fence: { char: string; length: number; math: boolean; quoted: boolean } | null = null
  // True right after a blank line (or at the start), when an indented line
  // opens a code block rather than continuing a paragraph.
  let afterBreak = true

  const push = (block: SpeechBlock) => {
    blocks.push(block)
    current = block
  }
  const end = () => {
    current = null
  }

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine
    while (BLOCKQUOTE_RE.test(line)) line = line.replace(BLOCKQUOTE_RE, '')

    // Inside a fence: everything is code until the matching closer. A fence
    // opened in a blockquote is matched without the `>` markers, and the end
    // of the quote (a line without `>`) closes it; that line is then read
    // normally.
    if (fence) {
      const block = current as SpeechBlock | null
      if (fence.quoted && !BLOCKQUOTE_RE.test(rawLine)) {
        if (block) block.open = false
        fence = null
        end()
        afterBreak = true
      } else {
        const inner = fence.quoted ? line : rawLine
        const closer = fence.math
          ? MATH_FENCE_RE.test(inner)
          : new RegExp(`^[ \\t]*${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(inner)
        if (block) block.lines.push(inner)
        if (closer) {
          if (block) block.open = false
          fence = null
          end()
          afterBreak = true
        }
        continue
      }
    }

    if (!line.trim()) {
      // A blank line ends paragraphs, list items and tables; indented code
      // swallows it (it may continue after the gap).
      const block = current as SpeechBlock | null
      if (block?.kind !== 'code') end()
      afterBreak = true
      continue
    }

    // A fence can open on a list item's own line ("- ```bash"); its closer
    // then sits indented under the item.
    const fenceMatch = FENCE_RE.exec(line) ?? FENCE_RE.exec(line.replace(LIST_ITEM_RE, ''))
    if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length, math: false, quoted: line !== rawLine }
      push({ kind: 'code', lines: [line], open: true })
      continue
    }
    if (MATH_FENCE_RE.test(line)) {
      // `$$ x $$` on one line is a finished block; a lone `$$` opens one.
      const oneLine = /^[ \t]*\$\$.*\S.*\$\$[ \t]*$/.test(line)
      push({ kind: 'code', lines: [line], open: !oneLine })
      if (oneLine) end()
      else fence = { char: '$', length: 2, math: true, quoted: line !== rawLine }
      continue
    }

    const block = current as SpeechBlock | null

    // Indented code: only where a paragraph can't be continued, and never for
    // an indented list item (nested lists are indented too).
    if (INDENTED_CODE_RE.test(line) && !LIST_ITEM_RE.test(line)) {
      if (block?.kind === 'code' && !block.open) {
        block.lines.push(line)
        continue
      }
      if (afterBreak && block?.kind !== 'list' && !lastIsList(blocks)) {
        push({ kind: 'code', lines: [line], open: false })
        afterBreak = false
        continue
      }
    }
    afterBreak = false

    if (TABLE_LINE_RE.test(line)) {
      if (block?.kind === 'table') block.lines.push(line)
      else push({ kind: 'table', lines: [line] })
      continue
    }
    // A delimiter row under a pipe-less header row turns that line into a table.
    if (TABLE_SEPARATOR_RE.test(line) && line.includes('|') && block?.kind === 'text' && block.lines.length === 1 && block.lines[0].includes('|')) {
      block.kind = 'table'
      block.lines.push(line)
      continue
    }
    if (block?.kind === 'table') {
      if (line.includes('|')) {
        block.lines.push(line)
        continue
      }
      end()
    }

    if (ATX_HEADING_RE.test(line)) {
      const text = line.replace(ATX_HEADING_RE, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '')
      push({ kind: 'heading', lines: [text] })
      end()
      continue
    }
    // Setext underline: turns the paragraph above into a heading.
    if (SETEXT_RE.test(line) && block?.kind === 'text') {
      block.kind = 'heading'
      end()
      continue
    }
    if (HR_RE.test(line)) {
      end()
      continue
    }
    if (FOOTNOTE_DEF_RE.test(line) || LINK_REF_DEF_RE.test(line)) {
      end()
      continue
    }
    if (LIST_ITEM_RE.test(line)) {
      const text = line.replace(LIST_ITEM_RE, '').replace(TASK_BOX_RE, '')
      push({ kind: 'list', lines: [text] })
      continue
    }

    // Paragraph text, or a lazy continuation of the paragraph / list item.
    if (block && (block.kind === 'text' || block.kind === 'list')) {
      block.lines.push(line)
    } else {
      push({ kind: 'text', lines: [line] })
    }
  }

  const last = blocks[blocks.length - 1]
  return { blocks, lastOpen: !!last && (current as SpeechBlock | null) === last }
}

function lastIsList(blocks: SpeechBlock[]): boolean {
  return blocks.length > 0 && blocks[blocks.length - 1].kind === 'list'
}

/** A block's speakable text ('' for code, tables, or nothing left to say). */
export function blockToSpeech(block: SpeechBlock): string {
  if (block.kind === 'code' || block.kind === 'table') return ''
  const text = inlineToSpeech(block.lines.join(' '))
  if (!text) return ''
  if (block.kind === 'heading' || block.kind === 'list') return withTerminalPunctuation(text)
  return text
}

/** Headings and list items read as sentences: add a period when missing. */
export function withTerminalPunctuation(text: string): string {
  return /[.!?…:;]["'”’)\]]*$/.test(text) ? text : `${text}.`
}

// ── Inline markdown ────────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
}

// Stage directions: "[laughs]", "(sighs)", "*chuckles softly*", "_long pause_".
// Pocket TTS has no sound for them and reads the word ("[laughs]" came out as
// "loss"), so they go; a reply laughs with "Haha," instead. Only a cue word,
// with at most one modifier before ("long pause") and one adverb after
// ("laughs softly"), counts: "(the pause button)" is prose and stays.
const STAGE_CUE =
  '(?:laugh(?:s|ing|ter)?|chuckl(?:e|es|ed|ing)|giggl(?:e|es|ed|ing)|snicker(?:s|ing)?|sigh(?:s|ed|ing)?|' +
  'gasp(?:s|ed|ing)?|cough(?:s|ed|ing)?|sniff(?:s|les)?|groan(?:s|ing)?|yawn(?:s|ing)?|smil(?:e|es|ing)|' +
  'grin(?:s|ning)?|pause[sd]?|beat|inhales?|exhales?|breath(?:es|ing)?|clears (?:(?:his|her|their|my) )?throat|' +
  'nods?|shrugs?|whisper(?:s|ing)?)'
const STAGE_BODY =
  `\\s*(?:(?:soft|quiet|nervous|deep|long|short|brief|little|small|big|light|warm|knowing|polite)\\s+)?` +
  `${STAGE_CUE}(?:\\s+(?:[a-z]+ly|again))?\\s*`
const STAGE_DIRECTION_RE = new RegExp(
  `(?:\\[${STAGE_BODY}\\]|\\(${STAGE_BODY}\\)|\\*{1,2}${STAGE_BODY}\\*{1,2}|(?<![\\w])_${STAGE_BODY}_(?![\\w]))[,;:]?`,
  'gi',
)

// Pictographs plus the joiners, variation selectors, skin tones, keycaps and
// flag letters that build emoji sequences out of them.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{200D}\u{FE0E}\u{FE0F}\u{20E3}]/gu

/** One block's inline markdown → plain text. */
export function inlineToSpeech(input: string): string {
  // Code spans keep their text verbatim: set them aside so the link, HTML and
  // emphasis passes below never touch what is inside them.
  const spans: string[] = []
  let s = input.replace(/(`+)([^`]+?)\1/g, (_m, _ticks: string, inner: string) => {
    spans.push(inner.trim())
    return `\u0000${spans.length - 1}\u0000`
  })
  s = s.replace(/`+/g, '') // an unclosed span, mid-stream

  // Before brackets and emphasis markers lose their meaning below.
  s = s.replace(STAGE_DIRECTION_RE, ' ')

  // Images first (their alt text is not read), then links (their text is).
  s = s.replace(/!\[[^\]]*\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '')
  s = s.replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
  s = s.replace(/\[\^[^\]\s]+\]/g, '') // footnote markers
  s = s.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  s = s.replace(/<((?:https?|mailto):[^>\s]+)>/gi, '$1') // autolinks → the URL, shortened below

  // HTML: line breaks become spaces, every other tag goes, entities decode.
  s = s.replace(/<br\s*\/?>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, '')
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, '')
  s = s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|#39);/g, (m) => HTML_ENTITIES[m] ?? m)

  s = urlsToHosts(s)

  // Emphasis and strikethrough markers go, their text stays.
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?=[^\w*]|$)/g, '$1$2')
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?=[^\w]|$)/g, '$1$2')
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  // Stray markers left by unclosed emphasis (mid-stream), but not "2*3".
  s = s.replace(/(\d?)\*+(\d?)/g, (m, a: string, b: string) => (a && b ? m : a + b))
  s = s.replace(/(^|\s)_+|_+(?=\s|$)/g, '$1')
  s = s.replace(/~~/g, '')

  // Emoji carry no words; brackets left over from partial links carry none either.
  s = s.replace(EMOJI_RE, '')
  s = s.replace(/[[\]]/g, '')

  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? '')

  return finishSpeech(s)
}

/**
 * Text that is already rendered → plain speakable text: a markdown block's DOM
 * text, a note editor node's text (the read-aloud sections, ./sections). Bare
 * URLs read as their host and emoji go, as in `inlineToSpeech`, but no
 * markdown is interpreted: `*` or `_` in the text is the text. '' when nothing
 * speakable is left.
 */
export function plainTextToSpeech(input: string): string {
  return finishSpeech(urlsToHosts(input).replace(EMOJI_RE, ''))
}

/** Bare URLs read as their host: "https://docs.nativeintelligence.dev/api?x=1" → "docs.nativeintelligence.dev".
 *  The match stops before trailing punctuation, so a sentence's period survives. */
function urlsToHosts(s: string): string {
  return s
    .replace(/\bhttps?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"”’]/gi, (url) =>
      url.replace(/^https?:\/\/(?:www\.)?/i, '').split(/[/?#]/)[0],
    )
    .replace(/\bmailto:/gi, '')
}

/** Collapse whitespace (emoji or a dropped image can leave " ." behind); ''
 *  when nothing speakable is left (only punctuation). */
function finishSpeech(s: string): string {
  const text = s.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim()
  return /[\p{L}\p{N}]/u.test(text) ? text : ''
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Markdown → plain speakable text: code blocks, tables and images skipped,
 * link text kept (URL dropped), HTML, footnote markers, emphasis, inline-code
 * backticks, blockquote markers and emoji stripped, headings and list items
 * turned into sentences. One block per line, whitespace collapsed; the line
 * breaks are sentence boundaries for `splitSentences`.
 */
export function markdownToSpeech(markdown: string): string {
  return parseSpeechBlocks(markdown)
    .map(blockToSpeech)
    .filter(Boolean)
    .join('\n')
}

/** Markdown → the sentences to speak, in order. What `speakMessage` sends. */
export function markdownToSentences(markdown: string): string[] {
  return parseSpeechBlocks(markdown).flatMap((block) => splitSentences(blockToSpeech(block)))
}

/** Plain text as a page shows it → the sentences to speak: the base of what
 *  the user highlights in the in-app browser reads (./browser-speech).
 *  Each line (a heading, a list item, a paragraph) reads as its own sentences,
 *  cleaned like `plainTextToSpeech`, and ends like one (a heading gets its
 *  period, as in `blockToSpeech`). */
export function plainTextToSentences(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => {
    const speech = plainTextToSpeech(line)
    return speech ? splitSentences(withTerminalPunctuation(speech)) : []
  })
}

/** A titled markdown document → the sentences to speak: the (plain-text)
 *  title as a sentence of its own, then the body. What a document reads in
 *  listen mode (components/read-aloud/listen-target.tsx). */
export function titledMarkdownToSentences(title: string, markdown: string): string[] {
  const heading = plainTextToSpeech(title)
  return [...(heading ? splitSentences(withTerminalPunctuation(heading)) : []), ...markdownToSentences(markdown)]
}

// ── Sentences ──────────────────────────────────────────────────────────────

/** Abbreviations that never end a sentence ("Dr. Smith", "e.g. this", "Acme Inc. said"). */
const NEVER_SPLIT = new Set([
  'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'ft', 'fr',
  'gen', 'col', 'lt', 'sgt', 'capt', 'cmdr', 'adm', 'rep', 'sen', 'gov', 'pres', 'hon', 'rev',
  'vs', 'v', 'cf', 'approx', 'appt', 'dept', 'est', 'fig', 'figs', 'eq', 'al', 'ca', 'viz',
  'inc', 'ltd', 'co', 'corp', 'llc', 'plc', 'bros',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'e.g', 'i.e', 'u.s', 'u.k', 'u.n', 'e.u', 'u.s.a', 'ph.d', 'm.d', 'b.a', 'm.a', 'b.sc', 'm.sc', 'a.k.a',
])
/** Abbreviations that end a sentence only when a capital follows ("… etc. Then"). */
const SPLIT_BEFORE_CAPITAL = new Set(['etc', 'a.m', 'p.m', 'no', 'nos'])

const MAX_WORDS = 40
const MIN_PART_WORDS = 6

/**
 * Plain text → sentences. Line breaks always end a sentence. Doesn't split on
 * abbreviations (Dr., e.g., i.e., Mr., Inc., U.S.), decimals (4.2), times
 * (3:30), URLs and domains (nativeintelligence.dev), initials (J. R. R.) or ellipses. A
 * sentence over ~40 words is cut at a semicolon or comma when one sits
 * comfortably inside it.
 */
export function splitSentences(text: string): string[] {
  return splitSentencesRaw(text).flatMap(splitLongSentence)
}

/** `splitSentences` without the long-sentence cut — for a streaming reader,
 *  which must not cut a sentence that is still growing. */
export function splitSentencesRaw(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => splitLine(line.replace(/\s+/g, ' ').trim()))
}

function splitLine(line: string): string[] {
  if (!line) return []
  const sentences: string[] = []
  let start = 0
  // Terminal punctuation run, closing quotes/brackets, then whitespace.
  const boundary = /([.!?…]+)(["'”’)\]]*)(\s+)/g
  let m: RegExpExecArray | null
  while ((m = boundary.exec(line))) {
    const punct = m[1]
    const endOfSentence = m.index + punct.length + m[2].length
    const next = line.slice(m.index + m[0].length)
    if (!next) break
    if (!isBoundary(line.slice(start, m.index), punct, next)) continue
    sentences.push(line.slice(start, endOfSentence).trim())
    start = m.index + m[0].length
  }
  const rest = line.slice(start).trim()
  if (rest) sentences.push(rest)
  return sentences
}

/** Should the text before `punct` end here, given what follows? */
function isBoundary(before: string, punct: string, next: string): boolean {
  // Ellipses trail off mid-thought: "Well… maybe". Never a cut.
  if (punct.includes('…') || /\.{2,}/.test(punct)) return false
  // "?" and "!" always end a sentence.
  if (!punct.startsWith('.')) return true

  const nextChar = next[0]
  // "e.g. the", "approx. two": a lowercase continuation is never a new sentence.
  if (/\p{Ll}/u.test(nextChar)) return false

  const token = (/(\S+)$/.exec(before)?.[1] ?? '').replace(/^["'“‘(\[]+/, '')
  const key = token.toLowerCase()
  if (NEVER_SPLIT.has(key)) return false
  if (SPLIT_BEFORE_CAPITAL.has(key)) {
    if (key === 'no' || key === 'nos') return !/\d/.test(nextChar)
    return /\p{Lu}/u.test(nextChar)
  }
  // Initials: "J. R. R. Tolkien", "John F. Kennedy" (but "So did I. Then").
  if (/^\p{Lu}$/u.test(token) && token !== 'I') return false
  // Dotted abbreviations not in the list: "N.A.S.A. rocket" / "a.b.c.".
  if (/^(?:\p{L}\.)+\p{L}$/u.test(token)) return false
  // A bare number opening a sentence ("1. Setup") is a label, not a sentence.
  if (/^\d{1,3}$/.test(token) && before.trim() === token) return false
  return true
}

/** Cut a finished sentence over ~40 words at the ; or , nearest its middle. */
export function splitLongSentence(sentence: string): string[] {
  const words = sentence.split(' ')
  if (words.length <= MAX_WORDS) return [sentence]

  let best = -1
  let bestScore = Infinity
  const mid = words.length / 2
  for (let i = MIN_PART_WORDS - 1; i < words.length - MIN_PART_WORDS; i++) {
    const w = words[i]
    const semicolon = /;["'”’)\]]*$/.test(w)
    const comma = /,["'”’)\]]*$/.test(w)
    if (!semicolon && !comma) continue
    // Prefer semicolons (a stronger pause), then the cut nearest the middle.
    const score = Math.abs(i + 1 - mid) - (semicolon ? words.length / 4 : 0)
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best < 0) return [sentence]
  return [
    ...splitLongSentence(words.slice(0, best + 1).join(' ')),
    ...splitLongSentence(words.slice(best + 1).join(' ')),
  ]
}
