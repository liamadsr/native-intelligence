/**
 * An email → what listen mode reads aloud as its thread opens (the headless
 * Listen target, components/read-aloud/listen-target.tsx, that
 * components/email/email-thread-detail.tsx mounts): a preface — who it is
 * from, what it is about — then ONLY the message itself, as prose.
 *
 * The message is what the sender wrote in THIS email. Not read:
 *   - what isn't text, or isn't shown: scripts, styles, images, media, form
 *     controls, buttons; hidden elements — `hidden`, aria-hidden, inline
 *     display:none / visibility:hidden / mso-hide:all / opacity:0, a zero
 *     (max-)height with overflow hidden, text at font-size 0, and a <style>
 *     rule's display:none on a plain class or id (newsletter preheaders);
 *   - quoted history: blockquotes and the clients' quote containers, the
 *     attribution above them ("On … wrote:"), and, to the end of the email,
 *     Outlook's reply header (divRplyFwdMsg, appendonsend, the "From: / Sent:
 *     / Subject:" block), "-----Original Message-----", "---------- Forwarded
 *     message ---------" and a rule of underscores. A quote is only what it
 *     quotes: the sender's own words after it or between its parts (a
 *     bottom-posted or inline reply) are read;
 *   - signatures: the clients' signature containers, a "-- " line and what
 *     follows it, mobile taglines ("Sent from my iPhone") anywhere;
 *   - past the sign-off: the last "Best," / "Thanks," … near the end is read
 *     with the name under it, not the title, phone, address and links below
 *     (a P.S. after them is read);
 *   - footers, from the end back: unsubscribe and preferences links, "you are
 *     receiving this", legal and confidentiality notices, © lines, with the
 *     address, phone and link lines among them; and a leading "View this
 *     email in your browser".
 * A pure forward (nothing of the sender's own above it) reads the forwarded
 * message instead, without its From / Date / Subject / To lines; so does an
 * email that is all one unlabelled quote. A reply that says nothing of its
 * own reads nothing: its quote is the earlier mail, not this one.
 *
 * Every cut fails safe: where a rule can't tell a signature or a footer from
 * the message, the text stays. A sign-off cut needs a name under it and no
 * prose, list or heading after it; a footer cut needs one unmistakable footer
 * line and never takes the whole message; a footer word such as
 * "unsubscribe" counts only as a link or beside a URL, and only at the end.
 *
 * HTML (bodyHtml, preferred) is read block by block: paragraphs, headings,
 * list items, table cells (layout tables included), lines broken by <br>;
 * links as their text, a URL as its host (./speech-text). Plain text
 * (bodyText, or HTML that says nothing) is read paragraph by paragraph, its
 * hard-wrapped lines joined, list lines kept as items.
 *
 * Pure: no React. HTML goes through DOMParser (the browser; jsdom in tests),
 * whose documents are inert: no script runs, nothing loads.
 */

import { linesToSentences, type SectionLine, type SectionLineKind } from './sections'
import { plainTextToSpeech, splitSentences, withTerminalPunctuation } from './speech-text'

/** The slice of an email message read here (EmailMessageData fits it). */
export interface EmailSpeechMessage {
  from: { name?: string | null; email?: string | null }
  subject?: string | null
  bodyHtml?: string | null
  bodyText?: string | null
}

// ── Public API ─────────────────────────────────────────────────────────────

/** What "Listen" reads: the preface, then the message's sentences. A body
 *  that opens by repeating its subject (a newsletter's headline, a plain-text
 *  title line) skips that line: the preface already said "about …". */
export function emailToSentences(message: EmailSpeechMessage): string[] {
  const preface = emailPreface(message)
  const body = dropSubjectEcho(emailBodyLines(message), cleanSubject(message.subject ?? ''))
  return [...(preface ? splitSentences(preface) : []), ...linesToSentences(body)]
}

/** How many opening lines a repeated subject is looked for in. */
const SUBJECT_ECHO_LINES = 3
/** A text line longer than this is the message itself, not its opening. */
const OPENING_LINE_MAX_WORDS = 5

/**
 * The body without the one opening line that repeats the subject. The opening
 * is the first few headings and short lines, up to the first real sentence of
 * the message, so a button further down ("Reset your password") stays. A
 * line repeats the subject when:
 *   - it has the whole subject in it and at most three words more
 *     ("Q3 planning", "Product updates — September 2026");
 *   - or it is a heading that is mostly subject words and at least half the
 *     subject ("Product updates" under "Native Intelligence product updates: September").
 * A text line needs the first rule, so a greeting that shares a subject's
 * first words ("Hi Liam," under "Hi Liam, quick question") stays.
 */
export function dropSubjectEcho(lines: SectionLine[], subject: string): SectionLine[] {
  const subjectWords = echoWords(subject)
  if (subjectWords.length === 0) return lines
  const limit = Math.min(lines.length, SUBJECT_ECHO_LINES)
  for (let i = 0; i < limit; i++) {
    if (echoesSubject(lines[i], subjectWords)) return [...lines.slice(0, i), ...lines.slice(i + 1)]
    if (lines[i].kind !== 'heading' && echoWords(lines[i].text).length > OPENING_LINE_MAX_WORDS) break
  }
  return lines
}

function echoWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function echoesSubject(line: SectionLine, subject: readonly string[]): boolean {
  const words = echoWords(line.text)
  if (words.length === 0) return false
  const covered = subject.filter((word) => words.includes(word)).length
  if (covered === subject.length && words.length <= subject.length + 3) return true
  if (line.kind !== 'heading') return false
  const fromSubject = words.filter((word) => subject.includes(word)).length
  return fromSubject / words.length >= 0.8 && covered / subject.length >= 0.5
}

/**
 * "From Sarah Chen, about Q3 planning." The sender is the display name, else
 * the address; the subject loses its Re: / Fwd: prefixes and [EXT]-style tags
 * (cleanSubject). No subject: "From Sarah Chen."
 */
