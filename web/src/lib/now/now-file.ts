/**
 * The Now file (docs/plans/now-file.md, migration 440): one short private
 * document per person per workspace that the main agent keeps as its running
 * notes on what is going on for them right now, under six headings (Focus, In
 * flight, Waiting on you, Waiting on others, Coming up, Keep in mind). It
 * points at things (ENG-42, the Acme call, Sarah) and never copies them.
 *
 *   where     a document titled "Now", private to the person (created_by is
 *             their member row), with no canon_key, stamped by the server
 *             (frontmatter.now, which client writes can't set, change or
 *             drop: 440's guards). document.kind is 'now', so it is out of
 *             every listing. One per person per workspace, not archived (the
 *             unique index: get-or-create retries on 23505, as
 *             canon-create.ts does).
 *   who       only update_now writes it, and only the main agent holds that:
 *             the person's own chat in the app (attended-only), and from
 *             Slice 2 its check-in. The writer is recorded on the revision
 *             (edit_meta.writer: 'chat' or 'check_in'), and 440 folds an
 *             agent's writes within 10 minutes into one revision per writer.
 *   writes    compare-and-swap through writeDocument (src/lib/documents/
 *             write.ts), never a rebase: a line number means nothing against
 *             a note that changed, so a stale base_revision writes nothing and
 *             hands back the current note.
 *   lines     every line the agent writes ends with the date it was written,
 *             in the person's zone ("(Oct 26)"), and carries no link and no
 *             email address (a planted line read from an email can't point
 *             anywhere). At most 200 characters a line; the note at most 40
 *             lines (blank lines don't count) and 6,000 characters.
 *   tracks    an `add` may name what its line follows (a work item, an action,
 *             a PR, an ask to another agent): kept in frontmatter.now.tracks,
 *             keyed by the line text's hash (without its marker and date).
 *             `remove` drops a line's track, `replace` and `move` keep it, and
 *             a track whose line is gone (a person's edit changed it) is
 *             dropped on the next write. Slice 2's check-in follows them.
 *
 * Rendering (nowLines, renderNowLines) and applying edits (applyNowEdits) are
 * pure; the rest reads and writes on the caller's client (the chat's
 * service-role client: it fences by workspace and member itself).
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { parseOutline, splitLines } from '@/lib/documents/markdown-structure'
import { clampSummary, writeDocument } from '@/lib/documents/write'
import { NOW_KEY, isNowDocument } from './now-stamp'

export { NOW_EDIT_REFUSAL, NOW_KEY, NOW_READ_REFUSAL, isNowDocument } from './now-stamp'

/** The note's title. */
export const NOW_TITLE = 'Now'

/** The six headings, in the order the note keeps them. */
export const NOW_SECTIONS = ['Focus', 'In flight', 'Waiting on you', 'Waiting on others', 'Coming up', 'Keep in mind'] as const
export type NowSection = (typeof NOW_SECTIONS)[number]

/** At most this many non-blank lines, headings included. */
export const NOW_MAX_LINES = 40
/** At most this many characters in the whole note (about 1,500 tokens). */
export const NOW_MAX_CHARS = 6_000
/** At most this many characters in one line the agent writes, its date included. */
export const NOW_LINE_MAX_CHARS = 200
/** At most this many edits in one update_now call. */
export const NOW_MAX_EDITS = 20

/** Who wrote a revision (edit_meta.writer): the person's own chat, or Slice 2's check-in. */
export const NOW_WRITERS = ['chat', 'check_in'] as const
export type NowWriter = (typeof NOW_WRITERS)[number]

/** What a tracked line follows: a work item (tracked_job), an action, a PR, an ask to another agent. */
export const NOW_TRACK_KINDS = ['work', 'action', 'pr', 'ask'] as const
export type NowTrackKind = (typeof NOW_TRACK_KINDS)[number]

export interface NowTrack {
  kind: NowTrackKind
  /** The item's id: a uuid, an identifier (ENG-42) or a PR ("owner/repo#12"). */
  id: string
  /** The line's text hash (nowLineHash). */
  hash: string
  /** When the line was added (ISO). */
  added_at: string
}

/** The server-owned stamp at frontmatter.now. */
export interface NowStamp {
  tracks: NowTrack[]
}

export interface NowNote {
  id: string
  workspaceId: string
  /** The person's member row (document.created_by). */
  memberId: string
  content: string
  revision: number
  updatedAt: string | null
  /** The whole stored frontmatter, the stamp included. */
  frontmatter: Record<string, unknown>
  tracks: NowTrack[]
}

