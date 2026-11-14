/**
 * Team call notes and recordings (calls plan, phase 6, migrations 566-567),
 * the shared vocabulary: pure and client-safe.
 *
 * Notes: while a call's notes are on, LiveKit Egress writes each person's
 * microphone to a file of its own (a "track egress", audio only, Opus in
 * Ogg). Each file is one known speaker, so nobody guesses who spoke: when
 * the call ends, each file is transcribed (Deepgram, prerecorded) and the
 * words are placed in the call by when their file began
 * ({@link mergeNotes}). A muted microphone keeps its file running (LiveKit
 * Egress fills the gaps in an Opus track with silence), a republished one
 * (a reconnect) starts a new file at its own place, so the times hold.
 * The merged transcript becomes a capture like a recorded meeting's.
 *
 * Where the call recorder takes the notes instead (TEAM_CALL_RECORDER=on,
 * ./recorder.ts), the same capture fills in while the call goes on, and
 * mergeNotes writes it once more at the end in the order things were said.
 *
 * Recording: one video file of the whole call (a "room composite" egress),
 * only where the server allows it (TEAM_CALL_RECORDING=on).
 */

/** A call's notes stop for good at this much audio (567's 10800). */
export const TEAM_CALL_NOTES_MAX_SECONDS = 3 * 60 * 60
/** A recording stops at this length (the sweeper stops it; LiveKit Egress stops any file at 4 hours). */
export const TEAM_CALL_RECORDING_MAX_SECONDS = 2 * 60 * 60
/** The private bucket the egress files are written to (566). */
export const TEAM_CALL_RECORDINGS_BUCKET = 'team-call-recordings'
/** How long a link to a recording lives (the page asks for a new one each time it plays). */
export const TEAM_CALL_RECORDING_URL_TTL_SECONDS = 60 * 60

export type TeamCallNotesState = 'none' | 'capturing' | 'transcribing' | 'ready' | 'silent' | 'failed'
export type TeamCallRecordingState = 'off' | 'starting' | 'on' | 'saved' | 'failed'
export type TeamCallEgressStatus = 'starting' | 'active' | 'ending' | 'complete' | 'failed' | 'aborted' | 'limit'
export type TeamCallTranscriptStatus = 'pending' | 'done' | 'empty' | 'failed' | 'none'

const FINISHED: ReadonlySet<TeamCallEgressStatus> = new Set(['complete', 'failed', 'aborted', 'limit'])

/** An egress that will change no more. */
export function egressFinished(status: TeamCallEgressStatus): boolean {
  return FINISHED.has(status)
}

/** LiveKit's EgressStatus (its enum's numbers) as 566's words. */
export function egressStatusOf(status: number | undefined | null): TeamCallEgressStatus {
  switch (status) {
    case 1:
      return 'active'
    case 2:
      return 'ending'
    case 3:
      return 'complete'
    case 4:
      return 'failed'
    case 5:
      return 'aborted'
    case 6:
      return 'limit'
    default:
      return 'starting'
  }
}

/** What a call's page knows of its notes and recording (team_call's columns). */
export interface TeamCallNotesView {
  notes: boolean
  notes_by: string | null
  notes_state: TeamCallNotesState
  capture_id: string | null
  recording: TeamCallRecordingState
  recording_by: string | null
}

/** What the server allows here: the controls show only for what is on. */
export interface TeamCallFeatures {
  notes: boolean
  recording: boolean
  /**
   * The notes are the call recorder's (src/lib/team-calls/recorder.ts): heard
   * as they are said, into a capture that fills in live. A mute only mutes
   * (no notes file to end), and the microphone keeps its DTX. False: the
   * notes are LiveKit Egress's files, transcribed after the call.
   */
  liveNotes?: boolean
  /**
   * The live agent writes shared notes during the call, on the server
   * (src/lib/team-calls/live-turns.ts): everyone in it can open them. Only
   * where the recorder takes the notes.
   */
  liveAgent?: boolean
}

export const NO_CALL_FEATURES: TeamCallFeatures = { notes: false, recording: false, liveNotes: false }

/**
 * Joining waits for the person (their microphone held back until they say
 * go) when the call is being recorded, or its notes are Egress's and on by
 * someone else's doing (a starter whose own Auto-record setting turned them
 * on is not stopped by a notice about their own choice). The call
 * recorder's notes (`liveNotes`) hold no member back: being on the platform
 * is agreeing to its calls being captured, and every call takes notes from
 * its start; the "Notes are on" badge says so. A meeting link's guests keep
 * their notice and their go (src/lib/meeting-links/consent.ts).
 */
