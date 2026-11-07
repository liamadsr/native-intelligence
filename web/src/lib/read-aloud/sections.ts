/**
 * Read-aloud sections: the rules behind the hover "play this section" button in
 * rendered markdown (components/ui/markdown-sections.tsx) and in the note
 * editor (components/editor/read-aloud-sections-extension.ts). They live here,
 * once, so the two surfaces can't drift; each surface only adapts its own tree
 * (the DOM react-markdown rendered, the hast it rendered from, a ProseMirror
 * doc) to them. Playback is ./section-player's.
 *
 * Anchors, the only places a button can appear, are TOP-LEVEL blocks (direct
 * children of the markdown root / the ProseMirror doc):
 *   - headings h1–h4, ranked by level;
 *   - "lead-in" paragraphs: nothing but bold text, optionally followed by a
 *     bare ":", 1–8 words (models write `**Next steps**` as a heading). They
 *     rank below h4.
 * Never h5/h6, list items, table rows, or anything inside a list or a quote.
 *
 * A section is its anchor plus the top-level blocks after it, up to the next
 * anchor of the same or a higher rank (a lower-or-equal number): an h2 takes
 * its h3s along, a lead-in ends at the next lead-in or any heading.
 *
 * What is read: the anchor as a sentence, then the section's prose in order —
 * paragraphs, list items, quotes, and sub-headings and lead-ins (each of those
 * a sentence of its own).
 * Skipped: code blocks, tables, images, rules, embeds (link previews,
 * proposals), checkboxes and inputs, and anything marked
 * `data-read-aloud-skip` or aria-hidden. URLs read as their host and emoji
 * are dropped, as in the chat's read-aloud (./speech-text).
 *
 * `sectionHasButton` is the content half of when a button shows: the body
 * (without the anchor) has at least MIN_SECTION_WORDS spoken words, since a
 * shorter section is faster to read than to play; and where the surface
 * already reads its whole content (a chat reply's Read aloud), the section is
 * not that whole content. The surfaces add the rest: read-aloud supported, the
 * content done streaming, the pointer on the anchor's row.
 *
 * Pure: no React, and nothing from ProseMirror at runtime (types only), so the
 * dashboard shell, which renders chat markdown, never loads the editor.
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { plainTextToSpeech, splitSentences, withTerminalPunctuation } from './speech-text'

/** A section whose body says fewer words than this gets no button. */
export const MIN_SECTION_WORDS = 20
/** The longest bold paragraph that still reads as a lead-in. */
export const LEAD_IN_MAX_WORDS = 8
/** Headings rank by level, h1 (1) to h4 (4); h5/h6 are no anchors. */
export const MAX_HEADING_RANK = 4
/** A lead-in paragraph ranks just below h4. */
export const LEAD_IN_RANK = 5

export type SectionLineKind = 'heading' | 'text' | 'item'

/** One line of what a section says. `text` is already speakable (never '').
 *  Headings and list items read as sentences of their own. */
export interface SectionLine {
  text: string
  kind: SectionLineKind
}

/** What a section says, whichever tree it came from. */
export interface SectionSpeech {
  /** The anchor's line, then the body's. */
  lines: SectionLine[]
  /** The body alone (what the word threshold counts). */
  bodyLines: SectionLine[]
  /** Nothing speakable before the anchor, and the section runs to the end:
   *  the section is the whole content. */
  coversAll: boolean
}

// ── The rules ──────────────────────────────────────────────────────────────

/** Spoken words: whitespace-separated tokens with a letter or a digit. */
export function countWords(text: string): number {
  let words = 0
  for (const token of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(token)) words++
  return words
}

/** A stretch of a paragraph's text, bold or not. */
export interface InlineRun {
  text: string
  bold: boolean
}

/**
 * The lead-in shape, on a paragraph's text runs in order: all of it bold,
 * except whitespace and one bare ":" at the very end, and 1–LEAD_IN_MAX_WORDS
 * words. "**Next steps**", "**Next steps:**" and "**Next steps**:" are
 * lead-ins; "**Note:** call Sam" and a bold sentence of twelve words are not.
 */
export function isLeadIn(runs: readonly InlineRun[]): boolean {
  let text = ''
  let bold = false
  let colon = false
  for (const run of runs) {
    const trimmed = run.text.trim()
    if (!trimmed) {
      text += run.text
      continue
    }
    if (colon) return false
    if (run.bold) {
      bold = true
      text += run.text
    } else if (trimmed === ':' && bold) {
      colon = true
    } else {
      return false
    }
  }
  const words = countWords(text)
  return bold && words >= 1 && words <= LEAD_IN_MAX_WORDS
}