export function emailPreface(message: Pick<EmailSpeechMessage, 'from' | 'subject'>): string {
  const name = plainTextToSpeech(clean(message.from?.name ?? '').replace(/^["'“‘]+|["'”’]+$/g, ''))
  const sender = name || clean(message.from?.email ?? '')
  const subject = plainTextToSpeech(cleanSubject(message.subject ?? ''))
  if (sender && subject) return `From ${sender}, about ${withTerminalPunctuation(subject)}`
  if (sender) return `From ${sender}.`
  return subject ? `About ${withTerminalPunctuation(subject)}` : ''
}

/** Reply and forward prefixes: Re:, RE[2]:, Fwd:, FW:, Fw:. */
const SUBJECT_PREFIX_RE = /^(?:re|fwd?)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*/i
/** A forward's prefix. */
const FORWARD_PREFIX_RE = /^fwd?\s*(?:\[\d+\]|\(\d+\))?\s*[:：]/i
/** External-sender tags: [EXT], [External Email], (External), *EXTERNAL*, EXTERNAL:. */
const SUBJECT_TAG_RE =
  /^(?:[[(](?:ext|external)(?:\s+(?:email|sender|message))?[\])]|\*(?:ext|external)\*|(?:ext|external)\s*:)\s*/i

/** A subject without its reply / forward prefixes and external-sender tags,
 *  however many and in any order. */
export function cleanSubject(subject: string): string {
  let text = clean(subject)
  for (let previous = ''; previous !== text; ) {
    previous = text
    text = text.replace(SUBJECT_TAG_RE, '').replace(SUBJECT_PREFIX_RE, '')
  }
  return text
}

/** Whether the subject's first prefix is a forward's: "Fwd: Re: …" is, "Re:
 *  Fwd: …" (a reply to a forward) is not. */
function isForwardSubject(subject: string): boolean {
  let text = clean(subject)
  for (let previous = ''; previous !== text; ) {
    previous = text
    text = text.replace(SUBJECT_TAG_RE, '')
  }
  return FORWARD_PREFIX_RE.test(text)
}

/**
 * The message's lines in reading order, each a paragraph, a heading or a
 * list item, speakable, without anything this module's comment lists as not
 * read. HTML first; the plain text when there is no HTML or it says nothing.
 * The subject tells a forward (Outlook marks a reply and a forward the same
 * way).
 */
export function emailBodyLines(message: Pick<EmailSpeechMessage, 'bodyHtml' | 'bodyText' | 'subject'>): SectionLine[] {
  const forward = isForwardSubject(message.subject ?? '')
  const html = message.bodyHtml?.trim() ?? ''
  if (html) {
    const lines = readBody(HTML_MARKUP_RE.test(html) ? htmlLines(html) : textLines(html), forward)
    if (lines.length > 0) return lines
  }
  const text = message.bodyText?.trim() ?? ''
  return text ? readBody(textLines(text), forward) : []
}

/** Markup, as opposed to plain text that happens to sit in the HTML part. */
const HTML_MARKUP_RE =
  /<\/?(?:html|head|body|div|p|br|span|a|b|i|u|em|strong|font|table|tr|td|ul|ol|li|h[1-6]|blockquote|pre|img|center|hr)\b[^>]*>/i

// ── Lines ──────────────────────────────────────────────────────────────────

/** One line of the body as it is sorted: a paragraph, a <br>-broken line, a
 *  table cell, a plain-text line. */
interface BodyLine {
  /** Whitespace collapsed, invisible characters out ('' on a cut). */
  text: string
  kind: SectionLineKind
  /** Quote nesting: a quote's lines sit deeper than the words around it. */
  depth: number
  /** Consecutive lines with one id read as one: a hard-wrapped plain-text
   *  paragraph, a sign-off and its name. */
  para: number
  /** HTML: the text inside links, and the spoken words outside them. */
  linkText?: string
  plainWords?: number
  /** Inside a reply attribution or an Outlook reply header. */
  header?: boolean
  /** Inside a signature container. */
  signature?: boolean
  /** Outlook's reply header starts here: the rest is the old message. No text. */
  cut?: boolean
  /** Plain text: the line is indented (a wrapped header value). */
  indented?: boolean
}

/** Invisible characters templates pad with: zero-width spaces and joiners,
 *  direction marks, soft hyphens, the combining grapheme joiner of preheader
 *  padding, fillers, byte-order marks. */
const INVISIBLE_RE =
  /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁪-⁯ㅤ﻿ﾠ]/g

function clean(text: string): string {
  return text.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ').trim()
}

const SPEAKABLE_RE = /[\p{L}\p{N}]/u
const LOWERCASE_START_RE = /^\p{Ll}/u

function speakable(text: string): boolean {
  return SPEAKABLE_RE.test(text)
}

/** The words with a letter or a digit, leading punctuation off. */
function spokenWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(speakable)
}

// ── HTML → lines ───────────────────────────────────────────────────────────

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** Never read: not text, or not shown as text. */
const NON_CONTENT = new Set([
  'script', 'style', 'head', 'title', 'meta', 'link', 'base', 'noscript', 'template',
  'img', 'picture', 'source', 'track', 'svg', 'video', 'audio', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'canvas', 'map', 'area',
  'input', 'select', 'option', 'optgroup', 'datalist', 'textarea', 'button', 'output', 'progress', 'meter',
  'xml',
])

/** Elements that end the line before them and their own last line. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details', 'dialog',
  'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'legend', 'li', 'listing', 'main', 'menu',
  'nav', 'ol', 'p', 'plaintext', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul', 'xmp',
])

/** Quoted history: its lines sit one level deeper than the words around it. */
const QUOTE_CONTAINER = [
  'blockquote', '.gmail_quote', '.gmail_quote_container', '.yahoo_quoted', '.protonmail_quote',
  '.zmail_extra', '[data-marker="__QUOTED_TEXT__"]',
].join(', ')
/** Gmail's quote container, which also holds an inline reply's answers. */
const GMAIL_QUOTE_CONTAINER = '.gmail_quote, .gmail_quote_container'
/** A reply's attribution ("On … wrote:") above the quote, or the header
 *  table of a message Thunderbird forwards (label and value in separate cells). */
const ATTRIBUTION_CONTAINER = '.gmail_attr, .moz-cite-prefix, .moz-email-headers-table'
/** Outlook's reply / forward header: from here on, the email is the old message. */
const OUTLOOK_REPLY_HEADER = [
  '#divRplyFwdMsg', '[id$="divRplyFwdMsg"]', '#appendonsend', '[id$="appendonsend"]',
  '.OutlookMessageHeader', 'hr#stopSpelling',
].join(', ')
/** Signature containers. Not Apple Mail's #AppleMailSignature: iOS can put
 *  the typed reply inside it; its "Sent from my iPhone" goes as a tagline. */
const SIGNATURE_CONTAINER = [
  '.gmail_signature', '[data-smartmail="gmail_signature"]', '#Signature', '#signature',
  '.moz-signature', '#ms-outlook-mobile-signature',
].join(', ')

interface WalkState {
  depth: number
  header: boolean
  signature: boolean
  heading: boolean
  link: boolean
  /** Inherited font-size 0 / visibility hidden: the text isn't shown. Unlike
   *  display:none, a descendant can show its own text again. */
  fontZero: boolean
  invisible: boolean
}

function htmlLines(html: string): BodyLine[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const writer = new LineWriter(hiddenByStylesheet(doc))
  writer.walk(doc.body, {
    depth: 0, header: false, signature: false, heading: false, link: false, fontZero: false, invisible: false,
  })
  writer.end()
  return writer.lines
}

/** Walks the parsed body in document order, writing its lines. */
class LineWriter {
  readonly lines: BodyLine[] = []
  private readonly sheetHidden: Map<Element, boolean>
  private text = ''
  private linkText = ''
  private plainText = ''
  private state: WalkState | null = null
  /** Inside an <li> whose first line is not written yet. */
  private item = false
  private para = 0

  constructor(sheetHidden: Map<Element, boolean>) {
    this.sheetHidden = sheetHidden
  }

  walk(parent: Node, state: WalkState): void {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === TEXT_NODE) {
        if (!state.fontZero && !state.invisible) this.add(node.nodeValue ?? '', state)
        continue
      }
      if (node.nodeType !== ELEMENT_NODE) continue
      const el = node as Element
      const tag = el.localName
      if (tag === 'br') {
        this.end()
        continue
      }
      if (NON_CONTENT.has(tag)) continue
      const style = inlineStyle(el)
      if (isHidden(el, style, this.sheetHidden)) continue
      if (el.matches(OUTLOOK_REPLY_HEADER)) this.cut(state)

      const inner = enter(el, tag, style, state)
      // Quote, header and signature containers are block edges too, so no
      // line is ever half inside one.
      const edge =
        BLOCK.has(tag) ||
        inner.depth !== state.depth ||
        inner.header !== state.header ||
        inner.signature !== state.signature
      if (edge) this.end()
      if (tag === 'li') this.item = true
      if (tag === 'pre' || /^(?:pre|break-spaces)/.test(style.get('white-space') ?? '')) this.pre(el, inner)
      else this.walk(el, inner)
      if (edge) this.end()
      if (tag === 'li') this.item = false
    }
  }

  /** End the current line: a <br>, a block edge, the end of the body. */
  end(): void {
    const text = clean(this.text)
    const state = this.state
    if (text && state) {
      this.lines.push({
        text,
        kind: state.heading ? 'heading' : this.item ? 'item' : 'text',
        depth: state.depth,
        para: ++this.para,
        linkText: clean(this.linkText),
        plainWords: spokenWords(clean(this.plainText)).length,
        header: state.header,
        signature: state.signature,
      })
      this.item = false
    }
    this.text = ''
    this.linkText = ''
    this.plainText = ''
    this.state = null
  }

  private add(text: string, state: WalkState) {
    if (!this.state && text.trim()) this.state = state
    this.text += text
    if (state.link) this.linkText += text
    else this.plainText += text
  }

  private cut(state: WalkState) {
    this.end()
    this.lines.push({ text: '', kind: 'text', depth: state.depth, para: ++this.para, cut: true })
  }

  /** Preformatted text (<pre>, white-space: pre…) keeps its line breaks, and
   *  reads as plain text does: its "> " quotes, paragraphs and list lines. */
  private pre(el: Element, state: WalkState) {
    this.end()
    if (state.fontZero || state.invisible) return
    const base = this.para
    for (const line of textLines(preformattedText(el, this.sheetHidden), state.depth)) {
      this.para = base + line.para
      this.lines.push({ ...line, para: this.para, header: state.header, signature: state.signature })
    }
  }
}

