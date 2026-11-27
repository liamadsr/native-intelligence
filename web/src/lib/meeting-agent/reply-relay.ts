/**
 * The person's answer, read out live (roadmap #12 phase 2,
 * docs/plans/agent-joins-meetings.md §3). Liam, 11-27: "texts you if it
 * needs you", "with their reply relayed back live if possible".
 *
 * When the assistant checks with the person (./ask.ts), their reply lands in
 * their home thread as one of their own messages, from whatever channel they
 * answered on (a text, Slack, the app). While the call is up, the bridge
 * looks for it every few seconds and says it in the meeting as theirs:
 * "<Name> says: …". The ask told them it would be read out.
 *
 *   - Only the person's own messages in their own home thread count (role
 *     user, their user id, the thread the ask was written to), written after
 *     the oldest open ask. One reply answers the oldest open ask; a second
 *     answers the next.
 *   - The words are theirs, so they are said as written, only made speakable
 *     and cut to RELAY_MAX_CHARS. Nothing the person writes reaches a model
 *     on the way.
 *   - After the call, nothing is relayed: the reply stays in the thread.
 *
 * The answer is recorded on the attendance's ask (answered_at,
 * answer_message_id), so the notes and the status show which asks the person
 * answered.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { speakable } from '@/lib/calls/live-bridge'
import { MEETING_ATTENDANCE_TABLE } from './store'

/** How often the bridge looks for an answer while an ask is open. */
export const RELAY_POLL_MS = 5_000
/** The most of a reply said aloud. */
export const RELAY_MAX_CHARS = 400

export interface OwnerReply {
  id: string
  createdAt: string
  text: string
}

export interface OpenAsk {
  messageId: string
  conversationId: string
  askedAt: string
}

/** A user message's words: its text parts, joined. Pure. */
export function replyTextOf(uiMessage: unknown): string {
  const parts = (uiMessage as { parts?: unknown } | null)?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((p): p is { type: string; text: string } => !!p && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string')
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What the meeting hears. Pure. */
export function relayedAnswer(firstName: string, text: string): string {
  const said = speakable(text)
  const cut = said.length > RELAY_MAX_CHARS ? `${said.slice(0, RELAY_MAX_CHARS).replace(/\s+\S*$/, '')}…` : said
  return `${firstName} says: ${cut}`
}

/** The person's own messages in their home thread after `sinceIso`, oldest first. Throws on a failed read. */
export async function ownerRepliesSince(svc: SupabaseClient, args: { conversationId: string; userId: string; sinceIso: string }): Promise<OwnerReply[]> {
  const { data, error } = await svc
    .from('chat_messages')
    .select('id, created_at, ui_message')
    .eq('conversation_id', args.conversationId)
    .eq('user_id', args.userId)
    .eq('role', 'user')
    .gt('created_at', args.sinceIso)
    .order('created_at', { ascending: true })
    .limit(10)
  if (error) throw new Error(`meeting agent: replies read failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; created_at: string; ui_message: unknown }>)
    .map((r) => ({ id: r.id, createdAt: r.created_at, text: replyTextOf(r.ui_message) }))
    .filter((r) => r.text)
}

/** Mark the ask with this message id answered (read-modify-write: one bridge writes per attendance). */
export async function recordAnswer(svc: SupabaseClient, attendanceId: string, askMessageId: string, answer: { messageId: string; at: string }): Promise<void> {
  const { data } = await svc.from(MEETING_ATTENDANCE_TABLE).select('asks').eq('id', attendanceId).maybeSingle<{ asks: unknown }>()
  const list = Array.isArray(data?.asks) ? (data!.asks as Array<Record<string, unknown>>) : []
  const next = list.map((a) => (a?.message_id === askMessageId ? { ...a, answered_at: answer.at, answer_message_id: answer.messageId } : a))
  await svc.from(MEETING_ATTENDANCE_TABLE).update({ asks: next }).eq('id', attendanceId)
}

export interface ReplyRelayDeps {
  replies?: typeof ownerRepliesSince
  record?: typeof recordAnswer
}

/**
 * The open asks of one call and their answers. `poll` reads once and returns
 * what to say, in order (the bridge says each); never throws.
 */
export class ReplyRelay {
  private open: OpenAsk[] = []
  private seen = new Set<string>()
  private polling = false

  constructor(
    private readonly svc: SupabaseClient,
    private readonly attendance: { id: string; userId: string; ownerFirstName: string },
    private readonly deps: ReplyRelayDeps = {},
  ) {}

  /** An ask the person was sent (only one written to a thread can be answered). */
  add(ask: OpenAsk): void {
    this.open.push(ask)
    this.open.sort((a, b) => a.askedAt.localeCompare(b.askedAt))
  }

  hasOpen(): boolean {
    return this.open.length > 0
  }

  async poll(): Promise<string[]> {
    if (this.polling || this.open.length === 0) return []
    this.polling = true
    const said: string[] = []
    try {
      const oldest = this.open[0]
      const replies = await (this.deps.replies ?? ownerRepliesSince)(this.svc, { conversationId: oldest.conversationId, userId: this.attendance.userId, sinceIso: oldest.askedAt })
      for (const reply of replies) {
        if (this.seen.has(reply.id)) continue
        const ask = this.open.find((a) => a.conversationId === oldest.conversationId && reply.createdAt > a.askedAt)
        if (!ask) continue
        this.seen.add(reply.id)
        this.open = this.open.filter((a) => a !== ask)
        said.push(relayedAnswer(this.attendance.ownerFirstName, reply.text))
        await (this.deps.record ?? recordAnswer)(this.svc, this.attendance.id, ask.messageId, { messageId: reply.id, at: reply.createdAt }).catch(() => {})
        if (this.open.length === 0) break
      }
    } catch (err) {
      console.warn(`[meeting-agent] attendance=${this.attendance.id} reply read failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.polling = false
    }
    return said
  }
}