/** Does a section anchored at `rank` end at a block of `nextRank` (null: no anchor)? */
function endsSection(rank: number, nextRank: number | null): boolean {
  return nextRank !== null && nextRank <= rank
}

/**
 * Whether a section earns a button (see the header): enough to say, and not
 * the whole content where the surface already reads that (`skipWhole`).
 */
export function sectionHasButton(section: SectionSpeech, { skipWhole = false }: { skipWhole?: boolean } = {}): boolean {
  if (skipWhole && section.coversAll) return false
  let words = 0
  for (const line of section.bodyLines) words += countWords(line.text)
  return words >= MIN_SECTION_WORDS
}

/** A section's lines → the sentences to speak, in order. Headings and list
 *  items end as sentences; long sentences are cut (./speech-text). */
export function linesToSentences(lines: readonly SectionLine[]): string[] {
  return lines.flatMap((line) => {
    const text = plainTextToSpeech(line.text)
    if (!text) return []
    return splitSentences(line.kind === 'text' ? text : withTerminalPunctuation(text))
  })
}

function pushLine(lines: SectionLine[], kind: SectionLineKind, raw: string): boolean {
  const text = plainTextToSpeech(raw)
  if (text) lines.push({ text, kind })
  return !!text
}

// ── Rendered markdown: the DOM react-markdown produced ─────────────────────

/** Never read, and never searched for text. */
const DOM_SKIP = [
  'pre', 'table', 'hr', 'img', 'svg', 'figure', 'video', 'audio', 'iframe', 'canvas',
  'button', 'input', 'select', 'textarea', 'script', 'style',
  '[data-read-aloud-skip]', '[aria-hidden="true"]',
  // GFM footnotes: the reference numbers and the notes section, and the
  // visually hidden labels that come with them.
  '[data-footnote-ref]', '[data-footnotes]', '.sr-only',
].join(', ')

/** Elements that hold blocks, not inline text. */
const DOM_BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'DIV', 'PRE',
  'TABLE', 'HR', 'FIGURE', 'SECTION', 'ARTICLE', 'ASIDE', 'DETAILS', 'SUMMARY', 'DL', 'DT',
  'DD', 'HEADER', 'FOOTER', 'NAV', 'MAIN', 'FORM', 'FIELDSET', 'ADDRESS',
])

const HEADING_TAG_RE = /^H([1-6])$/
const TEXT_NODE = 3
const ELEMENT_NODE = 1

/** An element's text as runs: skipped elements left out, <br> as a space,
 *  bold = inside <strong> / <b>. */
function domRuns(el: Element): InlineRun[] {
  const runs: InlineRun[] = []
  const walk = (parent: Node, bold: boolean) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === TEXT_NODE) {
        runs.push({ text: child.nodeValue ?? '', bold })
      } else if (child.nodeType === ELEMENT_NODE) {
        const element = child as Element
        if (element.tagName === 'BR') runs.push({ text: ' ', bold })
        else if (!element.matches(DOM_SKIP)) walk(element, bold || element.tagName === 'STRONG' || element.tagName === 'B')
      }
    }
  }
  walk(el, false)
  return runs
}

function domInlineText(el: Element): string {
  return domRuns(el)
    .map((run) => run.text)
    .join('')
}

/** A block's anchor rank (1–4 for h1–h4, LEAD_IN_RANK for a lead-in), or null. */
export function domAnchorRank(el: Element): number | null {
  const heading = HEADING_TAG_RE.exec(el.tagName)
  if (heading) {
    const level = Number(heading[1])
    return level <= MAX_HEADING_RANK ? level : null
  }
  return el.tagName === 'P' && isLeadIn(domRuns(el)) ? LEAD_IN_RANK : null
}

/** What one rendered block says, in reading order. */
export function domBlockLines(el: Element): SectionLine[] {
  const lines: SectionLine[] = []
  domLines(el, lines)
  return lines
}

