/**
 * A call's shared live notes, as the in-call panel shows them (phase 2). Pure,
 * for the server's route and the browser alike.
 *
 *   - Members of the call's conversation read 655's team_call_live_notes row:
 *     the summary the live agent last wrote and its state, small on purpose.
 *     The panel follows that row over Realtime, not the capture's own row,
 *     which carries the whole transcript and changes with every batch of
 *     words. The row is read only by who may read the capture (its policy
 *     asks the capture, under 566's conversation fence).
 *   - A meeting guest reads the call's own words (657: the lines heard
 *     since they were let in, while they are in the room) and, since
 *     2026-11-18 (the owner's decision), the agent's notes of the call as
 *     plain blocks of text (guestSummaryOf below). The agent that writes
 *     them is fenced on a call's capture
 *     (src/lib/live-agent/call-capture-fence.ts): it holds no private read,
 *     only the workspace's structure (its members, labels, workflow states),
 *     so those names can turn up in what a guest reads. The notes are of the
 *     whole call: unlike the lines, they can say what was said before the
 *     guest was let in. A guest gets the words alone: no markdown, no link
 *     address, no proposal anchor, no state, and none while they are out of
 *     the room (the lines keep 657's 30 seconds of grace for a reconnect;
 *     the notes do not).
 *   - When the call's words are not being written (668: the recorder says so
 *     with its heartbeat, the sweeper when the recorder went quiet), members
 *     read one plain line saying why, on the same row, until it recovers. A
 *     guest never does (of this row they are given the summary's words only).
 */

export type LiveNotesPhase = 'working' | 'ready' | 'failed' | 'stopped'

export interface LiveNotesState {
  phase: LiveNotesPhase
  /** When the agent last changed state (ISO). */
  at: string | null
  /** While working: when the running turn's lease runs out (ISO). Past it, nothing is still writing. */
  until?: string | null
  /** Why it stopped: 'bound', 'failing', 'usage', 'call_ended', 'owner_out', 'refused'. */
  reason: string | null
}

/** Why the call's words are not being written now (668's feed_state); null while they are. */
export type FeedHealthState = 'down' | 'refused' | 'no_credit' | 'no_words' | 'lost'

export interface LiveNotes {
  summary: string
  state: LiveNotesState | null
  /** Why the call's words are not being written now, or null (absent: the same). */
  feed?: FeedHealthState | null
}

const FEED_STATES: readonly FeedHealthState[] = ['down', 'refused', 'no_credit', 'no_words', 'lost']

const PHASES: readonly LiveNotesPhase[] = ['working', 'ready', 'failed', 'stopped']

/** A team_call_live_notes row as the database (or Realtime) hands it over. */
export interface LiveNotesRow {
  summary?: string | null
  state?: string | null
  state_at?: string | null
  until?: string | null
  reason?: string | null
  feed_state?: string | null
}

/** Why the call's words are not being written, from a live notes row (null while they are). */
export function feedHealthOf(row: LiveNotesRow | null | undefined): FeedHealthState | null {
  return FEED_STATES.find((f) => f === row?.feed_state) ?? null
}

/** The line the members read while the call's words are not being written, or null. */
export function feedHealthLine(feed: FeedHealthState | null | undefined): string | null {
  switch (feed) {
    case 'down':
      return 'Notes aren’t being written right now: the transcription service isn’t answering. Trying again…'
    case 'refused':
      return 'Notes aren’t being written right now: the transcription service refused our key.'
    case 'no_credit':
      return 'Notes aren’t being written right now: the transcription account is out of credit.'
    case 'no_words':
      return 'Notes aren’t being written right now: people are speaking, but no words are coming back.'
    case 'lost':
      return 'Notes aren’t being written right now: the note taker lost its connection.'
    default:
      return null
  }
}

/** The agent's state from a live notes row, or null before its first turn ('idle'). */
export function liveNotesStateOf(row: LiveNotesRow | null | undefined): LiveNotesState | null {
  if (!row) return null
  const phase = PHASES.find((p) => p === row.state)
  if (!phase) return null
  return { phase, at: row.state_at ?? null, until: row.until ?? null, reason: row.reason ?? null }
}

/** A live notes row's notes. */
export function liveNotesOf(row: LiveNotesRow): LiveNotes {
  return { summary: row.summary ?? '', state: liveNotesStateOf(row), feed: feedHealthOf(row) }
}

/** Is the agent writing now: working, and its running turn's lease not run out (a dead process never writes for ever)? */
export function liveNotesWriting(state: LiveNotesState | null, now: number = Date.now()): boolean {
  if (state?.phase !== 'working') return false
  const until = state.until ? Date.parse(state.until) : Number.NaN
  return !Number.isFinite(until) || until > now
}

export type SummaryBlock = { kind: 'heading' | 'bullet' | 'text'; text: string }

/** Inline markdown the panel shows as plain words: emphasis, code, links' text, the proposal anchors. */
function plain(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The summary as the panel draws it: headings, bullets and lines of text, in
 * order. Small on purpose (the full capture opens beside the call); an empty
 * bullet (its anchor alone) is left out.
 */
export function summaryBlocks(markdown: string): SummaryBlock[] {
  const out: SummaryBlock[] = []
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      const text = plain(heading[1])
      if (text) out.push({ kind: 'heading', text })
      continue
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (bullet) {
      const text = plain(bullet[1])
      if (text) out.push({ kind: 'bullet', text })
      continue
    }
    const text = plain(line)
    if (text) out.push({ kind: 'text', text })
  }
  return out
}