/** The state inside `el`. */
function enter(el: Element, tag: string, style: Map<string, string>, state: WalkState): WalkState {
  const next = { ...state }
  if (el.matches(QUOTE_CONTAINER) && !isInlineReplyContainer(el)) next.depth++
  if (el.matches(ATTRIBUTION_CONTAINER) || el.matches(OUTLOOK_REPLY_HEADER)) next.header = true
  if (el.matches(SIGNATURE_CONTAINER)) next.signature = true
  if (/^h[1-6]$/.test(tag)) next.heading = true
  if (tag === 'a') next.link = true
  const fontZero = fontSizeIsZero(style)
  if (fontZero !== undefined) next.fontZero = fontZero
  const visibility = style.get('visibility')
  if (visibility) next.invisible = visibility === 'hidden' || visibility === 'collapse'
  return next
}

/**
 * Gmail's quote container around a reply ("On … wrote:" heading
 * blockquotes). An inline reply breaks the quote into blockquotes with the
 * sender's answers between them, inside this container: the blockquotes mark
 * the quote, so the container itself doesn't, and the answers are read. A
 * forward's container holds the forwarded mail outside any blockquote, and
 * stays quoted.
 */
function isInlineReplyContainer(el: Element): boolean {
  if (el.localName === 'blockquote' || !el.matches(GMAIL_QUOTE_CONTAINER) || !el.querySelector('blockquote')) {
    return false
  }
  let attribution = el.querySelector(ATTRIBUTION_CONTAINER)?.textContent
  if (attribution === undefined) {
    attribution = ''
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === ELEMENT_NODE && (node as Element).localName === 'blockquote') break
      attribution += node.textContent ?? ''
    }
  }
  return attributionStrength(clean(attribution)) !== null
}

/** An element's text with <br> and block edges as line breaks. */
function preformattedText(root: Element, sheetHidden: Map<Element, boolean>): string {
  let text = ''
  const walk = (parent: Node) => {
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === TEXT_NODE) {
        text += node.nodeValue ?? ''
        continue
      }
      if (node.nodeType !== ELEMENT_NODE) continue
      const el = node as Element
      if (el.localName === 'br') {
        text += '\n'
        continue
      }
      if (NON_CONTENT.has(el.localName) || isHidden(el, inlineStyle(el), sheetHidden)) continue
      const block = BLOCK.has(el.localName)
      if (block && !text.endsWith('\n')) text += '\n'
      walk(el)
      if (block && !text.endsWith('\n')) text += '\n'
    }
  }
  walk(root)
  return text
}

// ── Hidden elements ────────────────────────────────────────────────────────

/** Whether `el` and everything in it is hidden. */
function isHidden(el: Element, style: Map<string, string>, sheetHidden: Map<Element, boolean>): boolean {
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') return true
  const display = style.get('display')
  if (display === 'none' || style.get('mso-hide') === 'all') return true
  const opacity = style.get('opacity')
  if (opacity !== undefined && parseFloat(opacity) === 0) return true
  // A zero height hides only what can't overflow it.
  const overflow = style.get('overflow') ?? style.get('overflow-y')
  if (
    (overflow === 'hidden' || overflow === 'clip') &&
    (isZeroLength(style.get('max-height')) || isZeroLength(style.get('height')))
  ) {
    return true
  }
  // A <style> rule's display:none, unless the element's own style shows it
  // and the rule isn't !important.
  const important = sheetHidden.get(el)
  return important !== undefined && (important || display === undefined)
}

/**
 * Whether the element sets its text to size 0 (true), to a size (false), or
 * leaves the inherited one (undefined). Templates set 0 on a wrapper to close
 * the gaps between inline-block columns, and a size again on each column:
 * only text that is itself at size 0 is hidden.
 */
function fontSizeIsZero(style: Map<string, string>): boolean | undefined {
  const size = style.get('font-size')
  if (size !== undefined) return isZeroLength(size)
  // The shorthand: "0/0 a", "bold 14px/20px Arial".
  const token = style
    .get('font')
    ?.split(/\s+/)
    .find((part) => /^(?:0|\d*\.?\d+(?:[a-z]+|%))(?:\/\S+)?$/.test(part))
  return token === undefined ? undefined : isZeroLength(token.split('/')[0])
}