function domLines(el: Element, lines: SectionLine[]) {
  if (el.matches(DOM_SKIP)) return
  const tag = el.tagName
  if (HEADING_TAG_RE.test(tag)) {
    pushLine(lines, 'heading', domInlineText(el))
  } else if (tag === 'P' && domAnchorRank(el) === LEAD_IN_RANK) {
    // A lead-in inside a section reads like the heading it stands for.
    pushLine(lines, 'heading', domInlineText(el))
  } else if (tag === 'UL' || tag === 'OL') {
    for (const item of el.children) domLines(item, lines)
  } else if (tag === 'LI') {
    domContainerLines(el, lines, 'item')
  } else if (tag === 'P' || ![...el.children].some((child) => DOM_BLOCK_TAGS.has(child.tagName))) {
    pushLine(lines, 'text', domInlineText(el))
  } else {
    // A quote, or a div holding blocks.
    domContainerLines(el, lines, 'text')
  }
}

/**
 * A container's children in order: each run of inline content is a line, each
 * block child reads as itself. In a list item (`first` = 'item') the item's own
 * text — its leading inline content, or its first paragraph — is the item
 * line; later paragraphs are text, nested lists their own items.
 */
function domContainerLines(el: Element, lines: SectionLine[], first: SectionLineKind) {
  let kind = first
  let inline = ''
  const flush = () => {
    if (pushLine(lines, kind, inline)) kind = 'text'
    inline = ''
  }
  for (let child = el.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === TEXT_NODE) {
      inline += child.nodeValue ?? ''
      continue
    }
    if (child.nodeType !== ELEMENT_NODE) continue
    const element = child as Element
    if (element.matches(DOM_SKIP)) continue
    if (element.tagName === 'BR') {
      inline += ' '
    } else if (!DOM_BLOCK_TAGS.has(element.tagName)) {
      inline += domInlineText(element)
    } else {
      flush()
      const before = lines.length
      if (kind === 'item' && element.tagName === 'P') pushLine(lines, 'item', domInlineText(element))
      else domLines(element, lines)
      if (lines.length > before) kind = 'text'
    }
  }
  flush()
}

/** A section in rendered markdown. */
export interface DomSection extends SectionSpeech {
  /** The anchor, then the section's other top-level blocks. */
  blocks: Element[]
}

/** The section `anchor` starts, or null when it is not a top-level anchor
 *  (a direct child of `root`). */
export function collectDomSection(anchor: Element, root: Element): DomSection | null {
  if (anchor.parentElement !== root) return null
  const rank = domAnchorRank(anchor)
  if (rank === null) return null

  const blocks: Element[] = [anchor]
  const bodyLines: SectionLine[] = []
  let next = anchor.nextElementSibling
  for (; next; next = next.nextElementSibling) {
    if (endsSection(rank, domAnchorRank(next))) break
    blocks.push(next)
    domLines(next, bodyLines)
  }

  let speakableBefore = false
  for (let prev = anchor.previousElementSibling; prev && !speakableBefore; prev = prev.previousElementSibling) {
    speakableBefore = domBlockLines(prev).length > 0
  }

  const lines: SectionLine[] = []
  pushLine(lines, 'heading', domInlineText(anchor))
  lines.push(...bodyLines)
  return { blocks, lines, bodyLines, coversAll: !speakableBefore && next === null }
}

// ── react-markdown's hast (the `node` a component override receives) ──────

/** The slice of a hast node the lead-in check reads. */
export interface HastNodeLike {
  type: string
  tagName?: string
  value?: string
  children?: readonly HastNodeLike[]
}

/** Inline elements that render no text for `domRuns` to find. */
const HAST_SKIP = new Set(['img', 'input', 'button', 'svg', 'video', 'audio', 'iframe', 'canvas', 'script', 'style', 'select', 'textarea'])

/**
 * Whether a hast `<p>` has the lead-in shape. Markdown uses it to decide, while
 * rendering, which paragraphs can carry a button at all; the DOM check
 * (`domAnchorRank`) is the one that decides at hover time.
 */
export function hastIsLeadIn(node: HastNodeLike | null | undefined): boolean {
  if (!node || node.type !== 'element' || node.tagName !== 'p') return false
  const runs: InlineRun[] = []
  const walk = (parent: HastNodeLike, bold: boolean) => {
    for (const child of parent.children ?? []) {
      if (child.type === 'text') {
        runs.push({ text: child.value ?? '', bold })
      } else if (child.type === 'element') {
        const tag = child.tagName ?? ''
        if (tag === 'br') runs.push({ text: ' ', bold })
        else if (!HAST_SKIP.has(tag)) walk(child, bold || tag === 'strong' || tag === 'b')
      }
    }
  }
  walk(node, false)
  return isLeadIn(runs)
}

// ── The note editor: a ProseMirror doc ─────────────────────────────────────

/** Never read. Atoms and leaves (link previews, proposals, images, rules) are
 *  skipped by their shape. */
