/**
 * A markdown document's structure, for reading and editing part of it
 * (documents phase 1, items 3 and 4): its outline (ATX headings `#`..`######`,
 * never inside a fenced code block), a section by heading, a line range, the
 * passages around a phrase, and edits to a line range or a section.
 *
 * Lines are 1-based everywhere, as get_document shows them. A section is its
 * heading line and everything up to the next heading of the same or a higher
 * level (its subsections included). Pure: no I/O.
 */

export interface OutlineEntry {
  /** The heading's text, without the `#`s. */
  heading: string
  level: number
  /** The heading's line. */
  line: number
  /** The section's last line (subsections included). */
  endLine: number
  /** The last line of the section's own text, before its first subsection. */
  ownEndLine: number
  /** Characters in the section, heading and subsections included. */
  chars: number
  /** The headings above it, outermost first, then its own. */
  path: string[]
}

/** The body as lines (CRLF read as LF). */
export function splitLines(content: string | null | undefined): string[] {
  return (content ?? '').replace(/\r\n?/g, '\n').split('\n')
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/
const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

/** The headings, in order, with where each section ends and its size. */
export function parseOutline(content: string | null | undefined): OutlineEntry[] {
  const lines = splitLines(content)
  const found: Array<{ heading: string; level: number; line: number }> = []
  // The open fence (CommonMark): only a run of the same character, at least
  // as long, with nothing after it, closes it.
  let fence: { char: string; length: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]
    const f = FENCE.exec(text)
    if (f) {
      const run = f[1]
      if (fence === null) {
        fence = { char: run[0], length: run.length }
        continue
      }
      if (run[0] === fence.char && run.length >= fence.length && f[2].trim() === '') {
        fence = null
        continue
      }
    }
    if (fence !== null) continue
    const h = HEADING.exec(text)
    if (!h) continue
    const heading = h[2].trim()
    if (!heading) continue
    found.push({ heading, level: h[1].length, line: i + 1 })
  }

  const entries: OutlineEntry[] = []
  const stack: Array<{ heading: string; level: number }> = []
  for (let k = 0; k < found.length; k++) {
    const h = found[k]
    let endLine = lines.length
    for (let j = k + 1; j < found.length; j++) {
      if (found[j].level <= h.level) {
        endLine = found[j].line - 1
        break
      }
    }
    const next = found[k + 1]
    const ownEndLine = next && next.line - 1 < endLine ? next.line - 1 : endLine
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop()
    stack.push({ heading: h.heading, level: h.level })
    entries.push({
      heading: h.heading,
      level: h.level,
      line: h.line,
      endLine,
      ownEndLine,
      chars: lines.slice(h.line - 1, endLine).join('\n').length,
      path: stack.map((s) => s.heading),
    })
  }
  return entries
}

/** The innermost section a line sits in, or null before the first heading. */
export function sectionAt(outline: OutlineEntry[], line: number): OutlineEntry | null {
  let best: OutlineEntry | null = null
  for (const e of outline) {
    if (e.line <= line && line <= e.endLine && (!best || e.level > best.level)) best = e
  }
  return best
}

/**
 * The `##` section an entry sits in (the entry itself when it is one), or null
 * when it sits in none. Not `path[0]`: in a document that opens with a `#`
 * title, every path starts with that title.
 */
export function levelTwoSectionOf(outline: OutlineEntry[], entry: OutlineEntry): OutlineEntry | null {
  if (entry.level === 2) return entry
  if (entry.level < 2) return null
  return outline.find((e) => e.level === 2 && e.line <= entry.line && entry.line <= e.endLine) ?? null
}