function isZeroLength(value: string | undefined): boolean {
  return value !== undefined && /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?$/.test(value)
}

interface Declaration {
  prop: string
  value: string
  important: boolean
}

/** "a: b; c: d !important" → declarations, lowercased, !important noted. */
function declarations(css: string | null): Declaration[] {
  const out: Declaration[] = []
  for (const part of (css ?? '').split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    const raw = part.slice(colon + 1)
    if (!prop) continue
    out.push({ prop, value: raw.replace(/!\s*important/gi, '').trim().toLowerCase(), important: /!\s*important/i.test(raw) })
  }
  return out
}

/** An element's inline style; the last declaration of a property wins. */
function inlineStyle(el: Element): Map<string, string> {
  return new Map(declarations(el.getAttribute('style')).map((d) => [d.prop, d.value]))
}

/** ".preheader", "span.preview", "#hidden-text", ".a.b": no combinators, no pseudo-classes. */
const SIMPLE_SELECTOR_RE = /^(?:[a-z][a-z0-9]*)?(?:[.#][a-z_-][\w-]*)+$/i

/**
 * The elements a <style> sheet hides with display:none on a plain class or id
 * selector (a Postmark-style `.preheader`), each mapped to whether its rule is
 * !important. At-rule blocks (@media, @supports …) are skipped: a rule for
 * some screens only decides nothing here, so a hybrid template's hidden twin
 * (desktop or mobile) is dropped and the other read.
 */
function hiddenByStylesheet(doc: Document): Map<Element, boolean> {
  const hidden = new Map<Element, boolean>()
  for (const sheet of doc.querySelectorAll('style')) {
    const media = (sheet.getAttribute('media') ?? '').trim().toLowerCase()
    if (media && media !== 'all' && media !== 'screen') continue
    const css = withoutAtRules((sheet.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, ''))
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const display = declarations(rule[2])
        .filter((d) => d.prop === 'display')
        .pop()
      if (display?.value !== 'none') continue
      for (const selector of rule[1].split(',')) {
        const simple = selector.trim()
        if (!SIMPLE_SELECTOR_RE.test(simple)) continue
        try {
          for (const el of doc.querySelectorAll(simple)) hidden.set(el, display.important || (hidden.get(el) ?? false))
        } catch {
          // A selector the engine refuses hides nothing.
        }
      }
    }
  }
  return hidden
}

/** CSS without its at-rules: a block (@media … { … }) up to its matching
 *  brace, a statement (@import …;) up to its semicolon. */
function withoutAtRules(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const at = css.indexOf('@', i)
    if (at < 0) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, at)
    let j = at
    while (j < css.length && css[j] !== '{' && css[j] !== ';') j++
    if (css[j] === '{') {
      for (let depth = 0; j < css.length; j++) {
        if (css[j] === '{') depth++
        else if (css[j] === '}' && --depth === 0) break
      }
    }
    i = j + 1
  }
  return out
}

// ── Plain text → lines ─────────────────────────────────────────────────────

/** "> ", ">> ", "> > ": the marks a plain-text reply puts on each quoted line. */
const QUOTE_MARKS_RE = /^[ \t]*((?:>[ \t]?)+)/
/** A list line: "- ", "* ", "• ", "1. ", "1) ". */
const LIST_LINE_RE = /^(?:[-*•]|\d{1,2}[.)])[ \t]+(?=\S)/
/** A line this long was hard-wrapped (clients wrap at 72–78) and runs on into
 *  the next; a shorter one ended where its writer ended it ("Best," / "Sarah",
 *  "Revenue: $1.2M" / "Churn: 2%"). */
const WRAPPED_LINE_MIN = 50

/**
 * Plain text → lines, one per text line. A paragraph's hard-wrapped lines
 * share a para id, so they read as one; a paragraph ends at a blank line, a
 * change of quote depth, a list line, or a line too short to have wrapped. A
 * list line starts an item, which its indented or lowercase continuation
 * lines join.
 */
function textLines(text: string, depth0 = 0): BodyLine[] {
  const lines: BodyLine[] = []
  let para = 0
  let paraKind: SectionLineKind = 'text'
  let previous: BodyLine | null = null
  let blank = true
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const marks = QUOTE_MARKS_RE.exec(raw)
    const body = marks ? raw.slice(marks[0].length) : raw
    const cleaned = clean(body)
    if (!cleaned) {
      blank = true
      continue
    }
    const depth = depth0 + (marks ? marks[1].replace(/[ \t]/g, '').length : 0)
    const list = LIST_LINE_RE.exec(cleaned)
    const indented = /^[ \t]/.test(body)
    const runsOn =
      !blank &&
      previous !== null &&
      previous.depth === depth &&
      !list &&
      (paraKind === 'item'
        ? indented || LOWERCASE_START_RE.test(cleaned)
        : previous.text.length >= WRAPPED_LINE_MIN)
    if (!runsOn) {
      para++
      paraKind = list ? 'item' : 'text'
    }
    previous = {
      text: list ? cleaned.slice(list[0].length) : cleaned,
      kind: list ? 'item' : 'text',
      depth,
      para,
      indented: !marks && indented,
    }
    lines.push(previous)
    blank = false
  }
  return lines
}

// ── Quoted history ─────────────────────────────────────────────────────────