export function holdMicOnJoin(call: {
  memberId: string
  notes: Pick<TeamCallNotesView, 'notes' | 'notes_by' | 'recording'>
  features?: Pick<TeamCallFeatures, 'liveNotes'> | null
}): boolean {
  const notesByOthers = call.features?.liveNotes !== true && call.notes.notes && call.notes.notes_by !== call.memberId
  const recording = call.notes.recording === 'starting' || call.notes.recording === 'on'
  return notesByOthers || recording
}

/**
 * Does a new call start with its notes on? Every call does, where the call
 * recorder takes the notes (decided here on the server, whoever starts it and
 * from whatever client). Where Egress takes them, only when the starter asked
 * (the desktop app's "Auto-record meetings").
 */
export function newCallTakesNotes(features: TeamCallFeatures, starterAsked: unknown): boolean {
  if (!features.notes) return false
  return features.liveNotes === true || starterAsked === true
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const FILE = new RegExp(`^(${UUID})/(${UUID})/(notes|recording)/(${UUID})\\.(ogg|mp4)$`, 'i')

/** The row an egress file is (567 names each `<channel>/<call>/<notes|recording>/<row>.<ext>`), or null for any other name. */
export function egressRowOfPath(path: string | null | undefined): { channelId: string; callId: string; kind: 'notes' | 'recording'; rowId: string } | null {
  const m = path ? FILE.exec(path) : null
  if (!m) return null
  return { channelId: m[1].toLowerCase(), callId: m[2].toLowerCase(), kind: m[3].toLowerCase() as 'notes' | 'recording', rowId: m[4].toLowerCase() }
}

// ── The transcript ──────────────────────────────────────────────────────────

/** One stretch of speech in one file, in seconds from the file's start; its words with their own times, to cut it at the moment notes went off. */
export interface NotesUtterance {
  start: number
  end: number
  text: string
  /** [word, start, end], seconds from the file's start. */
  words?: Array<[string, number, number]>
}

/** One microphone's file: whose it is, when it began, what was said in it. */
export interface NotesFile {
  memberId: string
  /** When the file began (ISO): its words' place in the call. */
  startedAt: string
  utterances: NotesUtterance[]
  /** When notes went off for this file's round (or the call ended), ISO: nothing said after it reaches the notes. */
  cutoffAt?: string | null
}

export interface NotesLine {
  /** Seconds from the call's start. */
  at: number
  end: number
  memberId: string
  label: string
  text: string
}

/** The longest a speaker label is (a transcript line's `[label]`, quote-speakers' 40). */
const LABEL_MAX = 40
/** Two stretches of one speaker this close together, with nobody between, are one line. */
const JOIN_GAP_SECONDS = 1.5

/**
 * Each person's speaker label: their name, unique within the call ("Rosa
 * Lind", "Rosa Lind (2)"), without the brackets a transcript line opens with.
 */
export function speakerLabels(people: ReadonlyArray<{ memberId: string; name: string | null | undefined }>): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const p of people) {
    if (out.has(p.memberId)) continue
    const base = (p.name ?? '').replace(/[[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX - 4) || 'Teammate'
    let label = base
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`
    used.add(label.toLowerCase())
    out.set(p.memberId, label)
  }
  return out
}

/**
 * The call's words in the order they were said: each file's stretches,
 * placed by the file's start relative to the call's start. Overlapping
 * speech stays as said (each line where it began); a late joiner's file
 * begins late; a republished microphone is a second file at its own place.
 * A speaker's stretches with nobody between them, close together, are one
 * line. Lines are `[label] words`, the transcript format captures use.
 */
export function mergeNotes(callStartedAt: string, files: readonly NotesFile[], labels: ReadonlyMap<string, string>): { lines: NotesLine[]; text: string } {
  const t0 = Date.parse(callStartedAt)
  const all: NotesLine[] = []
  for (const file of files) {
    const fileStart = Date.parse(file.startedAt)
    const offset = Math.max(0, (fileStart - t0) / 1000)
    if (!Number.isFinite(offset)) continue
    const label = labels.get(file.memberId) ?? 'Teammate'
    // The moment notes went off, in this file's own time: nothing said after it is kept.
    const cutoff = file.cutoffAt ? (Date.parse(file.cutoffAt) - fileStart) / 1000 : Number.POSITIVE_INFINITY
    for (const raw of file.utterances) {
      const u = cutUtterance(raw, cutoff)
      if (!u) continue
      const text = u.text.replace(/\s+/g, ' ').trim()
      if (!text || !Number.isFinite(u.start)) continue
      const start = Math.max(0, u.start)
      all.push({ at: offset + start, end: offset + Math.max(start, Number.isFinite(u.end) ? u.end : start), memberId: file.memberId, label, text })
    }
  }
  all.sort((a, b) => a.at - b.at || a.end - b.end || a.label.localeCompare(b.label))
  const lines: NotesLine[] = []
  for (const line of all) {
    const last = lines[lines.length - 1]
    if (last && last.memberId === line.memberId && line.at - last.end <= JOIN_GAP_SECONDS) {
      last.text = `${last.text} ${line.text}`
      last.end = Math.max(last.end, line.end)
    } else {
      lines.push({ ...line })
    }
  }
  return { lines, text: lines.map((l) => `[${l.label}] ${l.text}`).join('\n') }
}

/**
 * A stretch as it stands at the cutoff (file time): whole before it; cut at
 * its last word before it when it runs past; gone when it began after it,
 * or runs past it with no word times to cut by (never a word too many).
 */
export function cutUtterance(u: NotesUtterance, cutoff: number): NotesUtterance | null {
  if (!Number.isFinite(cutoff)) return u
  if (!(u.start < cutoff)) return null
  if (!(u.end > cutoff)) return u
  const words = (u.words ?? []).filter((w) => w[1] < cutoff)
  if (!u.words || words.length === 0) return null
  return { start: u.start, end: Math.min(cutoff, words[words.length - 1][2]), text: words.map((w) => w[0]).join(' '), words }
}

/** Deepgram's prerecorded answer (utterances=true) as a file's stretches. */
export function utterancesOfDeepgram(json: unknown): NotesUtterance[] {
  const list = (json as { results?: { utterances?: unknown } } | null)?.results?.utterances
  if (!Array.isArray(list)) return []
  const out: NotesUtterance[] = []
  for (const u of list as Array<{ start?: unknown; end?: unknown; transcript?: unknown; words?: unknown }>) {
    if (typeof u?.start !== 'number' || typeof u.transcript !== 'string') continue
    const text = u.transcript.trim()
    if (!text) continue
    const words: Array<[string, number, number]> = []
    for (const w of Array.isArray(u.words) ? (u.words as Array<{ word?: unknown; punctuated_word?: unknown; start?: unknown; end?: unknown }>) : []) {
      const word = typeof w?.punctuated_word === 'string' ? w.punctuated_word : typeof w?.word === 'string' ? w.word : null
      if (word && typeof w.start === 'number' && typeof w.end === 'number') words.push([word, w.start, w.end])
    }
    out.push({ start: u.start, end: typeof u.end === 'number' ? u.end : u.start, text, ...(words.length ? { words } : {}) })
  }
  return out
}

/** The notes' title, from the conversation: "Call in #launch", "Call with Rosa Lind" (a DM, named for its other person), a meeting's own title. */
export function notesTitle(place: { kind: 'channel' | 'dm' | 'meeting'; name: string | null; otherName?: string | null }): string {
  if (place.kind === 'channel') return `Call in #${(place.name ?? '').trim() || 'channel'}`
  if (place.kind === 'meeting') return (place.name ?? '').trim() || 'Meeting'
  const other = place.otherName?.trim()
  return other ? `Call with ${other}` : 'Call'
}

/** Why a person's words are not in the notes. */
export type NotesGap = 'not_recorded' | 'not_transcribed'

/** The line a capture's notes open with when someone is missing, or notes were on for only part of the call. */
export function notesPreamble(input: {
  missing: ReadonlyArray<{ name: string; why: NotesGap }>
  notesSeconds: number
  callSeconds: number
  stoppedAtBound: boolean
}): string {
  const parts: string[] = []
  const lost = input.missing.filter((m) => m.why === 'not_recorded').map((m) => m.name)
  const untranscribed = input.missing.filter((m) => m.why === 'not_transcribed').map((m) => m.name)
  if (lost.length) parts.push(`Not in these notes: ${listOf(lost)} (their audio could not be recorded).`)
  if (untranscribed.length) parts.push(`Not in these notes: ${listOf(untranscribed)} (their audio could not be transcribed; it is kept).`)
  if (input.stoppedAtBound) parts.push(`Notes stopped after ${Math.round(TEAM_CALL_NOTES_MAX_SECONDS / 3600)} hours.`)
  else if (input.callSeconds > 0 && input.notesSeconds + 60 < input.callSeconds) {
    parts.push(`Notes were on for ${minutes(input.notesSeconds)} of the ${minutes(input.callSeconds)} call.`)
  }
  return parts.join('\n')
}

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function minutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60))
  return `${m} min`
}
