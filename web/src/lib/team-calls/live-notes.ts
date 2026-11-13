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
 *   - A meeting guest reads only the call's own words (657: the lines heard
 *     since they were let in, while they are in the room). Never the
 *     summary: even fenced (src/lib/live-agent/call-capture-fence.ts), the
 *     agent that writes it is the owner's, and its wording can carry the
 *     workspace's names (its members, labels, workflow states), so nothing
 *     in it can be promised to come from this call alone.
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

export interface LiveNotes {
  summary: string
  state: LiveNotesState | null
}

const PHASES: readonly LiveNotesPhase[] = ['working', 'ready', 'failed', 'stopped']

/** A team_call_live_notes row as the database (or Realtime) hands it over. */
export interface LiveNotesRow {
  summary?: string | null
  state?: string | null
  state_at?: string | null
  until?: string | null
  reason?: string | null
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
  return { summary: row.summary ?? '', state: liveNotesStateOf(row) }
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
      if (state.reason === 'call_ended') return null
      return 'Live notes paused for this call. The full notes are written when it ends.'
  }
}

/** Is there anything to show? A panel with nothing renders nothing. */
export function hasLiveNotes(notes: LiveNotes | null, now: number = Date.now()): boolean {
  if (!notes) return false
  if (summaryBlocks(notes.summary).length > 0) return true
  return liveNotesWriting(notes.state, now) || notes.state?.phase === 'failed' || (notes.state?.phase === 'stopped' && notes.state.reason !== 'call_ended')
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