/** "-----Original Message-----", "---------- Forwarded message ---------", and translations. */
const SEPARATOR_RE =
  /^-{2,}\s*(?:original message|forwarded message|forwarded e-?mail|message d['’]origine|message transféré|ursprüngliche nachricht|weitergeleitete nachricht|mensaje original|mensaje reenviado|messaggio originale|messaggio inoltrato|mensagem original|mensagem encaminhada|oorspronkelijk bericht|doorgestuurd bericht)\s*-{2,}$/i
/** The separators that forward rather than quote. */
const FORWARD_WORD_RE = /forward|transféré|weitergeleitet|reenviado|inoltrato|encaminhad|doorgestuurd/i
/** Apple Mail's forward. */
const BEGIN_FORWARD_RE = /^begin forwarded message\s*:?$/i
/** Outlook's plain-text rule above a reply header. */
const UNDERSCORE_RULE_RE = /^_{20,}$/

/** Outlook's header block: a From line, then a Sent (or Date) and a Subject line. */
const FROM_LINE_RE = /^(?:from|de|von|van|da|från|fra)\s*:\s*\S/i
const SENT_LINE_RE = /^(?:sent|date|envoyé|gesendet|datum|enviado|fecha|inviato|data|verzonden|skickat|sendt)\s*:\s*\S/i
const SUBJECT_LINE_RE = /^(?:subject|objet|betreff|asunto|oggetto|assunto|onderwerp|ämne|emne)\s*:/i
/** How far under the From line its Sent and Subject lines may sit. */
const HEADER_BLOCK_LINES = 6
/** Any header line of a quoted or forwarded message (its head is skipped). */
const HEADER_LINE_RE =
  /^(?:from|sent|date|to|cc|bcc|subject|reply-to|de|von|envoyé|gesendet|datum|à|an|objet|betreff|asunto|para|enviado|fecha|cco|oggetto|inviato|da|data|assunto|onderwerp|van|aan|verzonden)\s*:/i

/** A reply's attribution, in the clients' wordings: "On … wrote:", "Le … a
 *  écrit :", "Am … schrieb … :", "Sarah Chen <sarah@acme.com> wrote:". */
const ATTRIBUTION_RES = [
  /^-*\s*(?:on|le|el|il|em)\b.{4,300}?\b(?:wrote|a écrit|escribió|ha scritto|escreveu)\s*:?\s*-*$/i,
  /^(?:am|op|den)\b.{4,200}?\b(?:schrieb|schreef|skrev)\b.{0,200}:$/i,
  /^[^:]{1,200}(?:<[^<>\s]+@[^<>\s]+>|\S+@\S+\.\w+)\)?\s*wrote\s*:$/i,
]
/** How an attribution starts, for one wrapped onto a second line. */
const ATTRIBUTION_START_RE = /^-*\s*(?:on|le|el|il|em|am|op|den)\b/i

/**
 * An attribution line is `strong` with an address or a time in it (the
 * clients always write one): only then does it end the message when nothing
 * marks the quote under it. A date alone (a year, 9/26/26) is `weak`: it only
 * heads a marked quote. "On page 3, the author wrote:" is neither.
 */
function attributionStrength(text: string): 'strong' | 'weak' | null {
  if (text.length > 400 || !ATTRIBUTION_RES.some((re) => re.test(text))) return null
  if (/@|\b\d{1,2}[:.h]\d{2}\b/.test(text)) return 'strong'
  return /\b(?:19|20)\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(text) ? 'weak' : null
}

/** The attribution starting at line `i`: its length in lines (a plain-text
 *  one can wrap onto a second) and strength. Header lines count as strong. */
function attributionAt(lines: BodyLine[], i: number): { length: number; strong: boolean } | null {
  const line = lines[i]
  if (line.header) return { length: 1, strong: true }
  const one = attributionStrength(line.text)
  if (one) return { length: 1, strong: one === 'strong' }
  const next = lines[i + 1]
  if (!next || next.cut || next.depth !== line.depth || !ATTRIBUTION_START_RE.test(line.text)) return null
  const two = attributionStrength(`${line.text} ${next.text}`)
  return two ? { length: 2, strong: two === 'strong' } : null
}

/** Outlook's "From: … Sent: … To: … Subject: …" block starts at line `i`. */
function isHeaderBlock(lines: BodyLine[], i: number): boolean {
  if (!FROM_LINE_RE.test(lines[i].text)) return false
  let sent = false
  let subject = false
  for (let j = i + 1, seen = 0; j < lines.length && seen < HEADER_BLOCK_LINES; j++) {
    const text = lines[j].text
    if (!text) continue
    seen++
    if (SENT_LINE_RE.test(text)) sent = true
    else if (SUBJECT_LINE_RE.test(text)) subject = true
  }
  return sent && subject
}

/** A line from which everything is the old message. */
function startsOldMessage(lines: BodyLine[], i: number): boolean {
  const text = lines[i].text
  return SEPARATOR_RE.test(text) || BEGIN_FORWARD_RE.test(text) || UNDERSCORE_RULE_RE.test(text) || isHeaderBlock(lines, i)
}

function nextSpeakable(lines: BodyLine[], from: number): number {
  for (let i = from; i < lines.length; i++) if (speakable(lines[i].text)) return i
  return -1
}

/**
 * The sender's own lines at quote depth `base`, and where the first quote
 * starts (-1: none). A deeper line is quoted; an attribution with a marked
 * quote under it is skipped, and the sender's words after that quote still
 * count (bottom-posted and inline replies). A cut, an old-message line, or a
 * strong attribution with nothing marked under it ends the message there.
 */
function splitOwn(lines: BodyLine[], base: number): { own: BodyLine[]; quoteAt: number } {
  const own: BodyLine[] = []
  let quoteAt = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.depth < base) break // the quote this message sits in ended
    if (line.depth > base) {
      if (quoteAt < 0) quoteAt = i
      continue
    }
    if (line.cut) {
      if (quoteAt < 0) quoteAt = i
      break
    }
    if (!line.text) continue
    if (startsOldMessage(lines, i)) {
      if (quoteAt < 0) quoteAt = i
      break
    }
    const attribution = attributionAt(lines, i)
    if (attribution) {
      const next = nextSpeakable(lines, i + attribution.length)
      if (next < 0 || lines[next].depth > base) {
        if (quoteAt < 0) quoteAt = i
        i += attribution.length - 1
        continue
      }
      if (attribution.strong) {
        if (quoteAt < 0) quoteAt = i
        break
      }
      // A weak one with nothing quoted under it is just a line.
    }
    own.push(line)
  }
  return { own, quoteAt }
}

/** The message a quote or forward holds, from line `at`: past its head
 *  (markers, attribution, header lines: From / Date / Subject / To …), and
 *  what that head says it is. */
function quotedBody(
  lines: BodyLine[],
  at: number,
): { lines: BodyLine[]; base: number; head: 'forward' | 'reply' | null } | null {
  let head: 'forward' | 'reply' | null = null
  let inHeader = false
  for (let i = at; i < lines.length; i++) {
    const line = lines[i]
    if ((SEPARATOR_RE.test(line.text) && FORWARD_WORD_RE.test(line.text)) || BEGIN_FORWARD_RE.test(line.text)) {
      head = 'forward'
      continue
    }
    if (line.cut || line.header || SEPARATOR_RE.test(line.text)) {
      if (!head) head = 'reply'
      continue
    }
    if (!speakable(line.text)) continue
    const attribution = attributionAt(lines, i)
    if (attribution) {
      if (!head) head = 'reply'
      i += attribution.length - 1
      continue
    }
    if (HEADER_LINE_RE.test(line.text)) {
      if (!head) head = 'reply'
      inHeader = true
      continue
    }
    if (inHeader && line.indented) continue
    return { lines: lines.slice(i), base: line.depth, head }
  }
  return null
}

/** Forwards and quotes nest; this deep and no further. */
const MAX_NESTING = 8

/**
 * What the message in `lines` says, at quote depth `base`: its own lines,
 * trimmed. When it says nothing of its own, a forward (by its head, or by the
 * subject: `forward`) reads the message it forwards, and so does a quote with
 * no head at all (the whole email wrapped in one); a reply reads nothing.
 */
