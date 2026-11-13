/**
 * A call's shared live notes, as the in-call panel shows them (phase 2). Pure,
 * for the server's route and the browser alike.
 *
 *   - Members of the call's conversation read the capture itself: its
 *     summary, which the live agent writes as people speak, and the agent's
 *     state (655's captures.metadata.live_notes), both on the capture's row,
 *     so Realtime brings every change to the panel as it brings the fed
 *     transcript to the capture page.
 *   - A meeting guest reads only the call's own words (657: the lines heard
 *     since they were let in). Never the summary: the agent that writes it
 *     also reads the workspace (its people, earlier meetings, documents), so
 *     nothing in it can be promised to come from this call alone.
 */

export type LiveNotesPhase = 'working' | 'ready' | 'failed' | 'stopped'

export interface LiveNotesState {
  phase: LiveNotesPhase
  /** When the agent last changed state (ISO). */
  at: string | null
  /** Why it stopped: 'bound', 'failing', 'usage', 'call_ended', 'owner_out', 'refused'. */
  reason: string | null
}

export interface LiveNotes {
  summary: string
  state: LiveNotesState | null
}

const PHASES: readonly LiveNotesPhase[] = ['working', 'ready', 'failed', 'stopped']

/** The agent's state from a capture's metadata, or null before its first turn. */
export function liveNotesStateOf(metadata: unknown): LiveNotesState | null {
  const raw = (metadata as { live_notes?: unknown } | null | undefined)?.live_notes as { state?: unknown; at?: unknown; reason?: unknown } | undefined
  if (!raw || typeof raw !== 'object') return null
  const phase = PHASES.find((p) => p === raw.state)
  if (!phase) return null
  return { phase, at: typeof raw.at === 'string' ? raw.at : null, reason: typeof raw.reason === 'string' ? raw.reason : null }
}

/** A capture row's live notes. */
export function liveNotesOf(row: { ai_summary?: string | null; metadata?: unknown }): LiveNotes {
  return { summary: row.ai_summary ?? '', state: liveNotesStateOf(row.metadata) }
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
    case 'working':
      return 'Writing as people speak…'
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
export function hasLiveNotes(notes: LiveNotes | null): boolean {
  if (!notes) return false
  if (summaryBlocks(notes.summary).length > 0) return true
  return notes.state?.phase === 'working' || notes.state?.phase === 'failed' || (notes.state?.phase === 'stopped' && notes.state.reason !== 'call_ended')
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
