/**
 * lintDraft: the deterministic floor under every draft (plan P2,
 * content-skill-set.md §2 row 3). No model call, pure, and the same answer for
 * the same input.
 *
 *   - AI tells, plain-English swaps and machinery phrases (./rules.ts) match as
 *     ESCAPED LITERALS: each phrase is regex-escaped and wrapped in one-char
 *     word-boundary lookarounds, so no pattern can backtrack (no ReDoS),
 *     whatever the phrase lists hold;
 *   - the "it's not X, it's Y" frame is found with indexOf over a bounded
 *     window, no regex at all;
 *   - em dashes are counted against the surface's (or the house) limit;
 *   - a surface (./surfaces.ts) adds a character limit (counted the
 *     surface's way: surfaceLength), a hashtag count and link rules; a post
 *     surface also matches the engagement-bait phrases (POST_BAIT_PHRASES)
 *     and, where it sets one, checks the first line fits before "see more".
 *
 * Bounded: only the first MAX_LINT_CHARS characters are scanned (the length
 * limit still sees the whole text), each phrase reports at most once with a
 * count, and the result holds at most MAX_VIOLATIONS entries.
 *
 * Fails OPEN: any internal error returns `{ ok: true, violations: [] }` with
 * `failed: true`. Lint informs a draft; it never blocks one.
 *
 * Severities: 'medium' and 'high' fail a draft (ok: false); 'low' only counts
 * toward its score. A `hard` violation (the em-dash limit, a link written the
 * wrong way, the writer talking about itself, a length limit) is the only
 * kind that forces a rewrite on lint alone (quality-pass.ts needsRevision).
 *
 * `allow`: text the draft answers (the email thread). A phrase found there is
 * the sender's own wording, so the draft echoing it is never flagged.
 */
import {
  AI_TELL_PHRASES,
  MACHINERY_PHRASES,
  PLAIN_ENGLISH_SWAPS,
  POST_BAIT_PHRASES,
  houseEmDashLimit,
  type PhraseRule,
  type WritingRuleId,
  type WritingSeverity,
} from './rules'
import { writingSurface, type WritingSurface } from './surfaces'

/** Characters scanned for phrases, dashes and links. */
export const MAX_LINT_CHARS = 20_000
/** Most violations one result carries (highest severity first). */
export const MAX_VIOLATIONS = 20
/** Longest quote a violation carries. */
const MAX_QUOTE = 120
/** Matches counted per phrase before the scan moves on. */
const MAX_MATCHES_PER_PHRASE = 50

export interface LintViolation {
  rule: WritingRuleId
  severity: WritingSeverity
  /** The words in the draft (after folding curly quotes and fullwidth letters). */
  quote: string
  fix: string
  /** How many times it appears, when more than once. */
  count?: number
  /** Forces the one rewrite on lint alone (see the module doc). */
  hard?: true
}

export interface LintResult {
  /** No high or medium violation. Low ones (plain-English swaps) don't fail a draft. */
  ok: boolean
  violations: LintViolation[]
  /** The text was longer than MAX_LINT_CHARS; only its start was scanned. */
  truncated?: true
  /** Lint threw and failed open. */
  failed?: true
}

export interface LintOptions {
  /** A registered surface id, or a surface itself. Unknown or absent: house rules only. */
  surface?: string | WritingSurface
  /** Text whose phrases are never flagged (the thread a reply answers). Only its first MAX_ALLOW_CHARS are read. */
  allow?: string
}

/** Characters of `allow` read. */
export const MAX_ALLOW_CHARS = 60_000

const SEVERITY_ORDER: Record<WritingSeverity, number> = { high: 0, medium: 1, low: 2 }

/** Regex syntax characters: the only escapes valid in a `u`-flag pattern. */
function escapeLiteral(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
}

interface CompiledPhrase {
  rule: WritingRuleId
  phrase: PhraseRule
  re: RegExp
}

