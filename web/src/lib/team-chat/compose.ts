/**
 * Team chat's composer and message text, pure and client-safe: where an
 * `@…` being typed starts, which picked mentions are still in the words, and
 * a message's words cut into plain text and @-mentions for drawing. And the
 * page's lists (migrations 555-557): a send's optimistic bubble reconciled
 * with its row, reactions grouped into chips, a thread's labels and the
 * typing line.
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

/**
 * A link as typed, without what the sentence put after it: trailing
 * punctuation, and a closing bracket the link didn't open ("(see
 * https://x.test/a_(b))" keeps its own pair).
 */
export function trimLinkEnd(url: string): string {
  let out = url
  const count = (ch: string) => out.split(ch).length - 1
  for (;;) {
    const last = out.at(-1) ?? ''
    const open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[last]
    if (last && '.,;:!?'.includes(last)) out = out.slice(0, -1)
    else if (open && count(last) > count(open)) out = out.slice(0, -1)
    else break
  }
  return out
}

export interface TextRun {
  text: string
  /** Set for an http(s) link: where it goes (never another scheme). */
  href?: string
}

/** Plain words cut into text and http(s) links, for drawing links as links. */
export function linkRuns(text: string): TextRun[] {
  const out: TextRun[] = []
  let last = 0
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const at = m.index ?? 0
    const url = trimLinkEnd(m[0])
    let href: string | null = null
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') href = parsed.href
    } catch {
      href = null
    }
    if (!href) continue
    if (at > last) out.push({ text: text.slice(last, at) })
    out.push({ text: url, href })
    last = at + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
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

// ── The page's lists: optimistic sends, reactions, threads, typing ──────────

/** A message as the page holds it: a row, or its own send still on its way (`pending`). */
export interface ShownMessage {
  id: string
  client_id: string | null
  created_at: string
  /** Its own send, not yet stored: on its way, or failed (Retry sends it again, with the same client id). */
  pending?: 'sending' | 'failed'
}

/** The id an optimistic bubble goes by until its row arrives. */
export function pendingMessageId(clientId: string): string {
  return `pending:${clientId}`
}

/** The key a message is drawn under: its send's client id when it has one, so the bubble and its row are one element (no flicker). */
export function messageKey(message: Pick<ShownMessage, 'id' | 'client_id'>): string {
  return message.client_id ?? message.id
}

/** Oldest first; a send still on its way (or failed) after every stored row, as it was typed last. */
export function sortMessages<T extends ShownMessage>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.created_at.localeCompare(b.created_at))
}

/**
 * A message into the page's list: its row replaces the optimistic bubble of
 * the same send (by client id) or the row it already had (by id), and a new
 * one takes its place by time. The row (from the answer or from Realtime,
 * whichever comes first) wins over the bubble; a second copy of the row only
 * refreshes it, never adds one. A bubble never replaces a stored row.
 */
export function upsertMessage<T extends ShownMessage>(list: readonly T[] | undefined, message: T): T[] {
  const prev = list ?? []
  const at = prev.findIndex((m) => m.id === message.id || (!!message.client_id && m.client_id === message.client_id))
  if (at === -1) return sortMessages([...prev, message])
  if (message.pending && !prev[at].pending) return [...prev]
  const next = [...prev]
  next[at] = message
  return prev[at].pending && !message.pending ? sortMessages(next) : next
}

/** A send's bubble marked failed (Retry); the list as it was when its row has already arrived. */
export function failPending<T extends ShownMessage>(list: readonly T[] | undefined, clientId: string): T[] {
  return (list ?? []).map((m) => (m.client_id === clientId && m.pending ? { ...m, pending: 'failed' as const } : m))
}

export interface ReactionLike {
  message_id: string
  member_id: string
  emoji: string
  active: boolean
}

/** One reaction into a message's list (the reactions that are on): taken back, it leaves; on, it is there once. */
export function applyReaction<T extends ReactionLike>(list: readonly T[] | undefined, reaction: T): T[] {
  const rest = (list ?? []).filter((r) => !(r.member_id === reaction.member_id && r.emoji === reaction.emoji))
  return reaction.active ? [...rest, reaction] : rest
}

export interface ReactionGroup {
  emoji: string
  count: number
  /** The person reacted with it. */
  mine: boolean
  /** Who did, in the order they did. */
  memberIds: string[]
}

/** A message's reactions as its chips: one per emoji, in the order each was first used, with who and how many. */
export function groupReactions(list: readonly ReactionLike[] | undefined, meId: string | null): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>()
  for (const r of list ?? []) {
    if (!r.active) continue
    const g = groups.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, memberIds: [] }
    if (g.memberIds.includes(r.member_id)) continue
    g.memberIds.push(r.member_id)
    g.count += 1
    if (r.member_id === meId) g.mine = true
    groups.set(r.emoji, g)
  }
  return [...groups.values()]
}

/** "1 reply", "4 replies". */
export function replyCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'reply' : 'replies'}`
}

/** When a thread's last reply was: its time today, "yesterday", else its date. */
export function lastReplyLabel(iso: string | null, now: Date = new Date(), locale?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(now) - day(d)) / 86_400_000)
  if (days <= 0) return `today at ${messageTime(iso, locale)}`
  if (days === 1) return 'yesterday'
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

/**
 * A page into a channel's list, kept with what is there: rows already shown
 * (realtime, an earlier page, a send on its way) stay unless the page has
 * them. `alone` (a page around an old message that doesn't reach the newest:
 * the server's hasNewer) replaces the list instead, keeping only the person's
 * own sends on their way, so no gap is ever drawn as if it were unbroken.
 */
export function mergePage<T extends ShownMessage & { pending?: unknown }>(prev: readonly T[] | undefined, page: readonly T[], alone = false): T[] {
  let list = [...page]
  for (const m of prev ?? []) {
    if (alone && !m.pending) continue
    if (!list.some((x) => x.id === m.id || (!!m.client_id && x.client_id === m.client_id))) list = upsertMessage(list, m)
  }
  return list
}

/** A channel's counts as its row and the card's header use them (migration 560). */
export interface ChannelCounts {
  unread: number
  mentions: number
  thread_unread: number
  thread_mentions: number
  notify?: 'all' | 'mentions' | 'muted'
}

/**
 * What a channel's row shows: how many are unread (a muted channel: none),
 * and how many of those mention the person (a muted channel's mentions still
 * show). Pure.
 */
export function channelBadge(c: ChannelCounts): { count: number; mentions: number } {
  const mentions = c.mentions + c.thread_mentions
  if (c.notify === 'muted') return { count: 0, mentions }
  return { count: c.unread + c.thread_unread, mentions }
}

/** What a channel adds to the card's header count: its unread, or a muted channel's mentions only. Pure. */
export function channelHeaderCount(c: ChannelCounts): number {
  const badge = channelBadge(c)
  return c.notify === 'muted' ? badge.mentions : badge.count
}

/** The typing line for these names, or null when nobody is typing (nothing is drawn). */
export function typingLine(names: readonly string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return 'Several people are typing…'
}
