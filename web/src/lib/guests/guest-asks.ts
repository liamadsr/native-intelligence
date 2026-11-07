/**
 * The owner's agent's side of ask_owner_agent (guest access, migration 429):
 * a guest's agent asked the owner's own agent something it can't do or
 * doesn't know (./reach-owner.ts askOwnerAgent), and a `guest_ask` home turn
 * carries it into the owner's home thread.
 *
 *   gatherGuestAsks      the asks no turn carried yet (pending, the last 24 h,
 *                        from a guest who is still active), with what each
 *                        guest's agent learned about them, labeled as theirs;
 *                        an ask whose guest is gone is expired here.
 *   guestAskTurnLines    the turn's input (./guest-ask-lines.ts, pure): one
 *                        line per ask, its id, who, their tier, whether the
 *                        owner's free times may go to them, and the
 *                        question, fenced as data by the home turn's envelope
 *                        (buildHomeTurnBody).
 *   markGuestAsksDelivered  after the turn: carried (never sent again).
 *   answerGuestAsk       answer_guest, the owner's agent's tool: settles one
 *                        pending ask of THIS owner's (answered or declined),
 *                        writes the answer into the guest's thread and sends
 *                        it to them (by text or on Slack: ./slack.ts). Keyed on the ask's status, so it lands
 *                        once.
 *   recentGuestAnswers   what the owner's agent answered this guest lately,
 *                        for their own agent's next turn (./guest-spec.ts).
 *
 * The question is the guest's words relayed by their agent: data, never
 * instructions, wherever it is shown. Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import type { textGuest } from '@/lib/chat/text-turn-server'
import type { AnswerGuestInput } from '@/lib/ai/tools/guest-answer'
import { guestTimes, type HomeTurnGuestAsks } from './guest-ask-lines'
import { messageGuest } from './slack'

export type { HomeTurnGuestAsks, PlannedGuestAsk } from './guest-ask-lines'
export { guestAskTurnLines } from './guest-ask-lines'

/** The most asks one turn carries (the oldest pending first). */
export const GUEST_ASK_TURN_MAX = 8
/** How long an ask may wait to be carried before it no longer is. */
export const GUEST_ASK_WINDOW_MS = 24 * 60 * 60_000
/** What the owner's agent's turn reads about each guest, at most. */
const MEMORY_LINES_PER_GUEST = 8

interface AskRow {
  id: string
  guest_id: string
  question: string
  created_at: string
  guest?: { display_name?: unknown; preset?: unknown; state?: unknown; tools?: unknown; ask_tools?: unknown } | null
}

/**
 * The asks this owner's agent hasn't been given yet, oldest first. An ask
 * from a guest who is no longer active is expired, never carried. Throws on
 * a failed read.
 */