function compile(rules: readonly PhraseRule[], rule: WritingRuleId): CompiledPhrase[] {
  return rules.map((phrase) => ({
    rule,
    phrase,
    // A literal between "not a letter, digit or _" lookarounds: linear time.
    re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeLiteral(foldForMatch(phrase.phrase))}(?![\\p{L}\\p{N}_])`, 'giu'),
  }))
}

/**
 * Hard rules first, then the more severe, then the longest, so an overlap is
 * reported once under its strongest reading: "as an AI language model" is the
 * hard "as an ai", and the low "ai language model" inside it is skipped.
 */
function strongestFirst(list: CompiledPhrase[]): CompiledPhrase[] {
  return list.sort((a, b) =>
    Number(Boolean(b.phrase.hard)) - Number(Boolean(a.phrase.hard)) ||
    SEVERITY_ORDER[a.phrase.severity] - SEVERITY_ORDER[b.phrase.severity] ||
    b.phrase.phrase.length - a.phrase.phrase.length)
}

const HOUSE_PHRASES: readonly CompiledPhrase[] = [
  ...compile(AI_TELL_PHRASES, 'ai_tell'),
  ...compile(MACHINERY_PHRASES, 'machinery'),
  ...compile(PLAIN_ENGLISH_SWAPS, 'plain_english'),
]

const PHRASES: readonly CompiledPhrase[] = strongestFirst([...HOUSE_PHRASES])

/** A post surface (kind 'post') also matches the engagement-bait phrases. */
const POST_PHRASES: readonly CompiledPhrase[] = strongestFirst([...HOUSE_PHRASES, ...compile(POST_BAIT_PHRASES, 'bait')])

/**
 * Fold text so a phrase can't hide: NFKC (fullwidth letters → ASCII), curly
 * quotes → straight, Unicode hyphens → '-', invisible characters removed,
 * whitespace runs → one space. Case is left alone (the matchers ignore it), so
 * quotes keep the draft's own capitals.
 */
export function foldForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‘’‛ʼ′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐‑]/g, '-')
    .replace(/\s+/g, ' ')
}

/** Code points in `text` (a surrogate pair is one character). */
function charCount(text: string): number {
  let lows = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xdc00 && code <= 0xdfff) lows++
  }
  return text.length - lows
}

/** Graphemes in `text` (an emoji with its modifiers is one), or code points where Intl.Segmenter is missing. */
function graphemeCount(text: string): number {
  const Segmenter = (Intl as { Segmenter?: new (locale?: string, opts?: { granularity: 'grapheme' }) => { segment(t: string): Iterable<unknown> } }).Segmenter
  if (!Segmenter) return charCount(text)
  let n = 0
  for (const _ of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++
  return n
}

/**
 * How long `text` is on a surface, the way the surface counts it: code points
 * (or graphemes, Bluesky), with each URL counted as the surface's `urlChars`
 * (X: 23 for t.co; Bluesky: 0) when it sets one. The post card's counter and
 * lint's length rule both read this. Pure.
 */
export function surfaceLength(text: string, surface?: string | WritingSurface | null): number {
  const s = typeof surface === 'string' ? writingSurface(surface) : surface ?? undefined
  const count = s?.countBy === 'graphemes' ? graphemeCount : charCount
  if (s?.urlChars === undefined) return count(text)
  let urls = 0
  const bare = text.replace(URL_RE, () => {
    urls++
    return ''
  })
  return count(bare) + urls * s.urlChars
}

function clip(text: string, max = MAX_QUOTE): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/** Lint one draft. See the module doc; never throws. */
export function lintDraft(text: unknown, options: LintOptions = {}): LintResult {
  try {
    return lintInner(typeof text === 'string' ? text : '', options)
  } catch {
    return { ok: true, violations: [], failed: true }
  }
}

function lintInner(text: string, options: LintOptions): LintResult {
  const surface = typeof options.surface === 'string' ? writingSurface(options.surface) : options.surface
  const truncated = text.length > MAX_LINT_CHARS
  const scanned = foldForMatch(truncated ? text.slice(0, MAX_LINT_CHARS) : text)
  const violations: LintViolation[] = []

  const allow = options.allow ? foldForMatch(options.allow.slice(0, MAX_ALLOW_CHARS)) : ''
  phraseViolations(scanned, allow, surface?.kind === 'post' ? POST_PHRASES : PHRASES, violations)
  notXItsY(scanned, violations)
  emDashes(scanned, charCount(text), surface, violations)
  if (surface) surfaceViolations(text, scanned, surface, violations)

  violations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const kept = violations.slice(0, MAX_VIOLATIONS)
  return {
    ok: !kept.some((v) => v.severity !== 'low'),
    violations: kept,
    ...(truncated ? { truncated: true as const } : {}),
  }
}

function phraseViolations(scanned: string, allow: string, phrases: readonly CompiledPhrase[], out: LintViolation[]): void {
  const covered: Array<[number, number]> = []
  const overlaps = (start: number, end: number) => covered.some(([s, e]) => start < e && end > s)
  for (const compiled of phrases) {
    const re = compiled.re
    if (allow) {
      // The sender wrote it: the draft may say it back.
      re.lastIndex = 0
      if (re.test(allow)) continue
    }
    re.lastIndex = 0
    let first: string | undefined
    let count = 0
    let seen = 0
    let match: RegExpExecArray | null
    while (seen < MAX_MATCHES_PER_PHRASE && (match = re.exec(scanned)) !== null) {
      seen++
      const start = match.index
      const end = start + match[0].length
      if (overlaps(start, end)) continue
      covered.push([start, end])
      first ??= match[0]
      count++
    }
    if (first !== undefined) {
      out.push({
        rule: compiled.rule,
        severity: compiled.phrase.severity,
        quote: clip(first),
        fix: compiled.phrase.fix,
        ...(count > 1 ? { count } : {}),
        ...(compiled.phrase.hard ? { hard: true as const } : {}),
      })
    }
  }
}

/**
 * No "that's not …" opener: "That's not a problem, it's the least we can do"
 * is ordinary politeness, not the frame.
 */
const NOT_OPENERS = [
  "it's not ", 'it is not ', "it isn't ", "this isn't ", 'this is not ',
  "isn't just ", 'is not just ', 'not just ', 'not only ',
]
const NOT_TURNS = [
  ", it's ", ', it is ', "; it's ", "— it's ", "– it's ", " - it's ", ', this is ', ', that is ', ", that's ",
  '— this is ', ", they're ", "— they're ", ', but rather ', ' but rather ',
  // Across a full stop only "It's about": "It's not ready. It's the least…" is plain prose.
  ". it's about ", '. it is about ',
]
/** How far past an opener the turn may come. */
const NOT_WINDOW = 140
/** Most openers looked at in one draft. */
const MAX_OPENER_CHECKS = 2_000

/** The "it's not X, it's Y" frame, by indexOf over a bounded window. */
function notXItsY(scanned: string, out: LintViolation[]): void {
  const lower = scanned.toLowerCase()
  let count = 0
  let quote: string | undefined
  let from = 0
  // Each opener's next position, searched again only once `from` passes it,
  // so each opener scans the text once in all: O(text × openers). Absent
  // openers stay -1 and are never searched again.
  const next = NOT_OPENERS.map((opener) => lower.indexOf(opener))
  // Every turn of the loop moves `from` forward, so it ends; the cap bounds
  // the window checks on a text made of openers.
  for (let checks = 0; count < MAX_MATCHES_PER_PHRASE && checks < MAX_OPENER_CHECKS; checks++) {
    let at = -1
    let opener = ''
    for (let k = 0; k < NOT_OPENERS.length; k++) {
      if (next[k] !== -1 && next[k] < from) next[k] = lower.indexOf(NOT_OPENERS[k], from)
      if (next[k] !== -1 && (at === -1 || next[k] < at)) {
        at = next[k]
        opener = NOT_OPENERS[k]
      }
    }
    if (at === -1) break
    // Whole word on the left ("knot just" is not "not just").
    if (at > 0 && /[\p{L}\p{N}_']/u.test(lower[at - 1])) {
      from = at + 1
      continue
    }
    const windowStart = at + opener.length
    const window = lower.slice(windowStart, windowStart + NOT_WINDOW)
    let turnEnd = -1
    for (const turn of NOT_TURNS) {
      const i = window.indexOf(turn)
      if (i !== -1 && (turnEnd === -1 || i + turn.length < turnEnd)) turnEnd = i + turn.length
    }
    if (turnEnd === -1) {
      from = at + 1
      continue
    }
    const end = windowStart + turnEnd
    if (quote === undefined) {
      // From the lower-cased copy: its offsets are the ones found above
      // (lower-casing can change a string's length).
      const tail = lower.slice(end, end + 40)
      const stop = tail.search(/[.!?]/)
      quote = clip(lower.slice(at, end) + (stop === -1 ? tail : tail.slice(0, stop)))
    }
    count++
    from = end
  }
  if (quote !== undefined) {
    out.push({
      rule: 'not_x_its_y',
      severity: 'medium',
      quote,
      fix: 'say what it is, without the contrast frame',
      ...(count > 1 ? { count } : {}),
    })
  }
}

/** Em dashes, plus the spaced en dash and " -- " standing in for one. */
function emDashes(scanned: string, chars: number, surface: WritingSurface | undefined, out: LintViolation[]): void {
  let count = 0
  let firstAt = -1
  for (const dash of ['—', ' – ', ' -- ']) {
    let i = scanned.indexOf(dash)
    while (i !== -1) {
      count++
      if (firstAt === -1 || i < firstAt) firstAt = i
      i = scanned.indexOf(dash, i + dash.length)
    }
  }
  const limit = surface?.maxEmDashes ?? houseEmDashLimit(chars)
  if (count <= limit) return
  out.push({
    rule: 'em_dash',
    severity: 'medium',
    hard: true,
    quote: clip(scanned.slice(Math.max(0, firstAt - 30), firstAt + 30)),
    fix: `use a comma, a colon or a full stop; at most ${limit} em dash${limit === 1 ? '' : 'es'} here`,
    count,
  })
}

const URL_RE = /https?:\/\/[^\s<>"'\])]+/giu
const MARKDOWN_LINK_RE = /\[([^\]\n]{1,200})\]\(\s*https?:\/\/[^\s)]{1,2000}\s*\)/giu
const HASHTAG_RE = /(?<![\p{L}\p{N}_&#/])#[\p{L}_][\p{L}\p{N}_]*/gu
const VAGUE_LINK_TEXT = new Set(['here', 'click here', 'this link', 'link', 'this'])

function surfaceViolations(original: string, scanned: string, surface: WritingSurface, out: LintViolation[]): void {
  const chars = surfaceLength(original, surface)
  if (surface.maxChars !== undefined && chars > surface.maxChars) {
    out.push({
      rule: 'length',
      severity: 'high',
      hard: true,
      quote: `${chars} characters`,
      fix: `cut it to at most ${surface.maxChars} characters`,
    })
  }

  // The hook: the first line has to fit before "see more" (LinkedIn). A note, never a rewrite.
  if (surface.hookChars !== undefined) {
    const firstLine = original.split('\n').find((line) => line.trim()) ?? ''
    const hook = charCount(firstLine.trim())
    if (hook > surface.hookChars) {
      out.push({ rule: 'hook', severity: 'low', quote: clip(firstLine), fix: `land the hook in the first ${surface.hookChars} characters: a short first line, then a blank line` })
    }
  }

  if (surface.maxHashtags !== undefined) {
    const tags = scanned.match(HASHTAG_RE) ?? []
    if (tags.length > surface.maxHashtags) {
      out.push({
        rule: 'hashtags',
        // Where hashtags are banned outright the surface is plain text, and a
        // '#' is ordinary ("Order #A123", "#general"): it only counts.
        severity: surface.maxHashtags === 0 ? 'low' : 'medium',
        quote: clip(tags.slice(0, 5).join(' ')),
        fix: surface.maxHashtags === 0 ? 'no hashtags here' : `at most ${surface.maxHashtags} hashtag${surface.maxHashtags === 1 ? '' : 's'}`,
        count: tags.length,
      })
    }
  }

  // HTML anchors are never right, on any surface.
  const lower = scanned.toLowerCase()
  const anchor = lower.indexOf('<a ')
  if (anchor !== -1 && lower.slice(anchor, anchor + 500).includes('href')) {
    out.push({ rule: 'link_format', severity: 'medium', hard: true, quote: clip(scanned.slice(anchor, anchor + 60)), fix: 'write the link as [name](url) or the bare URL, never HTML' })
  }

  const markdownLinks = [...scanned.matchAll(MARKDOWN_LINK_RE)]
  if (surface.linkStyle === 'bare' && markdownLinks.length > 0) {
    out.push({
      rule: 'link_format',
      severity: 'medium',
      hard: true,
      quote: clip(markdownLinks[0][0]),
      fix: 'write the bare URL: markdown shows as raw brackets here',
      ...(markdownLinks.length > 1 ? { count: markdownLinks.length } : {}),
    })
  } else {
    const vague = markdownLinks.find((m) => VAGUE_LINK_TEXT.has(m[1].trim().toLowerCase()))
    if (vague) out.push({ rule: 'link_format', severity: 'low', quote: clip(vague[0]), fix: 'name what the link is, not "here"' })
  }

  const urls = [...scanned.matchAll(URL_RE)]
  if (urls.length === 0) return
  if (surface.linkPlacement === 'none') {
    out.push({ rule: 'link_placement', severity: 'medium', quote: clip(urls[0][0]), fix: 'no links on this surface', ...(urls.length > 1 ? { count: urls.length } : {}) })
    return
  }
  if (surface.maxLinks !== undefined && urls.length > surface.maxLinks) {
    out.push({ rule: 'link_placement', severity: 'medium', quote: clip(urls[surface.maxLinks][0]), fix: `at most ${surface.maxLinks} link${surface.maxLinks === 1 ? '' : 's'}`, count: urls.length })
  }
  if (surface.linkPlacement === 'end') {
    // The folded text has no newlines; find the last line in the original.
    const lines = (original.length > MAX_LINT_CHARS ? original.slice(0, MAX_LINT_CHARS) : original).split('\n')
    let lastLine = ''
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        lastLine = foldForMatch(lines[i])
        break
      }
    }
    const early = urls.find((m) => !lastLine.includes(m[0]))
    if (early) out.push({ rule: 'link_placement', severity: 'medium', quote: clip(early[0]), fix: 'move the link to the last line' })
  }
}
