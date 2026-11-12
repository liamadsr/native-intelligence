/**
 * What a Studio card tells the agent about its editor: the `studio` part of
 * its entry in the turn's cards (./context.ts, CardContextEntry). Which video
 * and page the person is on, the Studio project it is in, and on the edit
 * page the playhead, the delivery format, what is selected and whether the
 * editor holds edits not saved yet. So "make this bigger" names a layer of a
 * video without the person naming either.
 *
 *   Built   in the browser when a turn is sent, never before
 *           (components/studio/ui/chat-note.ts reads the editor's own state;
 *           the card adds the Studio project): nothing is reported per frame,
 *           per click or between turns, and what goes is what is on screen
 *           at that moment. Only while the card is in front
 *           (../../components/chat-cards/card-store.ts, provideLive).
 *   Small   ids, short labels and seconds, never the edit itself: at most
 *           MAX_STUDIO_PICKS selected things. The agent reads the video with
 *           get_studio_video.
 *   Checked on the server like every card field (parseStudioNote): anything
 *           malformed is dropped, and labels are quoted as data in the note.
 *           A layer's words and a clip's file name can be someone else's (a
 *           caption from an imported clip's speech, a file brought in from a
 *           link): they go inside the untrusted-content marker
 *           (lib/email/untrusted.ts), as mail and calendar rows do.
 *
 * Client-safe and pure.
 */
import { wrapUntrusted } from '@/lib/email/untrusted'

/** A video's pages, and `project` for the overview of the Studio project it is in. */
export const STUDIO_NOTE_PAGES = ['project', 'overview', 'storyboard', 'cast', 'edit'] as const
export type StudioNotePage = (typeof STUDIO_NOTE_PAGES)[number]

/** What can be selected in the editor. */
export const STUDIO_PICK_KINDS = ['layer', 'clip', 'beat', 'track', 'zoom'] as const
export type StudioPickKind = (typeof STUDIO_PICK_KINDS)[number]

/** One selected thing: its id, what it is, a short label, and where it sits on the timeline (seconds). */
export interface StudioPick {
  k: StudioPickKind
  id: string
  /** A layer's kind (text, box, arrow…), a track's (audio, motion). */
  kind?: string
  /** A layer's or a track's name, a clip's source, a beat's label. */
  label?: string
  /** A layer's words, when it has some. */
  text?: string
  from?: number
  to?: number
}

export interface StudioNote {
  /** The video open in the editor. */
  v: { id: string; title: string }
  page: StudioNotePage
  /** The Studio project the video is in (absent: none, or not known yet). */
  sp?: { id: string; title: string }
  /** The edit page: the playhead, in seconds. */
  t?: number
  /** The edit page: the delivery format, in words ("YouTube (16:9), 1920×1080 at 60 fps"). */
  fmt?: string
  /** What is selected, the most specific first. */
  sel?: StudioPick[]
  /** The editor holds edits that are not saved yet (the save before the turn did not go through). */
  dirty?: true
}

/** The most selected things a note names. */
export const MAX_STUDIO_PICKS = 6

const LIMITS = { id: 100, title: 120, label: 60, text: 80, kind: 24, fmt: 80 } as const

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? flat(value, max) : null
}

/** An id as the Studio writes them (uuids, `layer-…`, `beat-3`): nothing that could read as words. */
function idOf(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : null
}

/** Seconds, to a tenth, within a day. */
export function seconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 86_400) return null
  return Math.round(value * 10) / 10
}

function named(value: unknown): { id: string; title: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const id = idOf(v.id)
  const title = text(v.title, LIMITS.title)
  return id && title ? { id, title } : null
}

function parsePick(value: unknown): StudioPick | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!(STUDIO_PICK_KINDS as readonly string[]).includes(v.k as string)) return null
  const id = idOf(v.id)
  if (!id) return null
  const pick: StudioPick = { k: v.k as StudioPickKind, id }
  const kind = typeof v.kind === 'string' && /^[a-z][a-z0-9 -]{0,23}$/.test(v.kind) ? v.kind : null
  if (kind) pick.kind = kind
  const label = text(v.label, LIMITS.label)
  if (label) pick.label = label
  const words = text(v.text, LIMITS.text)
  if (words) pick.text = words
  const from = seconds(v.from)
  const to = seconds(v.to)
  if (from !== null && to !== null && to >= from) {
    pick.from = from
    pick.to = to
  }
  return pick
}