/** One edit, as update_now takes it. Checked by applyNowEdits, never trusted. */
export interface NowEditInput {
  op: 'add' | 'replace' | 'remove' | 'move'
  section?: string
  line?: number
  text?: string
  track?: { kind: string; id: string }
}

/** A line an update changed, as the tool returns it: its new line number when it is still in the note. */
export interface NowChange {
  op: 'add' | 'replace' | 'remove' | 'move'
  line?: number
  section?: string
  text: string
}

export type NowRefusalCode = 'NOW_INVALID' | 'NOW_LINK' | 'NOW_LINE_TOO_LONG' | 'NOW_TOO_BIG'

export type NowApplyResult =
  | { ok: true; content: string; tracks: NowTrack[]; changed: NowChange[]; unchanged: boolean }
  | { ok: false; code: NowRefusalCode; error: string }

// ── Pure: lines, dates, checks ────────────────────────────────────────────────

/** The note as lines (CRLF read as LF), trailing blank lines dropped; empty is no lines. The numbering update_now uses. Pure. */
export function nowLines(content: string | null | undefined): string[] {
  const lines = splitLines(content)
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * True when the note holds nothing yet: no lines, or only headings and blank
 * lines (every line removed, the headings left). The now section shows it as
 * the empty section, and the check-in starts it. Pure.
 */
export function nowContentEmpty(content: string | null | undefined): boolean {
  return nowLines(content).every((line) => !line.trim() || HEADING_LINE_RE.test(line))
}

export interface NowLinesRender {
  /** The lines, numbered as update_now names them (" 1 ## Focus"), one per line. */
  text: string
  lineCount: number
  /** The note ran past `maxChars` and the rest was cut, with a line saying so. */
  truncated: boolean
}

/**
 * The note with its lines numbered for update_now, as the turn context's `now`
 * section and a refused update show it: " 1 ## Focus". A note past `maxChars`
 * (a person's long edit) is cut there, with a line saying so. Pure.
 */
export function renderNowLines(content: string | null | undefined, maxChars: number = NOW_MAX_CHARS): NowLinesRender {
  const lines = nowLines(content)
  const width = Math.max(2, String(lines.length).length)
  const out: string[] = []
  let used = 0
  let truncated = false
  for (let i = 0; i < lines.length; i++) {
    const row = `${String(i + 1).padStart(width)} ${lines[i]}`
    if (used + row.length + 1 > maxChars) {
      truncated = true
      out.push(`[… cut here: the note runs past ${maxChars.toLocaleString('en-US')} characters, so lines ${i + 1}–${lines.length} are not shown]`)
      break
    }
    out.push(row)
    used += row.length + 1
  }
  return { text: out.join('\n'), lineCount: lines.length, truncated }
}

/** The date a line ends with, in the person's zone: "Oct 26". Pure. */
export function formatNowDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at)
  } catch {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(at)
  }
}

/** A line's closing date, "(Oct 26)". */
const DATE_SUFFIX_RE = /\s*\((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? \d{1,2}\)\s*$/i
/** A list marker and the space after it ("- ", "* ", "1. "), with any indent before it. */
const MARKER_RE = /^(\s*(?:[-*+•]|\d{1,3}[.)])\s+)/
/** An ATX heading line. */
const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s/