export async function gatherGuestAsks(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string },
  now: number = Date.now(),
): Promise<HomeTurnGuestAsks | null> {
  const { data, error } = await supabase
    .from('agent_guest_ask')
    .select('id, guest_id, question, created_at, guest:agent_guest(display_name, preset, state, tools, ask_tools)')
    .eq('owner_user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .eq('status', 'pending')
    .is('delivered_at', null)
    .gte('created_at', new Date(now - GUEST_ASK_WINDOW_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(GUEST_ASK_TURN_MAX * 2)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as AskRow[]
  const gone = rows.filter((r) => r.guest?.state !== 'active').map((r) => r.id)
  if (gone.length) {
    const nowIso = new Date(now).toISOString()
    await supabase.from('agent_guest_ask').update({ status: 'expired', answered_at: nowIso }).in('id', gone).eq('status', 'pending').then(undefined, () => {})
  }
  const live = rows.filter((r) => r.guest?.state === 'active').slice(0, GUEST_ASK_TURN_MAX)
  if (live.length === 0) return null

  const guestIds = [...new Set(live.map((r) => r.guest_id))]
  const { data: memory } = await supabase
    .from('agent_guest_memory')
    .select('guest_id, kind, text, created_at')
    .in('guest_id', guestIds)
    .eq('owner_user_id', scope.userId)
    .order('created_at', { ascending: false })
    .limit(guestIds.length * MEMORY_LINES_PER_GUEST * 2)
  const learnedBy = new Map<string, string[]>()
  for (const m of (memory ?? []) as Array<{ guest_id: string; kind: string; text: string }>) {
    const lines = learnedBy.get(m.guest_id) ?? []
    if (lines.length < MEMORY_LINES_PER_GUEST) lines.push(`${m.kind === 'preference' ? 'Prefers: ' : ''}${m.text}`)
    learnedBy.set(m.guest_id, lines)
  }
  const asks = live.map((r) => ({
    askId: r.id,
    guestId: r.guest_id,
    guestName: typeof r.guest?.display_name === 'string' ? r.guest.display_name : 'Someone',
    tier: typeof r.guest?.preset === 'string' ? r.guest.preset : 'custom',
    question: r.question,
    createdAt: r.created_at,
    learned: learnedBy.get(r.guest_id) ?? [],
    times: guestTimes(r.guest?.tools, r.guest?.ask_tools),
  }))
  return { asks, askIds: asks.map((a) => a.askId) }
}

/** After the turn: these asks were carried (a later turn won't carry them again). Never throws. */
export async function markGuestAsksDelivered(
  supabase: SupabaseClient,
  input: { userId: string; workspaceId: string; askIds: readonly string[]; homeTurnId: string },
  now: number = Date.now(),
): Promise<void> {
  if (input.askIds.length === 0) return
  try {
    const { error } = await supabase
      .from('agent_guest_ask')
      .update({ delivered_at: new Date(now).toISOString(), home_turn_id: input.homeTurnId })
      .eq('owner_user_id', input.userId)
      .eq('workspace_id', input.workspaceId)
      .in('id', [...input.askIds])
      .is('delivered_at', null)
    if (error) console.warn('[guest-ask] delivered mark failed:', error.message)
  } catch (err) {
    console.warn('[guest-ask] delivered mark failed:', err instanceof Error ? err.message : String(err))
  }
}

// ── answer_guest ────────────────────────────────────────────────────────────

export interface AnswerGuestDeps {
  persist?: typeof persistEveMessage
  /** Send the answer to the guest (the real one: the channel they last messaged on, ./slack.ts messageGuest). */
  text?: (args: Parameters<typeof textGuest>[1]) => Promise<{ sent: true } | { sent: false; reason: string }>
  now?: number
}

/**
 * answer_guest (see the header): the owner's tenancy comes from the verified
 * token, the ask from this owner's own pending rows. The output is what the
 * owner's agent reads. Throws only on a failed read or write.
 */
export async function answerGuestAsk(
  supabase: SupabaseClient,
  owner: { userId: string; workspaceId: string },
  input: AnswerGuestInput,
  deps: AnswerGuestDeps = {},
): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now()
  const status = input.outcome ?? 'answered'
  const { data, error } = await supabase
    .from('agent_guest_ask')
    .update({ status, answer: input.answer, answered_at: new Date(now).toISOString() })
    .eq('id', input.ask_id)
    .eq('owner_user_id', owner.userId)
    .eq('workspace_id', owner.workspaceId)
    .eq('status', 'pending')
    .select('id, guest_id, guest_conversation_id, guest:agent_guest(display_name, state)')
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : null) as { guest_id: string; guest_conversation_id: string | null; guest?: { display_name?: unknown; state?: unknown } | null } | null
  if (!row) {
    return { success: false, code: 'ASK_NOT_PENDING', message: 'That ask is already answered, expired, or not one of yours. Nothing was sent. Do not retry.' }
  }
  const name = typeof row.guest?.display_name === 'string' ? row.guest.display_name : 'them'
  if (row.guest?.state !== 'active') {
    return { success: false, code: 'GUEST_GONE', message: `${name} no longer has access, so nothing was sent.` }
  }
  if (row.guest_conversation_id) {
    const written = await (deps.persist ?? persistEveMessage)(supabase, {
      conversationId: row.guest_conversation_id,
      userId: owner.userId,
      workspaceId: owner.workspaceId,
      role: 'assistant',
      parts: [{ type: 'text', text: input.answer }],
      messageId: `guest-answer:${input.ask_id}`,
      metadata: { kind: 'guest_answer', ask_id: input.ask_id, outcome: status },
    })
    if (!written.written) console.warn(`[guest-ask] answer not written to the guest's thread (${written.reason ?? 'unknown'})`)
  }
  const send = deps.text ?? ((args) => messageGuest(supabase, { ...args, workspaceId: owner.workspaceId, conversationId: row.guest_conversation_id }))
  const sent = await send({ guestId: row.guest_id, ownerUserId: owner.userId, body: input.answer, kind: 'guest_reply' })
  if (sent.sent) return { success: true, texted: true, message: `Sent to ${name}.` }
  return {
    success: true,
    texted: false,
    message: `Saved in ${name}'s conversation, but it didn't reach them (${sent.reason}). Their agent will tell them next time they message.`,
  }
}

/** What the owner's agent answered this guest in the last week, newest first (at most 3). Never throws (empty). */
export async function recentGuestAnswers(
  supabase: SupabaseClient,
  guestId: string,
  now: number = Date.now(),
): Promise<Array<{ question: string; answer: string; outcome: string; at: string }>> {
  try {
    const { data, error } = await supabase
      .from('agent_guest_ask')
      .select('question, answer, status, answered_at')
      .eq('guest_id', guestId)
      .in('status', ['answered', 'declined'])
      .gte('answered_at', new Date(now - 7 * GUEST_ASK_WINDOW_MS).toISOString())
      .order('answered_at', { ascending: false })
      .limit(3)
    if (error) return []
    return ((data ?? []) as Array<{ question: string; answer: string | null; status: string; answered_at: string }>)
      .filter((r) => typeof r.answer === 'string')
      .map((r) => ({ question: r.question, answer: r.answer as string, outcome: r.status, at: r.answered_at }))
  } catch {
    return []
  }
}