/** A Studio note as the client sent it, checked; null when it is not one. */
export function parseStudioNote(value: unknown): StudioNote | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const video = named(v.v)
  if (!video || !(STUDIO_NOTE_PAGES as readonly string[]).includes(v.page as string)) return null
  const note: StudioNote = { v: video, page: v.page as StudioNotePage }
  const sp = named(v.sp)
  if (sp) note.sp = sp
  const t = seconds(v.t)
  if (t !== null) note.t = t
  const fmt = text(v.fmt, LIMITS.fmt)
  if (fmt) note.fmt = fmt
  if (Array.isArray(v.sel)) {
    const sel = v.sel.slice(0, MAX_STUDIO_PICKS).map(parsePick).filter((p): p is StudioPick => p !== null)
    if (sel.length) note.sel = sel
  }
  if (v.dirty === true) note.dirty = true
  return note
}

const PAGE_WORDS: Record<StudioNotePage, string> = {
  project: 'its Studio project’s page',
  overview: 'the Overview page',
  storyboard: 'the Storyboard page',
  cast: 'the Cast page',
  edit: 'the Edit page (the timeline)',
}

const span = (p: StudioPick) => (p.from !== undefined && p.to !== undefined ? ` ${p.from}–${p.to} s` : '')

/** Text that may be someone else's (a layer's words, a clip's file name), fenced as data. */
const fenced = (text: string, kind: 'TRANSCRIPT' | 'FILE') => wrapUntrusted(text, kind)!

function describePick(p: StudioPick, quote: (text: string) => string): string {
  const label = p.label ? ` ${quote(p.label)}` : ''
  switch (p.k) {
    case 'layer':
      // Its words last, fenced: a caption's words can be what someone in an imported clip said.
      return `${p.kind ? `${p.kind} ` : ''}layer ${p.id}${label}${span(p)}${p.text ? ` saying ${fenced(p.text, 'TRANSCRIPT')}` : ''}`
    case 'clip':
      // Its source's file name, fenced: a file brought in from a link is named by whoever made it.
      return `clip ${p.id}${span(p)}${p.label ? ` from ${fenced(p.label, 'FILE')}` : ''}`
    case 'beat':
      return `storyboard beat ${p.id}${label}${span(p)}`
    case 'track':
      return `${p.kind ? `${p.kind} ` : ''}track ${p.id}${label}`
    case 'zoom':
      return `zoom ${p.id}${span(p)}`
  }
}

/**
 * The note's lines for a Studio card, indented under the card's head line
 * (context.ts fullLines). `quote` quotes a label as data. The last line is
 * the one instruction the agent needs for it.
 */
export function studioNoteLines(note: StudioNote, quote: (text: string) => string): string[] {
  const lines = [
    `  in the Studio: video ${quote(note.v.title)} (video_id ${note.v.id}), on ${PAGE_WORDS[note.page]}${note.sp ? `, in Studio project ${quote(note.sp.title)} (${note.sp.id})` : ''}`,
  ]
  const state = [
    note.t !== undefined ? `playhead at ${note.t} s` : null,
    note.fmt ? `format ${note.fmt}` : null,
    note.dirty ? 'the editor holds edits not saved yet (get_studio_video does not see them)' : null,
  ].filter((s): s is string => s !== null)
  if (state.length) lines.push(`  ${state.join(' · ')}`)
  if (note.sel?.length) lines.push(`  selected: ${note.sel.map((p) => describePick(p, quote)).join('; ')}`)
  lines.push(
    `  "this" and "here" mean this video${note.sel?.length ? ', the first thing selected' : ''}${note.t !== undefined ? ' and the playhead' : ''}: read it with get_studio_video before you edit it${note.sel?.length ? ' (pass ids with what is selected to get every value it has now)' : ''}.`,
  )
  return lines
}