/** A link: a scheme, a www. host, a bare domain on a common top-level domain, or markdown link syntax. */
const LINK_RES = [
  /\b[a-z][a-z0-9+.-]*:\/\//i,
  /\b(?:mailto|javascript|data|file|tel):/i,
  /(?:^|[^a-z0-9.-])www\.[a-z0-9-]/i,
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|io|ai|co|dev|app|xyz|info|biz|ly|gg|uk|de|fr|eu|ca|au|tv|fm|link|site|online|page|cloud|tech)\b/i,
  /\]\(/,
]
/** An email address. */
const EMAIL_RE = /[^\s@<>()[\]"',;:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i

/** Why a line the agent wrote can't go in, or null. Pure. */
export function nowLineRefusal(text: string): { code: NowRefusalCode; error: string } | null {
  if (EMAIL_RE.test(text)) {
    return { code: 'NOW_LINK', error: 'The Now file holds no email addresses: name the person instead ("Sarah", "Mark at Acme").' }
  }
  if (LINK_RES.some((re) => re.test(text))) {
    return { code: 'NOW_LINK', error: 'The Now file holds no links or web addresses: name the item instead (ENG-42, the Acme deck, the pricing doc).' }
  }
  return null
}

/** A line's text without its marker and date. */
function lineBody(line: string): string {
  return line.replace(MARKER_RE, '').replace(DATE_SUFFIX_RE, '').trim()
}

/** The hash a track keys its line by: the line's text without marker or date, case and spacing ignored. Pure. */
export function nowLineHash(line: string): string {
  const body = lineBody(line).toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/** The stored stamp's tracks, shape-checked (a row is data). Pure. */
export function parseNowTracks(stamp: unknown): NowTrack[] {
  const raw = stamp && typeof stamp === 'object' && !Array.isArray(stamp) ? (stamp as { tracks?: unknown }).tracks : undefined
  if (!Array.isArray(raw)) return []
  const out: NowTrack[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    if (!(NOW_TRACK_KINDS as readonly string[]).includes(r.kind as string)) continue
    if (typeof r.id !== 'string' || !TRACK_ID_RE.test(r.id)) continue
    if (typeof r.hash !== 'string' || !/^[0-9a-f]{16}$/.test(r.hash)) continue
    out.push({ kind: r.kind as NowTrackKind, id: canonicalTrackId(r.kind as NowTrackKind, r.id), hash: r.hash, added_at: typeof r.added_at === 'string' ? r.added_at : '' })
  }
  return out.slice(0, NOW_MAX_LINES)
}

/** A track's id: no scheme (no link), at most 200 characters. */
const TRACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._#/-]{0,199}$/

const TRACK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A track's id in the one spelling its item is stored under, so the
 * check-in's case-sensitive lookups find it and one item has one retry key:
 * an action's identifier upper case (ENG-42, as Dial8 writes them), every
 * other id lower case (uuids, and owner/repo#12 as pr.changed writes it).
 * Pure.
 */
export function canonicalTrackId(kind: NowTrackKind, id: string): string {
  const trimmed = id.trim()
  return kind === 'action' && !TRACK_UUID_RE.test(trimmed) ? trimmed.toUpperCase() : trimmed.toLowerCase()
}

/** The known section a heading names, or null (a heading the person typed). */
function knownSection(heading: string): NowSection | null {
  const want = heading.replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  return NOW_SECTIONS.find((s) => s.toLowerCase() === want) ?? null
}

/** The section an edit names, matched case-insensitively. */
function sectionArg(value: unknown): NowSection | null {
  return typeof value === 'string' ? knownSection(value) : null
}

/** The text of a line the agent supplied, cleaned: one line, no marker, not a heading. */
function cleanText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'text is missing: pass the line itself.' }
  const t = raw.replace(/\r\n?/g, '\n').trim()
  if (t.includes('\n')) return { ok: false, error: 'One line per edit: split it into several adds.' }
  const text = t.replace(MARKER_RE, '').trim()
  if (!text) return { ok: false, error: 'text is empty: pass the line itself.' }
  if (HEADING_LINE_RE.test(text)) return { ok: false, error: 'A line, not a heading: name its section instead.' }
  return { ok: true, text }
}

/** A line as the note keeps it: its marker, its text, its date (today's unless the text ends with one). */
function datedLine(marker: string, text: string, today: string, redate = false): string {
  const body = redate ? text.replace(DATE_SUFFIX_RE, '').trim() : text
  return DATE_SUFFIX_RE.test(body) ? `${marker}${body}` : `${marker}${body} (${today})`
}

/** Checks on a line the agent wrote: no link or address, not too long. */
function lineChecks(line: string): { code: NowRefusalCode; error: string } | null {
  const refusal = nowLineRefusal(line)
  if (refusal) return refusal
  if (line.length > NOW_LINE_MAX_CHARS) {
    return { code: 'NOW_LINE_TOO_LONG', error: `A line holds at most ${NOW_LINE_MAX_CHARS} characters, its date included; this one has ${line.length}. Say it shorter.` }
  }
  return null
}

const nonBlank = (lines: string[]) => lines.filter((l) => l.trim() !== '').length
const charsOf = (lines: string[]) => lines.join('\n').length

/** Over the cap and bigger than before (a removal from a note already over it still goes through). */
function sizeRefusal(before: string[], after: string[]): { code: NowRefusalCode; error: string } | null {
  const lines = nonBlank(after)
  const chars = charsOf(after)
  if (lines > NOW_MAX_LINES && lines > nonBlank(before)) {
    return { code: 'NOW_TOO_BIG', error: `The note would have ${lines} lines; it holds at most ${NOW_MAX_LINES}. Tighten it: remove finished lines or merge some, then try again.` }
  }
  if (chars > NOW_MAX_CHARS && chars > charsOf(before)) {
    return { code: 'NOW_TOO_BIG', error: `The note would have ${chars.toLocaleString('en-US')} characters; it holds at most ${NOW_MAX_CHARS.toLocaleString('en-US')}. Tighten it: remove finished lines or say them shorter, then try again.` }
  }
  return null
}

/** Tracks re-keyed and added, then only those whose line is still in the note. */
function settleTracks(tracks: NowTrack[], lines: string[]): NowTrack[] {
  const present = new Set(lines.filter((l) => l.trim() !== '' && !HEADING_LINE_RE.test(l)).map(nowLineHash))
  const seen = new Set<string>()
  const out: NowTrack[] = []
  for (const t of tracks) {
    const key = `${t.kind}:${t.id}:${t.hash}`
    if (!present.has(t.hash) || seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out.slice(0, NOW_MAX_LINES)
}

const sameTracks = (a: NowTrack[], b: NowTrack[]) =>
  a.length === b.length && a.every((t, i) => t.kind === b[i].kind && t.id === b[i].id && t.hash === b[i].hash)

/**
 * Apply update_now's edits to the note as it is (`content`, its `tracks`).
 * Every line number names a line of `content` (nowLines): all of them are
 * resolved against it first, so a remove doesn't shift a later replace. `add`
 * puts a line at the end of a known section, creating the heading in the fixed
 * order when the note lacks it; a heading the person typed is kept as is.
 * `replace` keeps the line's marker and its track; `move` keeps its text and
 * track and re-dates it; `remove` on a heading needs its section empty. `today`
 * is the date stamp ("Oct 26"), `nowIso` a new track's added_at. Pure.
 */
export function applyNowEdits(
  content: string | null | undefined,
  tracks: NowTrack[],
  edits: NowEditInput[],
  opts: { today: string; nowIso: string },
): NowApplyResult {
  const lines = nowLines(content)
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, code: 'NOW_INVALID', error: 'Pass at least one edit, or rewrite.' }
  if (edits.length > NOW_MAX_EDITS) return { ok: false, code: 'NOW_INVALID', error: `At most ${NOW_MAX_EDITS} edits in one call.` }

  const outline = parseOutline(lines.join('\n'))
  const headingAt = new Map(outline.map((e) => [e.line - 1, e]))
  const isHeading = (i: number) => headingAt.has(i)
  // Where each known section is: its heading, and the last non-blank line of its own text.
  const sections = new Map<NowSection, { heading: number; last: number }>()
  for (const e of outline) {
    const known = knownSection(e.heading)
    if (!known || sections.has(known)) continue
    let last = e.ownEndLine - 1
    while (last > e.line - 1 && lines[last].trim() === '') last--
    sections.set(known, { heading: e.line - 1, last })
  }

  const removed = new Set<number>()
  const replaced = new Map<number, string>()
  const appends = new Map<NowSection, Array<{ line: string; change: NowChange }>>()
  const touched = new Set<number>()
  const headingRemovals: number[] = []
  const nextTracks: NowTrack[] = [...tracks]
  const changed: NowChange[] = []

  const lineArg = (edit: NowEditInput, n: number): { ok: true; i: number } | { ok: false; error: string } => {
    const line = edit.line
    if (typeof line !== 'number' || !Number.isInteger(line)) return { ok: false, error: `Edit ${n + 1} (${edit.op}) needs line: a line number from the note.` }
    if (line < 1 || line > lines.length) return { ok: false, error: `Line ${line} is not in the note: it has ${lines.length} line${lines.length === 1 ? '' : 's'}.` }
    const i = line - 1
    if (touched.has(i)) return { ok: false, error: `Line ${line} is edited twice: one edit per line.` }
    if (lines[i].trim() === '') return { ok: false, error: `Line ${line} is blank.` }
    return { ok: true, i }
  }
  const pushAppend = (section: NowSection, line: string, change: NowChange) => {
    const list = appends.get(section) ?? []
    list.push({ line, change })
    appends.set(section, list)
  }

  for (let n = 0; n < edits.length; n++) {
    const edit = edits[n] ?? ({} as NowEditInput)
    if (edit.op === 'add') {
      const section = sectionArg(edit.section)
      if (!section) return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1} (add) needs section: one of ${NOW_SECTIONS.join(', ')}.` }
      const text = cleanText(edit.text)
      if (!text.ok) return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1} (add): ${text.error}` }
      const line = datedLine('- ', text.text, opts.today)
      const refused = lineChecks(line)
      if (refused) return { ok: false, ...refused }
      if (edit.track !== undefined) {
        const t = edit.track as { kind?: unknown; id?: unknown } | null
        if (!t || !(NOW_TRACK_KINDS as readonly string[]).includes(t.kind as string) || typeof t.id !== 'string' || !TRACK_ID_RE.test(t.id.trim())) {
          return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1} (add): track needs kind (${NOW_TRACK_KINDS.join(', ')}) and the item's id (no link).` }
        }
        nextTracks.push({ kind: t.kind as NowTrackKind, id: canonicalTrackId(t.kind as NowTrackKind, t.id), hash: nowLineHash(line), added_at: opts.nowIso })
      }
      pushAppend(section, line, { op: 'add', section, text: line })
      continue
    }
    if (edit.op === 'replace') {
      const at = lineArg(edit, n)
      if (!at.ok) return { ok: false, code: 'NOW_INVALID', error: at.error }
      if (isHeading(at.i)) return { ok: false, code: 'NOW_INVALID', error: `Line ${at.i + 1} is a heading: replace the lines under it.` }
      const text = cleanText(edit.text)
      if (!text.ok) return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1} (replace): ${text.error}` }
      const marker = MARKER_RE.exec(lines[at.i])?.[1] ?? '- '
      const line = datedLine(marker, text.text, opts.today)
      const refused = lineChecks(line)
      if (refused) return { ok: false, ...refused }
      touched.add(at.i)
      replaced.set(at.i, line)
      // The line's track follows it to its new text.
      const was = nowLineHash(lines[at.i])
      const now = nowLineHash(line)
      for (let k = 0; k < nextTracks.length; k++) if (nextTracks[k].hash === was) nextTracks[k] = { ...nextTracks[k], hash: now }
      continue
    }
    if (edit.op === 'remove') {
      const at = lineArg(edit, n)
      if (!at.ok) return { ok: false, code: 'NOW_INVALID', error: at.error }
      touched.add(at.i)
      removed.add(at.i)
      if (isHeading(at.i)) headingRemovals.push(at.i)
      changed.push({ op: 'remove', text: lines[at.i] })
      continue
    }
    if (edit.op === 'move') {
      const at = lineArg(edit, n)
      if (!at.ok) return { ok: false, code: 'NOW_INVALID', error: at.error }
      if (isHeading(at.i)) return { ok: false, code: 'NOW_INVALID', error: `Line ${at.i + 1} is a heading: move the lines under it.` }
      const section = sectionArg(edit.section)
      if (!section) return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1} (move) needs section: one of ${NOW_SECTIONS.join(', ')}.` }
      touched.add(at.i)
      removed.add(at.i)
      // The text is kept (no new checks: it is already in the note), re-dated today.
      const line = datedLine('- ', lineBody(lines[at.i]), opts.today, true)
      pushAppend(section, line, { op: 'move', section, text: line })
      continue
    }
    return { ok: false, code: 'NOW_INVALID', error: `Edit ${n + 1}: op is one of add, replace, remove, move.` }
  }

  // A heading goes only once nothing is left under it.
  for (const h of headingRemovals) {
    const entry = headingAt.get(h)!
    const known = knownSection(entry.heading)
    const left = lines.slice(h + 1, entry.ownEndLine).some((l, k) => l.trim() !== '' && !removed.has(h + 1 + k))
    if (left || (known && appends.has(known))) {
      return { ok: false, code: 'NOW_INVALID', error: `Line ${h + 1} is a heading with lines under it: remove or move those first.` }
    }
  }

  // New sections go before the first known section after them that the note has, else at the end.
  const before = new Map<number, NowSection[]>()
  const atEnd: NowSection[] = []
  for (const section of NOW_SECTIONS) {
    if (!appends.has(section) || sections.has(section)) continue
    const later = NOW_SECTIONS.slice(NOW_SECTIONS.indexOf(section) + 1).find((s) => sections.has(s) && !removed.has(sections.get(s)!.heading))
    if (later) {
      const at = sections.get(later)!.heading
      before.set(at, [...(before.get(at) ?? []), section])
    } else {
      atEnd.push(section)
    }
  }
  const afterLine = new Map<number, NowSection>()
  for (const [section, where] of sections) if (appends.has(section)) afterLine.set(where.last, section)

  // Build the note: blank lines collapsed to one, none at the ends.
  const out: string[] = []
  const push = (line: string) => {
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) return
    out.push(line)
  }
  const emitAppends = (section: NowSection) => {
    for (const a of appends.get(section) ?? []) {
      push(a.line)
      changed.push({ ...a.change, line: out.length })
    }
  }
  const emitSection = (section: NowSection) => {
    push('')
    push(`## ${section}`)
    emitAppends(section)
    push('')
  }
  for (let i = 0; i < lines.length; i++) {
    for (const section of before.get(i) ?? []) emitSection(section)
    if (!removed.has(i)) {
      const line = replaced.get(i) ?? lines[i]
      push(line)
      if (replaced.has(i)) changed.push({ op: 'replace', line: out.length, text: line })
    }
    const section = afterLine.get(i)
    if (section) emitAppends(section)
  }
  for (const section of atEnd) emitSection(section)
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()

  const size = sizeRefusal(lines, out)
  if (size) return { ok: false, ...size }

  const settled = settleTracks(nextTracks, out)
  const nextContent = out.join('\n')
  const unchanged = nextContent === lines.join('\n') && sameTracks(settled, tracks)
  return { ok: true, content: nextContent, tracks: settled, changed, unchanged }
}