const PM_SKIP = new Set(['codeBlock', 'table'])

function pmRuns(node: PMNode): InlineRun[] {
  const runs: InlineRun[] = []
  node.forEach((child) => {
    if (child.isText) runs.push({ text: child.text ?? '', bold: child.marks.some((mark) => mark.type.name === 'bold') })
    else if (child.type.name === 'hardBreak') runs.push({ text: ' ', bold: false })
  })
  return runs
}

/** A literal markdown image, then link, in an editor's text (see pmText). */
const LITERAL_MD_IMAGE_RE = /!\[[^\]]*\]\((?:[^()\s]|\([^)]*\))*\)/g
const LITERAL_MD_LINK_RE = /\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)/g

/**
 * A textblock's text; hard breaks and inline atoms as spaces, so words never
 * glue. The editor's markdown import parses no links
 * (views/markdown-conversion.ts), so a document can hold `[text](url)` as
 * literal text: it reads as its text, as rendered markdown reads a link, and a
 * literal image not at all.
 */
function pmText(node: PMNode): string {
  return node
    .textBetween(0, node.content.size, ' ', ' ')
    .replace(LITERAL_MD_IMAGE_RE, '')
    .replace(LITERAL_MD_LINK_RE, '$1')
}

/** A top-level node's anchor rank (1–4 for h1–h4, LEAD_IN_RANK for a lead-in), or null. */
export function pmAnchorRank(node: PMNode): number | null {
  if (node.type.name === 'heading') {
    const level = Number(node.attrs.level)
    return level >= 1 && level <= MAX_HEADING_RANK ? level : null
  }
  return node.type.name === 'paragraph' && isLeadIn(pmRuns(node)) ? LEAD_IN_RANK : null
}

/** What one editor block says, in reading order. */
export function pmBlockLines(node: PMNode): SectionLine[] {
  const lines: SectionLine[] = []
  pmLines(node, lines)
  return lines
}

function pmLines(node: PMNode, lines: SectionLine[]) {
  const name = node.type.name
  if (PM_SKIP.has(name) || node.isAtom || node.isLeaf) return
  if (name === 'heading' || pmAnchorRank(node) === LEAD_IN_RANK) {
    // A lead-in inside a section reads like the heading it stands for.
    pushLine(lines, 'heading', pmText(node))
  } else if (node.isTextblock) {
    pushLine(lines, 'text', pmText(node))
  } else if (name === 'listItem' || name === 'taskItem') {
    // The item's first paragraph is the item line; the rest reads as itself.
    let first = true
    node.forEach((child) => {
      if (first && child.type.name === 'paragraph') pushLine(lines, 'item', pmText(child))
      else pmLines(child, lines)
      first = false
    })
  } else {
    // Lists, quotes and any other container.
    node.forEach((child) => pmLines(child, lines))
  }
}

/** A section in the editor. Positions are the doc's. */
export interface PmSection extends SectionSpeech {
  /** The anchor's start. */
  from: number
  /** The end of the section's last block. */
  to: number
  /** Each top-level block of the section, the anchor first. */
  nodeRanges: Array<{ from: number; to: number }>
}

/** The section the top-level node at `anchorIndex` starts, or null when that
 *  node is no anchor. */
export function collectPmSection(doc: PMNode, anchorIndex: number): PmSection | null {
  if (anchorIndex < 0 || anchorIndex >= doc.childCount) return null
  const anchor = doc.child(anchorIndex)
  const rank = pmAnchorRank(anchor)
  if (rank === null) return null

  let from = 0
  let speakableBefore = false
  for (let i = 0; i < anchorIndex; i++) {
    const node = doc.child(i)
    if (!speakableBefore) speakableBefore = pmBlockLines(node).length > 0
    from += node.nodeSize
  }

  const nodeRanges = [{ from, to: from + anchor.nodeSize }]
  const bodyLines: SectionLine[] = []
  let to = from + anchor.nodeSize
  let index = anchorIndex + 1
  for (; index < doc.childCount; index++) {
    const node = doc.child(index)
    if (endsSection(rank, pmAnchorRank(node))) break
    pmLines(node, bodyLines)
    nodeRanges.push({ from: to, to: to + node.nodeSize })
    to += node.nodeSize
  }

  const lines: SectionLine[] = []
  pushLine(lines, 'heading', pmText(anchor))
  lines.push(...bodyLines)
  return { from, to, nodeRanges, lines, bodyLines, coversAll: !speakableBefore && index === doc.childCount }
}