/** How long ago, in plain words. */
function ago(at: string | null, now: number): string | null {
  if (!at) return null
  const ms = now - Date.parse(at)
  if (!Number.isFinite(ms)) return null
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1 minute ago'
  if (minutes < 60) return `${minutes} minutes ago`
  return 'over an hour ago'
}

/** The panel's one status line, or null when there is nothing to say. */
export function liveNotesStatusLine(state: LiveNotesState | null, now: number = Date.now()): string | null {
  if (!state) return null
  switch (state.phase) {
    case 'working': {
      if (liveNotesWriting(state, now)) return 'Writing as people speak…'
      // Its turn's lease ran out (a process that died mid-turn): say when they last changed, not "writing".
      const when = ago(state.at, now)
      return when ? `Updated ${when}` : null
    }
    case 'ready': {
      const when = ago(state.at, now)
      return when ? `Updated ${when}` : 'Up to date'
    }
    case 'failed':
      return 'Couldn’t update just now. The next update catches up.'
    case 'stopped':
      // Why, in plain words: the line the members read in place of a summary that stopped changing.
      switch (state.reason) {
        case 'call_ended':
          return null
        case 'usage':
          return 'The live summary stopped: the host’s plan has run out of AI usage.'
        case 'failing':
          return 'The live summary stopped after repeated errors. The words are still written down.'
        case 'refused':
        case 'owner_out':
          return 'The live summary stopped: the host can no longer write these notes.'
        case 'bound':
          return 'The live summary reached its limit for this call. The full notes are written when it ends.'
        default:
          return 'Live notes paused for this call. The full notes are written when it ends.'
      }
  }
}

/** Is there anything to show? A panel with nothing renders nothing. */
export function hasLiveNotes(notes: LiveNotes | null, now: number = Date.now()): boolean {
  if (!notes) return false
  if (notes.feed) return true
  if (summaryBlocks(notes.summary).length > 0) return true
  return liveNotesWriting(notes.state, now) || notes.state?.phase === 'failed' || (notes.state?.phase === 'stopped' && notes.state.reason !== 'call_ended')
}

/** The most blocks of the agent's notes one guest read carries, and the longest one. */
export const GUEST_SUMMARY_MAX_BLOCKS = 80
export const GUEST_SUMMARY_MAX_BLOCK_CHARS = 600

/**
 * The agent's notes as a meeting guest reads them: the summary's headings,
 * bullets and lines as plain words (summaryBlocks drops the markdown, the
 * links' addresses and the proposal anchors), bounded. Made on the server, so
 * the raw summary never leaves it for a guest.
 */
export function guestSummaryOf(markdown: string | null | undefined): SummaryBlock[] {
  // Stricter than the members' panel, before the lines are split: comments (an anchor can run over
  // lines), images, links' and reference definitions' addresses, tags and autolinks, bare addresses.
  const cleaned = (markdown ?? '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/!\[([^\]]*)\]\([^)\n]*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
    .replace(/^\s*\[[^\]\n]+\]:.*$/gm, '')
    .replace(/<[^>\n]*>/g, '')
    .replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi, '')
  return summaryBlocks(cleaned)
    .slice(0, GUEST_SUMMARY_MAX_BLOCKS)
    .map((b) => ({ kind: b.kind, text: b.text.slice(0, GUEST_SUMMARY_MAX_BLOCK_CHARS) }))
}

/** A guest's notes from the route's answer: only the two fields a block may carry. */
export function guestSummaryBlocksOf(raw: unknown): SummaryBlock[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((b) => {
    const r = (b ?? {}) as { kind?: unknown; text?: unknown }
    return (r.kind === 'heading' || r.kind === 'bullet' || r.kind === 'text') && typeof r.text === 'string' && r.text ? [{ kind: r.kind, text: r.text }] : []
  })
}

/** A line a guest sees: who said it, and what. */
export interface GuestNoteLine {
  at: string
  speaker: string
  text: string
}

/** A guest's lines from 657's answer, only the three fields it may carry. */
export function guestLinesOf(raw: unknown): GuestNoteLine[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((l) => {
    const r = l as { at?: unknown; speaker?: unknown; text?: unknown }
    return typeof r.at === 'string' && typeof r.speaker === 'string' && typeof r.text === 'string' ? [{ at: r.at, speaker: r.speaker, text: r.text }] : []
  })
}

/** How long after a call's notes were locked "Finishing the notes…" may show (a pass that never finished stops claiming to). */
export const CALL_NOTES_FINISHING_FOR_MS = 30 * 60_000

/**
 * Is a call's capture between its lock and its finished notes (src/lib/inngest/team-call-notes.ts:
 * ended, its end-of-meeting pass not done yet)? The capture's own page says "Finishing the notes…"
 * then, with the live summary still there to read; a capture that is no call's never.
 */
export function callNotesFinishing(
  capture: { notes_channel_id?: string | null; ended_at?: string | null; batch_processed_at?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  // The pass stamps batch_processed_at when it is done (the batch's finalize, or, nothing said, the index's).
  if (!capture || typeof capture.notes_channel_id !== 'string' || !capture.notes_channel_id || capture.batch_processed_at) return false
  const ended = capture.ended_at ? Date.parse(capture.ended_at) : Number.NaN
  return Number.isFinite(ended) && now - ended >= 0 && now - ended < CALL_NOTES_FINISHING_FOR_MS
}