/**
 * A whole new note (update_now's `rewrite`, for a tidy). Lines already in the
 * note are taken as they are; a new line is checked like an added one and
 * dated when it ends with no date. Tracks whose line is gone are dropped. Pure.
 */
export function applyNowRewrite(
  content: string | null | undefined,
  tracks: NowTrack[],
  rewrite: string,
  opts: { today: string },
): NowApplyResult {
  const lines = nowLines(content)
  const existing = new Set(lines)
  const out: string[] = []
  for (const raw of nowLines(rewrite)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('')
      continue
    }
    if (existing.has(line) || HEADING_LINE_RE.test(line)) {
      if (!existing.has(line)) {
        const refused = lineChecks(line)
        if (refused) return { ok: false, ...refused }
      }
      out.push(line)
      continue
    }
    const marker = MARKER_RE.exec(line)?.[1] ?? '- '
    const dated = datedLine(marker, line.replace(MARKER_RE, '').trim(), opts.today)
    const refused = lineChecks(dated)
    if (refused) return { ok: false, ...refused }
    out.push(dated)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  if (out.length === 0) return { ok: false, code: 'NOW_INVALID', error: 'The rewrite is empty. To take lines off the note, remove them.' }
  const size = sizeRefusal(lines, out)
  if (size) return { ok: false, ...size }
  const settled = settleTracks(tracks, out)
  const nextContent = out.join('\n')
  return { ok: true, content: nextContent, tracks: settled, changed: [], unchanged: nextContent === lines.join('\n') && sameTracks(settled, tracks) }
}