function messageLines(lines: BodyLine[], base: number, nesting: number, forward: boolean): BodyLine[] {
  const { own, quoteAt } = splitOwn(lines, base)
  const message = trimOwn(own)
  if (message.length > 0 || quoteAt < 0 || nesting >= MAX_NESTING) return message
  const quoted = quotedBody(lines, quoteAt)
  if (!quoted || (quoted.head === 'reply' && !forward)) return message
  return messageLines(quoted.lines, quoted.base, nesting + 1, false)
}

function readBody(lines: BodyLine[], forward: boolean): SectionLine[] {
  return toSectionLines(messageLines(lines, 0, 0, forward))
}

/**
 * Lines → what is read: a paragraph's lines joined (a list line or a heading
 * starts its own), speakable, and never the same line twice in a row. A
 * heading or item that ends in a comma ("Hi Liam,") reads as text, without
 * the period a heading gets.
 */
function toSectionLines(lines: BodyLine[]): SectionLine[] {
  const out: SectionLine[] = []
  let previous = ''
  let group: BodyLine[] = []
  const flush = () => {
    const text = plainTextToSpeech(group.map((line) => line.text).join(' '))
    if (text && text !== previous) out.push({ text, kind: text.endsWith(',') ? 'text' : group[0].kind })
    if (text) previous = text
    group = []
  }
  for (const line of lines) {
    if (group.length > 0 && (group[group.length - 1].para !== line.para || line.kind !== 'text')) flush()
    group.push(line)
  }
  if (group.length > 0) flush()
  return out
}

// ── Signatures, sign-off, footers ──────────────────────────────────────────

/** The sender's own lines, without signatures, taglines, what follows the
 *  sign-off, footers and a leading "view in browser". */
function trimOwn(own: BodyLine[]): BodyLine[] {
  let lines = own.filter((line) => !line.signature && !line.header && !isMobileTagline(line.text))
  lines = cutAtSignatureDelimiter(lines)
  lines = dropFooter(lines)
  lines = cutAfterSignOff(lines)
  lines = dropLeadingViewOnline(lines)
  return lines.filter((line) => speakable(line.text))
}

/** "Sent from my iPhone", "Get Outlook for iOS", "Sent from Yahoo Mail for
 *  Android", "Envoyé de mon iPhone": a client's line, not the sender's. */
const MOBILE_TAGLINE_RE =
  /^(?:(?:sent|envoyé|enviado|inviato|verzonden) (?:from|via|with|using|de|desde|da|met) (?:my |mon |mi |mio |mijn )?.{2,60}|von meinem .{2,40} gesendet|get outlook for .{2,20})$/i
/** …naming a device or a mail app ("Sent from the office" is the sender's). */
const TAGLINE_DEVICE_RE =
  /\b(?:iphone|ipad|ipod|android|mobile|phone|smartphone|tablet|device|galaxy|samsung|pixel|blackberry|huawei|xiaomi|oneplus|motorola|nokia|mail|outlook|yahoo|gmail|aol|protonmail|proton|superhuman|spark|edison|hey|fastmail|zoho|tuta|tutanota|bluemail|airmail|newton|front|missive|shortwave|watch|ios|windows|mac|macbook)\b/i

function isMobileTagline(text: string): boolean {
  return text.length <= 80 && MOBILE_TAGLINE_RE.test(text) && TAGLINE_DEVICE_RE.test(text)
}

/** "P.S.", "PS:", "P.P.S.": more of the message, after the signature. */
const PS_RE = /^p\.?\s?(?:p\.?\s?)?s\b/i

/**
 * How many of `tail`'s lines (what follows a sign-off or a "-- " line) are a
 * signature: all of them, or those before a P.S. (which is read). -1 when
 * they read as more of the message: a list item or a heading, or a sentence
 * first.
 */
function signatureLength(tail: BodyLine[]): number {
  const ps = tail.findIndex((line) => PS_RE.test(line.text))
  const signature = ps < 0 ? tail : tail.slice(0, ps)
  const said = signature.filter((line) => speakable(line.text))
  if (said.some((line) => line.kind !== 'text')) return -1
  if (said.length > 0 && isProse(said[0].text)) return -1
  return signature.length
}

/** A sentence, not a signature line: five or more words, at least half of
 *  them after the first lowercase. */
function isProse(text: string): boolean {
  if (isContactOnly(text)) return false
  const words = spokenWords(text)
  if (words.length < 5) return false
  const rest = words.slice(1)
  return rest.filter((word) => LOWERCASE_START_RE.test(word)).length * 2 >= rest.length
}

/** The conventional "-- " line (the last one) and the signature under it. */
function cutAtSignatureDelimiter(lines: BodyLine[]): BodyLine[] {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text !== '--') continue
    const tail = lines.slice(i + 1)
    const length = signatureLength(tail)
    return length < 0 ? lines : [...lines.slice(0, i), ...tail.slice(length)]
  }
  return lines
}

/** Sign-offs, matched on a whole line (with an optional name after them). */
const VALEDICTIONS = [
  'best', 'all the best', 'all best', 'very best', 'my best', 'all my best', 'bests',
  'best wishes', 'warm wishes', 'warmest wishes', 'with best wishes',
  'regards', 'best regards', 'kind regards', 'kindest regards', 'warm regards', 'warmest regards',
  'many regards', 'with regards', 'with kind regards', 'with best regards', 'with warm regards', 'rgds', 'br', 'kr',
  'warmly', 'cordially', 'respectfully', 'sincerely', 'yours sincerely', 'sincerely yours', 'yours truly',
  'yours faithfully', 'yours',
  'thanks', 'thank you', 'thanks so much', 'thank you so much', 'thanks a lot', 'thanks a million',
  'thanks again', 'thank you again', 'many thanks', 'thanks in advance', 'thank you in advance', 'thx',
  'thanks and regards', 'thanks & regards', 'thanks and best regards', 'thanks and best', 'with thanks',
  'with gratitude', 'gratefully', 'much appreciated', 'appreciate it',
  'cheers', 'talk soon', 'speak soon', 'chat soon', 'talk later', 'take care', 'see you soon', 'see you then',
  'have a great day', 'have a great weekend', 'have a good one', 'stay safe', 'be well', 'onward', 'onwards',
  'love', 'xo', 'xoxo', 'hugs',
]
const VALEDICTION_RE = new RegExp(
  `^(?:${[...VALEDICTIONS]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/ /g, '\\s+'))
    .join('|')})(?=$|[\\s,.!…:;—–-])[\\s,.!…:;—–-]*`,
  'i',
)
/** A name on the sign-off line: "Thanks, Sarah", "Best, Sarah C." (case-sensitive). */
const INLINE_NAME_RE = /^\p{Lu}[\p{L}\p{N}'’.-]*(?:\s+\p{Lu}[\p{L}\p{N}'’.-]*){0,2}[.!,]*$/u
/** The last this many lines are where a sign-off can be. */
const SIGN_OFF_WINDOW = 15