/** A heading as the agent might name it: no emphasis marks, case and spacing ignored. */
function normalizeHeading(text: string): string {
  return text
    .replace(/[*_`~]/g, '')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export type SectionLookup =
  | { ok: true; entry: OutlineEntry }
  | { ok: false; reason: 'not_found' | 'ambiguous'; matches: OutlineEntry[] }

/**
 * Find one section by heading. `query` is a heading's text, or a path of
 * headings ("Positioning > Real alternative", `>` or `▸`) to tell apart two
 * headings with the same text. More than one match is refused (ambiguous),
 * with the candidates, so an edit never lands in the wrong place.
 */
export function findSection(outline: OutlineEntry[], query: string): SectionLookup {
  const parts = query
    .split(/\s*(?:>|▸|›)\s*/)
    .map(normalizeHeading)
    .filter(Boolean)
  if (parts.length === 0) return { ok: false, reason: 'not_found', matches: [] }
  const last = parts[parts.length - 1]
  const matches = outline.filter((e) => {
    if (normalizeHeading(e.heading) !== last) return false
    if (parts.length === 1) return true
    // Every earlier part names an ancestor, in order.
    const ancestors = e.path.slice(0, -1).map(normalizeHeading)
    let at = 0
    for (const p of parts.slice(0, -1)) {
      const found = ancestors.indexOf(p, at)
      if (found === -1) return false
      at = found + 1
    }
    return true
  })
  if (matches.length === 1) return { ok: true, entry: matches[0] }
  return { ok: false, reason: matches.length === 0 ? 'not_found' : 'ambiguous', matches }
}

/** Lines `from`..`to` (clamped) as "N: text", one per line. */
export function numberedLines(lines: string[], from: number, to: number): string {
  const start = Math.max(1, from)
  const end = Math.min(lines.length, to)
  const out: string[] = []
  for (let n = start; n <= end; n++) out.push(`${n}: ${lines[n - 1]}`)
  return out.join('\n')
}

export interface MatchPassage {
  /** The first and last line of the passage shown. */
  from: number
  to: number
  /** The lines that matched. */
  match_lines: number[]
  /** The section the first match is in, as a heading path ("A > B"), or null before the first heading. */
  section: string | null
  /** The passage, numbered. */
  text: string
}

export interface MatchResult {
  mode: 'exact' | 'all_words' | 'none'
  passages: MatchPassage[]
  /** Matched lines in all, before the passage cap. */
  total_matches: number
  truncated: boolean
}

/**
 * The passages around a phrase: every line it appears on (case ignored; a
 * phrase across a line break counts on the line it starts), with
 * `contextLines` either side, overlapping passages merged, each with its
 * section. When the exact phrase isn't there, lines holding every word of it
 * are used instead (mode 'all_words').
 */
export function findMatches(
  content: string | null | undefined,
  phrase: string,
  contextLines = 3,
  maxPassages = 12,
): MatchResult {
  const lines = splitLines(content)
  const outline = parseOutline(content)
  const needle = phrase.trim().toLowerCase()
  if (!needle) return { mode: 'none', passages: [], total_matches: 0, truncated: false }

  let mode: MatchResult['mode'] = 'exact'
  let hitLines = exactHitLines(lines, needle)
  if (hitLines.length === 0) {
    const words = needle.split(/\s+/).filter((w) => w.length > 1)
    if (words.length > 1) {
      hitLines = lines.flatMap((l, i) => (words.every((w) => l.toLowerCase().includes(w)) ? [i + 1] : []))
      mode = hitLines.length ? 'all_words' : 'none'
    } else {
      mode = 'none'
    }
  }
  if (hitLines.length === 0) return { mode: 'none', passages: [], total_matches: 0, truncated: false }

  const ctx = Math.max(0, Math.min(20, Math.floor(contextLines)))
  const ranges: Array<{ from: number; to: number; hits: number[] }> = []
  for (const hit of hitLines) {
    const from = Math.max(1, hit - ctx)
    const to = Math.min(lines.length, hit + ctx)
    const prev = ranges[ranges.length - 1]
    if (prev && from <= prev.to + 1) {
      prev.to = Math.max(prev.to, to)
      prev.hits.push(hit)
    } else {
      ranges.push({ from, to, hits: [hit] })
    }
  }
  const shown = ranges.slice(0, maxPassages)
  return {
    mode,
    total_matches: hitLines.length,
    truncated: ranges.length > shown.length,
    passages: shown.map((r) => {
      const section = sectionAt(outline, r.hits[0])
      return {
        from: r.from,
        to: r.to,
        match_lines: r.hits,
        section: section ? section.path.join(' > ') : null,
        text: numberedLines(lines, r.from, r.to),
      }
    }),
  }
}

function exactHitLines(lines: string[], needle: string): number[] {
  const full = lines.join('\n').toLowerCase()
  const starts: number[] = []
  let at = full.indexOf(needle)
  while (at !== -1) {
    starts.push(at)
    at = full.indexOf(needle, at + Math.max(1, needle.length))
  }
  if (starts.length === 0) return []
  // Offsets to line numbers.
  const out = new Set<number>()
  let line = 1
  let pos = 0
  let s = 0
  while (s < starts.length) {
    const lineEnd = pos + lines[line - 1].length
    if (starts[s] <= lineEnd) {
      out.add(line)
      s++
    } else {
      pos = lineEnd + 1
      line++
    }
  }
  return [...out]
}

// ── Edits ───────────────────────────────────────────────────────────────────

export type EditResult = { ok: true; content: string } | { ok: false; error: string }

/** new_text as lines: "" is no lines; one trailing newline is not an extra empty line. */
export function textToLines(text: string): string[] {
  if (text === '') return []
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
}

/**
 * Replace lines `from`..`to` with `newText`. `to` = `from - 1` inserts before
 * line `from` without replacing anything (`from` = line count + 1 appends);
 * an empty `newText` deletes the range.
 */
export function replaceLines(content: string | null | undefined, from: number, to: number, newText: string): EditResult {
  const lines = splitLines(content)
  const count = lines.length
  if (!Number.isInteger(from) || !Number.isInteger(to)) return { ok: false, error: 'from and to must be whole line numbers.' }
  if (from < 1 || from > count + 1) return { ok: false, error: `from must be between 1 and ${count + 1} (the document has ${count} lines).` }
  if (to < from - 1 || to > count) {
    return { ok: false, error: `to must be between ${from - 1} (insert before line ${from}) and ${count}.` }
  }
  // A body ending in a newline has an empty last line: appending at the end
  // goes before it, and the body still ends in a newline after any edit.
  const trailing = lines.length > 1 && lines[lines.length - 1] === ''
  const [f, t] = trailing && from === count + 1 ? [count, count - 1] : [from, to]
  const next = [...lines.slice(0, f - 1), ...textToLines(newText), ...lines.slice(t)].join('\n')
  return { ok: true, content: trailing && next !== '' && !next.endsWith('\n') ? `${next}\n` : next }
}

/**
 * Re-find a line range read at an older revision in the current text: the
 * block `from`..`to` as it was must appear exactly once now (for an insert,
 * the lines either side of the gap). Returns the range in current line
 * numbers, or null when it can't be placed safely.
 */
export function rebaseLineRange(
  baseContent: string | null | undefined,
  currentContent: string | null | undefined,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const base = splitLines(baseContent)
  const cur = splitLines(currentContent)
  if (from < 1 || from > base.length + 1 || to < from - 1 || to > base.length) return null
  if (to >= from) {
    const block = base.slice(from - 1, to)
    const at = uniqueBlock(cur, block)
    return at === null ? null : { from: at + 1, to: at + block.length }
  }
  // An insert before `from`.
  if (from === 1) return { from: 1, to: 0 }
  if (from === base.length + 1) return { from: cur.length + 1, to: cur.length }
  const pair = base.slice(from - 2, from)
  const at = uniqueBlock(cur, pair)
  return at === null ? null : { from: at + 2, to: at + 1 }
}

function uniqueBlock(lines: string[], block: string[]): number | null {
  if (block.length === 0) return null
  // A block of nothing but blank lines places nothing.
  if (block.every((l) => l.trim() === '')) return null
  let found: number | null = null
  for (let i = 0; i + block.length <= lines.length; i++) {
    let same = true
    for (let j = 0; j < block.length; j++) {
      if (lines[i + j] !== block[j]) {
        same = false
        break
      }
    }
    if (same) {
      if (found !== null) return null
      found = i
    }
  }
  return found
}

function headingLine(level: number, heading: string): string {
  return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${heading.replace(/\s+/g, ' ').trim()}`
}

/** The text as lines, without blank lines at either end (joinPieces spaces the pieces). */
function block(text: string): string[] {
  return trimBlank(textToLines(text))
}

/** Join pieces of lines, keeping one blank line between non-empty pieces. */
function joinPieces(pieces: string[][]): string {
  const out: string[] = []
  for (const piece of pieces) {
    const trimmed = trimBlank(piece)
    if (trimmed.length === 0) continue
    if (out.length > 0) out.push('')
    out.push(...trimmed)
  }
  return out.join('\n')
}

/** A body that ended in a newline still does after a section edit. */
function keepTrailingNewline(original: string | null | undefined, next: string): string {
  return next && /\n$/.test(original ?? '') ? `${next}\n` : next
}

function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b)
}

