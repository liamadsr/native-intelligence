/**
 * The meeting's words as the person's notes (roadmap #12,
 * docs/plans/agent-joins-meetings.md §4). A dial-in hears the meeting as one
 * mixed line, so everyone in it is one speaker, "Meeting"; the assistant's own
 * words are its own. The lines are the capture's transcript format
 * (`[Label] words`), so the capture's finishing pass (summary, action items,
 * decisions) reads them as any meeting's. Pure.
 */

/** The label everyone on the meeting's line gets (one mixed phone line: no names). */
export const MEETING_SPEAKER = 'Meeting'

/** A pause this long starts a new line. */
export const LINE_GAP_MS = 2_500
/** The most a transcript keeps (about 3 hours of talk); past it, the newest words are dropped and the notes say so. */
export const NOTES_MAX_CHARS = 400_000

type Who = 'meeting' | 'assistant'

interface Line {
  who: Who
  text: string
  lastEndMs: number | null
}

export class MeetingNotes {
  private lines: Line[] = []
  private chars = 0
  truncated = false

  constructor(private readonly assistantLabel: string) {}

  add(who: Who, delta: unknown, startMs: unknown, endMs: unknown): void {
    if (typeof delta !== 'string' || !delta) return
    if (this.chars + delta.length > NOTES_MAX_CHARS) {
      this.truncated = true
      return
    }
    const start = typeof startMs === 'number' && Number.isFinite(startMs) ? startMs : null
    const end = typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : start
    const last = this.lines.at(-1)
    const gap = last && last.lastEndMs != null && start != null ? start - last.lastEndMs : 0
    if (last && last.who === who && gap < LINE_GAP_MS) {
      last.text += delta
      if (end != null) last.lastEndMs = end
    } else {
      this.lines.push({ who, text: delta, lastEndMs: end })
    }
    this.chars += delta.length
  }

  /** The last `max` characters the meeting said (the hand-off's context). */
  recentMeetingWords(max: number): string {
    let out = ''
    for (let i = this.lines.length - 1; i >= 0 && out.length < max; i--) {
      if (this.lines[i].who === 'meeting') out = `${this.lines[i].text.trim()} ${out}`
    }
    return out.trim().slice(-max)
  }

  /** The transcript, `[Label] words` per line; '' when nothing was said. */
  transcript(): string {
    const body = this.lines
      .map((l) => ({ label: l.who === 'meeting' ? MEETING_SPEAKER : this.assistantLabel, text: l.text.replace(/\s+/g, ' ').trim() }))
      .filter((l) => l.text)
      .map((l) => `[${l.label}] ${l.text}`)
    if (this.truncated) body.push(`[${this.assistantLabel}] (The rest of the meeting was too long to keep in these notes.)`)
    return body.join('\n')
  }

  /** Whether anyone but the assistant said anything. */
  meetingSpoke(): boolean {
    return this.lines.some((l) => l.who === 'meeting' && l.text.trim())
  }
}

/** What the notes open with: who took them and how, so nobody mistakes them for the person's own. Pure. */
export function notesPreamble(args: { assistantLabel: string; firstName: string; ended: 'ended' | 'objected' | 'cut' }): string {
  const how = `[${args.assistantLabel}] These notes were taken by ${args.firstName}'s AI assistant, who attended by phone for ${args.firstName}. Everyone on the meeting's line is "${MEETING_SPEAKER}": a phone line can't tell voices apart.`
  if (args.ended === 'objected') return `${how} Someone objected to the assistant being there, so it left and the notes stop there.`
  if (args.ended === 'cut') return `${how} The assistant had to leave before the meeting ended (its time limit).`
  return how
}
