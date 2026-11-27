/**
 * The brief: what the agent may do in a meeting for the person (roadmap #12,
 * docs/plans/agent-joins-meetings.md §3). Its goals, the facts it may share,
 * the questions it should ask, and what it must not agree to. The person
 * approves it, and the agent speaks from nothing else: a meeting's hand-off
 * is answered from the brief alone (./meeting-turn.ts), never from the
 * person's workspace. Pure and client-safe.
 */

export const BRIEF_FIELDS = ['goals', 'may_share', 'ask', 'must_not_agree'] as const
export type BriefField = (typeof BRIEF_FIELDS)[number]

export type MeetingBrief = Record<BriefField, string[]>

/** At most this many lines per field, each at most this long (refused, never cut). */
export const BRIEF_MAX_ITEMS = 10
export const BRIEF_MAX_CHARS = 300

/**
 * What the agent never agrees to, whatever the brief says. Liam's rule for
 * the feature (11-27, via the plan): "It never commits money, dates or
 * decisions beyond that brief". These always ride along.
 */
export const ALWAYS_MUST_NOT_AGREE = [
  'Any payment, price, discount, budget or other money commitment.',
  'Any date, deadline or meeting time.',
  'Any decision, signature, contract or approval for the person.',
] as const

export const EMPTY_BRIEF: MeetingBrief = { goals: [], may_share: [], ask: [], must_not_agree: [] }

export type BriefParse = { ok: true; brief: MeetingBrief } | { ok: false; field: BriefField | null; reason: 'not_object' | 'not_list' | 'too_many' | 'too_long' | 'not_text' }

function line(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A brief from what the person (or the chat tool) sent: every field a list of
 * short lines, blanks and repeats dropped. A missing field is empty. Refuses
 * anything over the limits rather than cutting it: the person approves exactly
 * what will be used.
 */
export function parseBrief(raw: unknown): BriefParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: null, reason: 'not_object' }
  const input = raw as Record<string, unknown>
  const brief: MeetingBrief = { goals: [], may_share: [], ask: [], must_not_agree: [] }
  for (const field of BRIEF_FIELDS) {
    const value = input[field]
    if (value == null) continue
    if (!Array.isArray(value)) return { ok: false, field, reason: 'not_list' }
    const seen = new Set<string>()
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, field, reason: 'not_text' }
      const text = line(item)
      if (!text) continue
      if (text.length > BRIEF_MAX_CHARS) return { ok: false, field, reason: 'too_long' }
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      brief[field].push(text)
    }
    if (brief[field].length > BRIEF_MAX_ITEMS) return { ok: false, field, reason: 'too_many' }
  }
  return { ok: true, brief }
}

/** A brief with nothing to attend for: no goal and no question. */
export function briefIsEmpty(brief: MeetingBrief): boolean {
  return brief.goals.length === 0 && brief.ask.length === 0
}

/** Two briefs say the same (an approval holds only for the brief it was given on). */
export function sameBrief(a: MeetingBrief, b: MeetingBrief): boolean {
  return BRIEF_FIELDS.every((f) => a[f].length === b[f].length && a[f].every((x, i) => x === b[f][i]))
}

/** The brief as the agent reads it, the always-on limits included. */
export function briefText(brief: MeetingBrief): string {
  const section = (title: string, items: readonly string[]) => (items.length ? `${title}:\n${items.map((i) => `- ${i}`).join('\n')}` : `${title}: (none)`)
  return [
    section('Goals', brief.goals),
    section('Facts you may share', brief.may_share),
    section('Questions to ask', brief.ask),
    section('Never agree to', [...brief.must_not_agree, ...ALWAYS_MUST_NOT_AGREE]),
  ].join('\n\n')
}