/**
 * Replace a section's body (its subsections included) with `body`; the
 * heading stays unless `newHeading` renames it.
 */
export function replaceSection(content: string | null | undefined, entry: OutlineEntry, body: string, newHeading?: string): string {
  const lines = splitLines(content)
  const before = lines.slice(0, entry.line - 1)
  const heading = newHeading ? headingLine(entry.level, newHeading) : lines[entry.line - 1]
  const after = lines.slice(entry.endLine)
  // Keep the section's own style: body right under the heading, or a blank line between.
  const tight = (lines[entry.line] ?? '').trim() !== ''
  const section = tight ? [[heading, ...block(body)]] : [[heading], block(body)]
  return keepTrailingNewline(content, joinPieces([before, ...section, after]))
}

/** Add `text` at the end of a section's own text, before its first subsection. */
export function appendToSection(content: string | null | undefined, entry: OutlineEntry, text: string): string {
  const lines = splitLines(content)
  const head = lines.slice(0, entry.ownEndLine)
  const rest = lines.slice(entry.ownEndLine)
  return keepTrailingNewline(content, joinPieces([head, block(text), rest]))
}

/** Remove a section: its heading and everything under it. */
export function removeSection(content: string | null | undefined, entry: OutlineEntry): string {
  const lines = splitLines(content)
  return keepTrailingNewline(content, joinPieces([lines.slice(0, entry.line - 1), lines.slice(entry.endLine)]))
}

/**
 * Insert a new section after `entry` (after its subsections), at `level`
 * (default: the same level as `entry`); with no `entry`, at the end of the
 * document (level default 2).
 */
export function insertSectionAfter(
  content: string | null | undefined,
  entry: OutlineEntry | null,
  heading: string,
  body: string,
  level?: number,
): string {
  const lines = splitLines(content)
  const at = entry ? entry.endLine : lines.length
  const lvl = level ?? entry?.level ?? 2
  return keepTrailingNewline(content, joinPieces([lines.slice(0, at), [headingLine(lvl, heading)], block(body), lines.slice(at)]))
}

/** The outline as the model sees it: one row per heading. */
export function outlineForModel(outline: OutlineEntry[]) {
  return outline.map((e) => ({ heading: e.heading, level: e.level, line: e.line, end_line: e.endLine, chars: e.chars }))
}

/** Candidates for an ambiguous or missing heading, for the refusal. */
export function describeCandidates(matches: OutlineEntry[]): string {
  return matches.map((m) => `"${m.path.join(' > ')}" (line ${m.line})`).join(', ')
}