// ── Reads and writes ─────────────────────────────────────────────────────────

const NOW_COLUMNS = 'id, workspace_id, created_by, content, revision, frontmatter, updated_at'

const plainObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function toNote(row: Record<string, unknown>, memberId: string): NowNote {
  const frontmatter = plainObject(row.frontmatter)
  const revision = Number(row.revision)
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    memberId,
    content: typeof row.content === 'string' ? row.content : '',
    revision: Number.isInteger(revision) && revision >= 1 ? revision : 1,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    frontmatter,
    tracks: parseNowTracks(frontmatter[NOW_KEY]),
  }
}

/** The person's member row in the workspace, or null. */
export async function nowMemberId(supabase: SupabaseClient, args: { workspaceId: string; userId: string }): Promise<{ ok: true; memberId: string | null } | { ok: false; error: string }> {
  const { data, error } = await supabase.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle()
  if (error) return { ok: false, error: error.message }
  const id = (data as { id?: unknown } | null)?.id
  return { ok: true, memberId: typeof id === 'string' ? id : null }
}

/**
 * The person's Now file in a workspace (kind 'now', theirs, not archived), or
 * null when they have none. One read on the unique index. Never throws.
 */
export async function loadNowNote(
  supabase: SupabaseClient,
  args: { workspaceId: string; memberId: string },
): Promise<{ ok: true; note: NowNote | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase
      .from('document')
      .select(NOW_COLUMNS)
      .eq('workspace_id', args.workspaceId)
      .eq('created_by', args.memberId)
      .eq('kind', NOW_KEY)
      .neq('status', 'archived')
      .maybeSingle()
    if (error) return { ok: false, error: error.message }
    const row = data as Record<string, unknown> | null
    // The kind is the stamp's; read it again from the row (a row is data).
    if (!row || !isNowDocument(row.frontmatter)) return { ok: true, note: null }
    return { ok: true, note: toNote(row, args.memberId) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The person's Now file, created empty when they have none: private, theirs,
 * titled "Now", with the server's stamp. Two creates at once: the unique index
 * keeps one, and the other reads it back (`created: false`). Never throws.
 */
export async function getOrCreateNowNote(
  supabase: SupabaseClient,
  args: { workspaceId: string; memberId: string },
): Promise<{ ok: true; note: NowNote; created: boolean } | { ok: false; error: string }> {
  const loaded = await loadNowNote(supabase, args)
  if (!loaded.ok) return loaded
  if (loaded.note) return { ok: true, note: loaded.note, created: false }
  try {
    const { data, error } = await supabase
      .from('document')
      .insert({
        workspace_id: args.workspaceId,
        title: NOW_TITLE,
        content: '',
        created_by: args.memberId,
        last_edited_by: args.memberId,
        status: 'active',
        visibility: 'private',
        frontmatter: { [NOW_KEY]: { tracks: [] } satisfies NowStamp },
      })
      .select(NOW_COLUMNS)
      .single()
    if (error || !data) {
      if ((error as { code?: string } | null)?.code === '23505') {
        const again = await loadNowNote(supabase, args)
        if (again.ok && again.note) return { ok: true, note: again.note, created: false }
        if (!again.ok) return again
      }
      return { ok: false, error: error?.message ?? 'Could not create the Now file' }
    }
    return { ok: true, note: toNote(data as Record<string, unknown>, args.memberId), created: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface UpdateNowArgs {
  workspaceId: string
  userId: string
  /** The revision the edits were made against (the `now` section's). */
  baseRevision?: number | null
  edits?: NowEditInput[]
  /** The whole note, instead of edits. */
  rewrite?: string
  /** One line for the history. */
  summary: string
  /** Who writes (edit_meta.writer): 'chat' (the person's own chat) unless Slice 2's check-in says 'check_in'. */
  writer?: NowWriter
  /** The person's zone for the date stamp; read with readMemberTimeZone when absent. */
  timeZone?: string
  now?: Date
}

export type UpdateNowResult =
  | {
      success: true
      /** The note's document id: what the chat row opens. */
      document_id: string
      revision: number
      /** The lines this call changed, with their new line numbers. */
      changed: NowChange[]
      created?: true
      unchanged?: true
      rewritten?: { line_count: number }
    }
  | {
      success: false
      code: NowRefusalCode | 'NOW_STALE' | 'NOW_NOT_MEMBER' | 'NOW_ERROR'
      error: string
      conflict?: true
      current_revision?: number
      /** The note as it is now, numbered, on a stale call. */
      note?: string
    }

/** A refusal that hands back the note as it is now, numbered. */
function noteRefusal(code: 'NOW_STALE' | 'NOW_INVALID', note: NowNote, error: string): UpdateNowResult {
  return { success: false, code, ...(code === 'NOW_STALE' ? { conflict: true as const } : {}), error, current_revision: note.revision, note: renderNowLines(note.content).text }
}

/** A stale call's refusal: what changed, and the note as it is now. */
const staleRefusal = (note: NowNote, error: string) => noteRefusal('NOW_STALE', note, error)

/**
 * update_now: apply edits (or a rewrite) to the person's Now file and write
 * it, compare-and-swap at the revision read, with source 'agent', the summary
 * and edit_meta.writer. Creates the note on its first write. A stale
 * base_revision, or a write that lost the race, writes nothing and hands back
 * the note as it is now. Never throws.
 */
export async function updateNowNote(supabase: SupabaseClient, args: UpdateNowArgs): Promise<UpdateNowResult> {
  try {
    const hasEdits = Array.isArray(args.edits) && args.edits.length > 0
    const hasRewrite = typeof args.rewrite === 'string'
    if (hasEdits === hasRewrite) return { success: false, code: 'NOW_INVALID', error: 'Pass edits or rewrite (one of the two).' }
    const summary = clampSummary(args.summary)
    if (!summary) return { success: false, code: 'NOW_INVALID', error: 'Pass summary: one line for the history (what changed).' }
    const writer: NowWriter = args.writer ?? 'chat'

    const member = await nowMemberId(supabase, args)
    if (!member.ok) return { success: false, code: 'NOW_ERROR', error: member.error }
    if (!member.memberId) return { success: false, code: 'NOW_NOT_MEMBER', error: 'Not a member of this workspace.' }
    const memberId = member.memberId

    const loaded = await loadNowNote(supabase, { workspaceId: args.workspaceId, memberId })
    if (!loaded.ok) return { success: false, code: 'NOW_ERROR', error: loaded.error }
    let note = loaded.note
    // The check-in starting an empty note (check-in.ts "THE START") tracks every
    // line: an untracked one would leave a note no later check-in follows.
    if (writer === 'check_in' && (!note || nowContentEmpty(note.content)) && (hasRewrite || (args.edits ?? []).some((e) => e?.op === 'add' && !e.track))) {
      return {
        success: false,
        code: 'NOW_INVALID',
        error: "Starting the note, track every line: pass `track` on each add, with the kind and id from its item's key, and no rewrite. Nothing was written.",
      }
    }
    const base = typeof args.baseRevision === 'number' && Number.isInteger(args.baseRevision) ? args.baseRevision : null
    const namesLines = hasRewrite || (args.edits ?? []).some((e) => e?.op !== 'add')
    if (note) {
      if (base !== null && base !== note.revision) {
        return staleRefusal(note, `Your Now file changed since revision ${base}: it is at revision ${note.revision}. Nothing was written. Here it is now; make the change against these line numbers.`)
      }
      if (base === null && namesLines && nonBlank(nowLines(note.content)) > 0) {
        return noteRefusal('NOW_INVALID', note, `Pass base_revision (the now section's revision) with a replace, remove, move or rewrite, so a line number never lands on the wrong line. It is at revision ${note.revision}; here it is.`)
      }
    }

    const at = args.now ?? new Date()
    const timeZone = args.timeZone ?? (await readMemberTimeZone(supabase, { workspaceId: args.workspaceId, userId: args.userId })).timeZone
    const today = formatNowDate(at, timeZone)
    const apply = (n: NowNote | null): NowApplyResult =>
      hasRewrite
        ? applyNowRewrite(n?.content ?? '', n?.tracks ?? [], args.rewrite!, { today })
        : applyNowEdits(n?.content ?? '', n?.tracks ?? [], args.edits!, { today, nowIso: at.toISOString() })

    let applied = apply(note)
    if (!applied.ok) return { success: false, code: applied.code, error: applied.error }
    if (applied.unchanged && note) return { success: true, document_id: note.id, revision: note.revision, changed: [], unchanged: true }

    let created = false
    if (!note) {
      const made = await getOrCreateNowNote(supabase, { workspaceId: args.workspaceId, memberId })
      if (!made.ok) return { success: false, code: 'NOW_ERROR', error: made.error }
      note = made.note
      created = made.created
      // Someone else's write made it first: apply against what it holds, unless the edits named lines.
      if (!made.created && nonBlank(nowLines(note.content)) > 0) {
        if (namesLines) return staleRefusal(note, `Your Now file was just written elsewhere: it is at revision ${note.revision}. Nothing was written. Here it is; make the change against these line numbers.`)
        applied = apply(note)
        if (!applied.ok) return { success: false, code: applied.code, error: applied.error }
      }
    }

    const written = await writeDocument(supabase, {
      documentId: note.id,
      workspaceId: args.workspaceId,
      baseRevision: note.revision,
      patch: {
        content: applied.content,
        frontmatter: { ...note.frontmatter, [NOW_KEY]: { ...plainObject(note.frontmatter[NOW_KEY]), tracks: applied.tracks } },
        // Who wrote it (440): agent revisions fold only within one writer.
        edit_meta: { writer },
      },
      source: 'agent',
      memberId,
      summary,
      select: 'id',
    })
    if (!written.ok) {
      if (written.reason === 'conflict') {
        const again = await loadNowNote(supabase, { workspaceId: args.workspaceId, memberId })
        if (again.ok && again.note) return staleRefusal(again.note, `Your Now file changed while you were writing: it is at revision ${again.note.revision}. Nothing was written. Here it is now; make the change against these line numbers.`)
        return { success: false, code: 'NOW_STALE', conflict: true, error: 'Your Now file changed while you were writing. Nothing was written; try again.', current_revision: written.currentRevision }
      }
      if (written.reason === 'not_found') return { success: false, code: 'NOW_ERROR', error: 'The Now file is gone. Nothing was written; try again.' }
      if (written.reason === 'refused') return { success: false, code: 'NOW_ERROR', error: 'The Now file could not be written. Nothing changed.' }
      return { success: false, code: 'NOW_ERROR', error: written.error }
    }
    return {
      success: true,
      document_id: note.id,
      revision: written.revision,
      changed: applied.changed,
      ...(created ? { created: true as const } : {}),
      ...(hasRewrite ? { rewritten: { line_count: nowLines(applied.content).length } } : {}),
    }
  } catch (err) {
    return { success: false, code: 'NOW_ERROR', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── The note outside the person's main chat ──────────────────────────────────

/**
 * `rows` without the Now files among their document hits (a search result
 * list: `result_type` 'document', `result_id` its id), for a caller outside the
 * person's main chat. One read, only when there are document hits. A failed
 * read drops every document hit (fail closed). Never throws.
 */
export async function dropNowDocuments<T extends { result_type: string; result_id: string }>(supabase: SupabaseClient, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.filter((r) => r.result_type === 'document').map((r) => r.result_id))]
  if (ids.length === 0) return rows
  try {
    const { data, error } = await supabase.from('document').select('id').in('id', ids).eq('kind', NOW_KEY)
    if (error) return rows.filter((r) => r.result_type !== 'document')
    const now = new Set(((data as Array<{ id?: unknown }> | null) ?? []).map((d) => d.id))
    return now.size === 0 ? rows : rows.filter((r) => !(r.result_type === 'document' && now.has(r.result_id)))
  } catch {
    return rows.filter((r) => r.result_type !== 'document')
  }
}