/** A sign-off line ("Best,", "Thanks!", "Kind regards"), or one with the
 *  name on it ("Thanks, Sarah"); null for anything else. */
function signOff(text: string): { named: boolean } | null {
  const match = VALEDICTION_RE.exec(text)
  if (!match) return null
  const rest = text.slice(match[0].length).trim()
  if (!rest) return { named: false }
  return INLINE_NAME_RE.test(rest) ? { named: true } : null
}

/**
 * A body without its closing sign-off ("Best, Sarah", "Thanks!"), when
 * something comes before it. In a thread the intro already says who wrote
 * (./email-thread-speech: "Sarah wrote first."), so the name again at the end
 * is noise. A message that is only "Thanks!" keeps it: that is what it says.
 */
export function dropClosingSignOff(lines: SectionLine[]): SectionLine[] {
  const last = lines.length - 1
  if (last < 1 || lines[last].kind !== 'text' || !signOff(lines[last].text)) return lines
  return lines.slice(0, last)
}

/** A capitalised word of a name ("Sarah", "Chen,", "Dr.", "Web3"), or a
 *  particle between them ("van", "the", "at", "team"). */
const NAME_WORD_RE = /^\p{Lu}[\p{L}\p{N}'’.-]*,?$/u
const NAME_PARTICLE_RE = /^(?:of|the|and|at|from|team|de|del|della|di|da|van|von|der|den|le|la|du|dos|das|bin|al)$/

/** A signature's name line: "Sarah", "Sarah Chen", "— Sarah", "Dr. Sarah
 *  Chen, PhD", "The Native Intelligence team". Not "Works for me", not "Revenue: $1.2M". */
function isNameLine(text: string): boolean {
  const name = text
    .replace(/^[\s\-–—~]+/, '')
    .replace(/\s*\([^()]*\)$/, '')
    .replace(/[.,!]+$/, '')
    .trim()
  if (!name || /[:@?/|]/.test(name)) return false
  const words = name.split(' ')
  if (words.length === 1) return /^\p{L}[\p{L}'’.-]*$/u.test(name)
  return words.length <= 4 && words.every((word) => NAME_WORD_RE.test(word) || NAME_PARTICLE_RE.test(word))
}

/**
 * The sign-off ends the message: the LAST "Best," / "Thanks," … among the
 * last SIGN_OFF_WINDOW lines, with the name line under it (or on it: "Thanks,
 * Sarah"); the title, company, phone, address and links after it go, up to a
 * P.S. Only when a name follows and the rest reads as a signature
 * (signatureLength): a "Thanks!" opening a short email, followed by more of
 * it, cuts nothing. The sign-off and the name read as one line: "Best, Sarah".
 */
function cutAfterSignOff(lines: BodyLine[]): BodyLine[] {
  const said: number[] = []
  lines.forEach((line, i) => {
    if (speakable(line.text)) said.push(i)
  })
  const window = said.slice(-SIGN_OFF_WINDOW)
  for (let k = window.length - 1; k >= 0; k--) {
    const at = window[k]
    const sign = lines[at].kind === 'text' ? signOff(lines[at].text) : null
    if (!sign) continue
    let end = at
    if (!sign.named) {
      const nameAt = window[k + 1]
      if (nameAt === undefined || lines[nameAt].kind !== 'text' || !isNameLine(lines[nameAt].text)) return lines
      end = nameAt
    }
    const tail = lines.slice(end + 1)
    const length = signatureLength(tail)
    if (length < 0) return lines
    const kept = [...lines.slice(0, end + 1), ...tail.slice(length)]
    if (end !== at) kept[end] = { ...kept[end], para: lines[at].para }
    return kept
  }
  return lines
}

/** Consecutive lines of one paragraph, and what the footer rules read of them. */
interface Block {
  lines: BodyLine[]
  text: string
  linkText: string
  plainWords: number
}

function blocksOf(lines: BodyLine[]): Block[] {
  const groups: BodyLine[][] = []
  for (const line of lines) {
    const last = groups[groups.length - 1]
    if (last && last[last.length - 1].para === line.para) last.push(line)
    else groups.push([line])
  }
  return groups.map((group) => ({
    lines: group,
    text: group.map((line) => line.text).join(' '),
    linkText: group
      .map((line) => line.linkText ?? '')
      .filter(Boolean)
      .join(' '),
    plainWords: group.reduce((sum, line) => sum + (line.plainWords ?? spokenWords(line.text).length), 0),
  }))
}

/** Lines only a footer says. Unmistakable anywhere at the end of an email. */
const FOOTER_LINE_RES = [
  /\ball rights reserved\b/i,
  /©|\(c\)\s*(?:19|20)\d\d\b|\bcopyright\s+(?:19|20)\d\d\b/i,
  /\byou(?:'re|’re| are) (?:receiving|getting) (?:this|these)\b/i,
  /\byou (?:received|are getting|get) this (?:e-?mail|message|newsletter|notification) because\b/i,
  /\b(?:e-?mail|message|newsletter) (?:was|is) sent to \S+@\S+/i,
  /\bif you (?:no longer|don'?t|do not) (?:wish|want|would like) to receive\b/i,
  /\bto stop receiving (?:these|this|such|future|all)\b/i,
  /\bwhy (?:am i|did i|do i) (?:getting|get|receiving|receive) this\b/i,
  /\bour mailing address is\b/i,
  /\bchange how you receive these\b/i,
  /\badd us to your address book\b/i,
  /\bclick here to unsubscribe\b/i,
  /\breply to this e-?mail directly\b/i,
  /\bplease do not reply to this (?:e-?mail|message)\b/i,
  /\bif you(?:'re|’re| are) having trouble (?:with|clicking) the\b.{0,40}\bbutton\b/i,
  /\bcopy and paste (?:the|this) (?:url|link)\b.{0,20}\binto your (?:web )?browser\b/i,
  /^powered by\s+\S+(?:\s+\S+)?$/i,
  /\bconsider the environment before printing\b/i,
  /\bconfidentiality notice\b|\bprivileged (?:and|or|&) confidential\b/i,
  /\b(?:this|the) (?:e-?mail|message|communication|transmission)\b.{0,80}?\b(?:is|are|may be|contains?|may contain)\s+(?:strictly\s+)?(?:confidential|privileged|intended (?:only|solely|exclusively))\b/i,
  /\bintended (?:only|solely|exclusively) for the (?:use of the )?(?:individual|person|entity|addressee|recipient|named)/i,
  /\bif you (?:are not the intended recipient|have received this (?:e-?mail|message|communication|transmission) in error)\b/i,
  /\bnotify the sender (?:immediately|by (?:reply|return|e-?mail|telephone|phone))\b/i,
]
/** "View this email in your browser", "Having trouble viewing this email?" */
const VIEW_ONLINE_LINE_RE =
  /\bview (?:this|the) (?:e-?mail|message|newsletter) (?:in (?:your|a) (?:web )?browser|online|as a web ?page)\b|\btrouble (?:viewing|reading) (?:this|the) (?:e-?mail|message|newsletter)\b|\b(?:e-?mail|message) (?:is )?not displaying (?:correctly|properly)\b/i
/** "View in browser", "Web version": a footer's words only as a link. */
const VIEW_ONLINE_WORD_RE =
  /\bview (?:it |this (?:e-?mail|message|newsletter) )?(?:in (?:your |a )?(?:web )?browser|online)\b|\b(?:web|online|browser) version\b/i
/** Footer words that a message can say too ("please don't unsubscribe me"):
 *  they count only as a link, or beside a URL (isFooterLink). */
const FOOTER_WORD_RE =
  /\bunsubscrib|\bopt[- ]?out\b|\bpreferences\b|\bsubscription\b|\bprivacy\b|\bterms (?:of (?:service|use)|(?:and|&) conditions)\b|\bcookie|\bforward to a friend\b|\bmanage (?:your )?(?:account|notifications|e-?mails|settings)\b|\bnotification settings\b/i
const URL_TEST_RE = /\b(?:https?:\/\/|www\.)\S/i

/** `re` said the way a footer says it: in a link, with at most a few words
 *  around it ("Unsubscribe | Preferences", "You can unsubscribe or update
 *  your preferences"), or beside a URL in a short line. */
function isFooterLink(block: Block, re: RegExp): boolean {
  return (
    (re.test(block.linkText) && block.plainWords <= 4) ||
    (re.test(block.text) && URL_TEST_RE.test(block.text) && spokenWords(block.text).length <= 12)
  )
}

/** An unmistakable footer line (`strong`), a contact line a footer carries
 *  (`weak`: only links, a phone, an address, a company name), or neither. */
function footerKind(block: Block): 'strong' | 'weak' | null {
  const { text } = block
  if (
    FOOTER_LINE_RES.some((re) => re.test(text)) ||
    VIEW_ONLINE_LINE_RE.test(text) ||
    isFooterLink(block, FOOTER_WORD_RE) ||
    isFooterLink(block, VIEW_ONLINE_WORD_RE)
  ) {
    return 'strong'
  }
  const linkOnly = block.plainWords === 0 && speakable(block.linkText)
  return linkOnly || isContactOnly(text) || isAddressOnly(text) || COMPANY_LINE_RE.test(text) ? 'weak' : null
}

/**
 * A footer, walking back from the end: footer lines and the contact lines
 * among them, up to the first line of the message, where the walk stops.
 * Dropped only with at least one unmistakable footer line in it, and never
 * the whole message; a line ending in ":" ("Here's the doc:") keeps the link
 * or number it introduces.
 */
function dropFooter(lines: BodyLine[]): BodyLine[] {
  const blocks = blocksOf(lines)
  let footer = false
  let i = blocks.length - 1
  for (; i >= 0; i--) {
    if (!speakable(blocks[i].text)) continue
    const kind = footerKind(blocks[i])
    if (!kind) break
    if (kind === 'strong') footer = true
  }
  if (!footer || i < 0) return lines
  let from = i + 1
  if (/:$/.test(blocks[i].text)) {
    while (from < blocks.length && footerKind(blocks[from]) !== 'strong') from++
  }
  return blocks.slice(0, from).flatMap((block) => block.lines)
}

/** A newsletter's leading "View this email in your browser" (never the whole message). */
function dropLeadingViewOnline(lines: BodyLine[]): BodyLine[] {
  const blocks = blocksOf(lines)
  let i = 0
  while (
    i < blocks.length &&
    (!speakable(blocks[i].text) || VIEW_ONLINE_LINE_RE.test(blocks[i].text) || isFooterLink(blocks[i], VIEW_ONLINE_WORD_RE))
  ) {
    i++
  }
  return i < blocks.length ? blocks.slice(i).flatMap((block) => block.lines) : lines
}

/** "Tel", "M", "LinkedIn": labels a contact line puts before its links and numbers. */
const CONTACT_LABEL_RE =
  /\b(?:tel|telephone|phone|mobile|mob|cell|office|direct|main|fax|work|e-?mail|web(?:site)?|site|linkedin|twitter|x|facebook|instagram|youtube|tiktok|github|discord|threads|bluesky|mastodon|t|m|p|o|f|e|w|d)\b/gi

/** Only links, addresses, domains, phone numbers and their labels:
 *  "T: +1 555 010 0100 | sarah@acme.com | acme.com". */
function isContactOnly(text: string): boolean {
  if (!speakable(text)) return false
  const rest = text
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>]+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.[a-z]{2,6}\b(?:\/\S*)?/gi, ' ')
    .replace(/\+?\(?\d[\d\s().\-–]{5,}\d/g, ' ')
    .replace(/\b(?:ext|x)\.?\s*\d+\b/gi, ' ')
    .replace(CONTACT_LABEL_RE, ' ')
  return !speakable(rest)
}

/** A street address, a suite or floor, or a postal code (US, UK, Canada, a PO box). */
const STREET_RE =
  /\b\d{1,6}[a-z]?\s+(?:[\p{L}\d'’.-]+\s+){0,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|square|sq|parkway|pkwy|highway|hwy|terrace|suite|ste|floor|fl)\b|^(?:suite|ste|floor|fl|unit|apt|room|building|bldg)\.?\s*#?\s*\d+\w*$/iu
const POSTCODE_RE =
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\bP\.?\s?O\.?\s+Box\s+\d+/
/** Lowercase words an address has; any other gives a sentence away ("Meet me at 123 Main St"). */
const ADDRESS_WORDS = new Set([
  'and', 'of', 'the', 'at', 'by', 'in', 'on', 'floor', 'suite', 'ste', 'unit', 'building', 'level', 'fl',
  'apt', 'room', 'box', 'street', 'avenue', 'road', 'lane', 'drive', 'way', 'place', 'square', 'st', 'ave',
  'rd', 'blvd', 'ln', 'dr', 'ct', 'pl', 'sq', 'via', 'rue', 'de', 'la', 'le', 'du', 'des', 'van', 'der',
  'den', 'am', 'an', 'straße', 'strasse', 'str', 'platz', 'weg',
])

function isAddressOnly(text: string): boolean {
  if (!STREET_RE.test(text) && !POSTCODE_RE.test(text)) return false
  return !spokenWords(text).some(
    (word) => LOWERCASE_START_RE.test(word) && !ADDRESS_WORDS.has(word.toLowerCase().replace(/[^\p{L}]+$/u, '')),
  )
}

/** A company line: a short name ending in its legal form ("Acme, Inc.", "Bolt GmbH"). */
const COMPANY_LINE_RE =
  /^(?:[\p{L}\p{N}&'’.-]+,?\s+){0,4}(?:inc|llc|ltd|limited|gmbh|corp|corporation|plc|pty|co|ag|s\.a|b\.v)\.?$/iu
