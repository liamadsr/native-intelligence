/**
 * Team chat's composer and message text, pure and client-safe: where an
 * `@…` being typed starts, which picked mentions are still in the words, and
 * a message's words cut into plain text and @-mentions for drawing.
 */

/** The `@…` token being typed just before the caret: where its `@` is and what follows it; null when there is none. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upTo = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  // One word: the picker narrows on it ("@an" finds Ana Ruiz), and a space ends it.
  const match = /(^|\s)@([\p{L}\p{N}'.-]*)$/u.exec(upTo)
  if (!match) return null
  const query = match[2]
  return { start: upTo.length - query.length - 1, query }
}

/** The picked mentions whose `@label` is still in the words (an edit may have taken one out). Ids, deduplicated. */
export function mentionsStillIn(text: string, picked: ReadonlyArray<{ id: string; label: string }>): string[] {
  const out = new Set<string>()
  for (const p of picked) if (p.label && hasMention(text, p.label)) out.add(p.id)
  return [...out]
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function mentionPattern(label: string): RegExp {
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeForRegExp(label)}(?![\\p{L}\\p{N}_])`, 'iu')
}

/** True when the words hold `@label` as a whole mention. */
export function hasMention(text: string, label: string): boolean {
  return !!label && mentionPattern(label).test(text)
}

export interface TextSegment {
  text: string
  /** True for an `@label` of someone the message mentions. */
  mention: boolean
}

/**
 * A message's words cut into plain runs and `@label` mentions, for the labels
 * given (longest first, so `@Ana Ruiz` wins over `@Ana`). Matching ignores
 * case; the words keep their own.
 */
export function mentionSegments(body: string, labels: readonly string[]): TextSegment[] {
  const sorted = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length)
  if (sorted.length === 0 || !body.includes('@')) return body ? [{ text: body, mention: false }] : []
  const re = new RegExp(`@(?:${sorted.map(escapeForRegExp).join('|')})(?![\\p{L}\\p{N}_])`, 'giu')
  const out: TextSegment[] = []
  let last = 0
  for (const m of body.matchAll(re)) {
    const at = m.index ?? 0
    const prev = at > 0 ? body[at - 1] : ''
    if (prev && /[\p{L}\p{N}_]/u.test(prev)) continue
    if (at > last) out.push({ text: body.slice(last, at), mention: false })
    out.push({ text: m[0], mention: true })
    last = at + m[0].length
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false })
  return out
}

/** A message's time, as the list shows it: "3:04 PM". */
export function messageTime(iso: string, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
}

/** True when two messages in a row are from the same author within five minutes (the second drops its name line). */
export function continuesGroup(
  prev: { author_kind: string; author_member_id: string | null; agent_for_member_id: string | null; created_at: string } | undefined,
  next: { author_kind: string; author_member_id: string | null; agent_for_member_id: string | null; created_at: string },
): boolean {
  if (!prev) return false
  if (prev.author_kind !== next.author_kind) return false
  if (prev.author_member_id !== next.author_member_id || prev.agent_for_member_id !== next.agent_for_member_id) return false
  const gap = Date.parse(next.created_at) - Date.parse(prev.created_at)
  return Number.isFinite(gap) && gap >= 0 && gap < 5 * 60_000
}
