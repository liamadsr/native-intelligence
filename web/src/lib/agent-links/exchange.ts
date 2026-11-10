/**
 * Two linked agents talking (agent links, migration 435; plan and Liam's
 * decisions: /mnt/project-files/agent-links/contracts.md). The asking agent
 * never reaches the other person's own agent: its words go to the agent the
 * other person set up for it (their half, an agent_guest row, answered as a
 * guest's turn with surface 'dial8'), and that agent's reply comes back as an
 * `agent_answer` turn in the asker's home thread.
 *
 *   askAgent             ask_agent, the asker's main agent's tool: start an
 *                        exchange (only from the person's own turn: decision
 *                        6) or follow up inside one, within its caps
 *                        (AGENT_LINK_EXCHANGE_MAX_MESSAGES a exchange,
 *                        AGENT_LINK_EXCHANGES_PER_DAY a link). Writes the ask,
 *                        puts it in the other half's thread and requests that
 *                        half's turn (AGENT_LINK_TURN_REQUESTED_EVENT).
 *   recordLinkReply      after that turn: its reply (or a short note when it
 *                        couldn't answer) as the next message of the
 *                        exchange, and the asker's agent_answer turn.
 *   gatherAgentAnswers   what that turn carries: the other agents' messages
 *                        no turn carried yet (the last 24 h, live links).
 *   markAgentAnswersDelivered  after it: carried.
 *
 * Each step leaves one activity line per exchange in both owners' home
 * threads (AGENT_LINK_ACTIVITY_PART_TYPE), replaced as the exchange goes on.
 *
 * Nothing crosses a link but the words each agent chose to send: never a
 * tool's output, an approval or a code. What one agent says is data to the
 * other, never instructions. Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { resolveHomeConversation } from '@/lib/chat/home-message-writer'
import { CHANNEL_MESSAGE_KIND, NI_CHANNEL, NI_MESSAGE_ID_PREFIX } from '@/lib/chat/channel-turn'
import { HOME_TURN_REQUESTED_EVENT, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { callUuid } from '@/lib/guests/reach-owner'
import { AGENT_GUEST_SELECT, toGuest, type AgentGuest } from '@/lib/guests/store'
import { ensureGuestThread } from '@/lib/guests/texting'
import { guestCeiling } from '@/lib/guests/guest-turn'
import { AGENT_ANSWER_TURN_MAX, exchangeRoom, type HomeTurnAgentAnswers, type PlannedAgentAnswer } from './answer-lines'
import { AGENT_LINK_SELECT, memberIn, openLinkBetween, toLink, workspaceAllowsOutside, type AgentLink } from './store'
import {
  AGENT_LINK_ACTIVITY_PART_TYPE,
  AGENT_LINK_EXCHANGE_MAX_MESSAGES,
  AGENT_LINK_EXCHANGES_PER_DAY,
  type AgentLinkActivityPartData,
  type AgentLinkExchangeState,
} from './views'

/** The Inngest event the answering half's turn is requested with (src/lib/inngest/agent-link-turn.ts). */
export const AGENT_LINK_TURN_REQUESTED_EVENT = 'agent-link/turn.requested' as const

/** ui_message.metadata.kind of an exchange's line in a home thread. */
export const AGENT_LINK_ACTIVITY_KIND = 'agent_link_activity' as const

/** The longest message one agent sends the other. */
export const AGENT_LINK_MESSAGE_MAX = 1000
/** The longest topic an exchange keeps (its first ask, clipped). */
const TOPIC_MAX = 200
/** How long an answer still reaches the asker's agent. */
export const AGENT_ANSWER_WINDOW_MS = 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

// ── Sides ───────────────────────────────────────────────────────────────────

/** One person's view of an active link: where they answer from, and the other side. */
export interface LinkSide {
  link: AgentLink
  myWorkspaceId: string
  /** My agent_guest row for them: what their agent may ask mine. */
  myHalfId: string
  peerUserId: string
  peerWorkspaceId: string
  /** Their row for me: where my agent's words go. */
  peerHalfId: string
}

/** This user's side of an active, whole link; null when it isn't one, or they aren't on it. */
export function sideOf(link: AgentLink, userId: string): LinkSide | null {
  if (link.state !== 'active' || !link.targetUserId || !link.targetWorkspaceId || !link.targetGuestId) return null
  if (link.requesterUserId === userId) {
    return { link, myWorkspaceId: link.requesterWorkspaceId, myHalfId: link.requesterGuestId, peerUserId: link.targetUserId, peerWorkspaceId: link.targetWorkspaceId, peerHalfId: link.targetGuestId }
  }
  if (link.targetUserId === userId) {
    return { link, myWorkspaceId: link.targetWorkspaceId, myHalfId: link.targetGuestId, peerUserId: link.requesterUserId, peerWorkspaceId: link.requesterWorkspaceId, peerHalfId: link.requesterGuestId }
  }
  return null
}

/** This user's active links answering from this workspace. Throws on a failed read. */
export async function activeLinksIn(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<LinkSide[]> {
  const { data, error } = await supabase
    .from('agent_link')
    .select(AGENT_LINK_SELECT)
    .eq('state', 'active')
    .or(`and(requester_user_id.eq.${userId},requester_workspace_id.eq.${workspaceId}),and(target_user_id.eq.${userId},target_workspace_id.eq.${workspaceId})`)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Parameters<typeof toLink>[0][])
    .map(toLink)
    .map((l) => sideOf(l, userId))
    .filter((s): s is LinkSide => !!s && s.myWorkspaceId === workspaceId)
}

/** A half, read for its owner. Throws on a failed read. */
async function readHalf(supabase: SupabaseClient, ownerUserId: string, guestId: string): Promise<AgentGuest | null> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toGuest(data as Parameters<typeof toGuest>[0]) : null
}

/** True when a half still takes their agent: active, with 'dial8', bound to that user. */
function halfOpen(half: AgentGuest | null, peerUserId: string): half is AgentGuest {
  return !!half && half.state === 'active' && half.channels.includes('dial8') && half.peerUserId === peerUserId && half.peerBoundAt !== null
}

/** The outside switch on both workspaces (decision 5): an outside link stops when either turned it off. */
async function outsideStillAllowed(supabase: SupabaseClient, side: LinkSide): Promise<boolean> {
  if (!side.link.outside) return true
  const [mine, theirs] = await Promise.all([workspaceAllowsOutside(supabase, side.myWorkspaceId), workspaceAllowsOutside(supabase, side.peerWorkspaceId)])
  return mine && theirs
}

/** A person's name as a workspace shows it, and that workspace's name. Never throws. */
async function namesOf(supabase: SupabaseClient, userId: string, workspaceId: string): Promise<{ name: string; workspaceName: string | null }> {
  try {
    const [member, ws] = await Promise.all([
      memberIn(supabase, userId, workspaceId),
      supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle(),
    ])
    const workspaceName = (ws.data as { name?: unknown } | null)?.name
    return { name: member?.display_name?.trim() || 'Someone', workspaceName: typeof workspaceName === 'string' ? workspaceName : null }
  } catch {
    return { name: 'Someone', workspaceName: null }
  }
}

// ── Exchanges ───────────────────────────────────────────────────────────────

interface ExchangeRow {
  id: string
  link_id: string
  started_by_user_id: string
  topic: string
  state: string
  message_count: number
  created_at: string
}

const EXCHANGE_SELECT = 'id, link_id, started_by_user_id, topic, state, message_count, created_at'

async function readExchange(supabase: SupabaseClient, exchangeId: string): Promise<ExchangeRow | null> {
  const { data, error } = await supabase.from('agent_link_exchange').select(EXCHANGE_SELECT).eq('id', exchangeId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as ExchangeRow | null) ?? null
}

/** Count one more message on an exchange; it is capped once no ask and answer fit. Never throws. */
async function bumpExchange(supabase: SupabaseClient, exchange: Pick<ExchangeRow, 'id' | 'message_count'>, now: number): Promise<number> {
  const count = Math.min(AGENT_LINK_EXCHANGE_MAX_MESSAGES, exchange.message_count + 1)
  const state: AgentLinkExchangeState = exchangeRoom(count) < 2 ? 'capped' : 'open'
  try {
    await supabase
      .from('agent_link_exchange')
      .update({ message_count: count, state, ...(state === 'capped' ? { closed_at: new Date(now).toISOString() } : {}) })
      .eq('id', exchange.id)
      .eq('message_count', exchange.message_count)
  } catch {
    // The message stands; the count is a cap, read again on the next ask.
  }
  return count
}

// ── Activity lines ──────────────────────────────────────────────────────────

/**
 * One exchange's line in an owner's home thread (`agent-link:<exchange>`),
 * replaced as it goes on, so a thread shows one line per conversation, not
 * one per message. Never throws.
 */
export async function writeLinkActivity(
  supabase: SupabaseClient,
  owner: { userId: string; workspaceId: string },
  data: AgentLinkActivityPartData,
): Promise<void> {
  try {
    const home = await resolveHomeConversation(supabase, owner)
    if (!home) return
    const messageId = `agent-link:${data.exchange_id}`
    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: home.conversationId,
        user_id: owner.userId,
        workspace_id: owner.workspaceId,
        role: 'assistant',
        ui_message: {
          id: messageId,
          role: 'assistant',
          parts: [{ type: AGENT_LINK_ACTIVITY_PART_TYPE, id: messageId, data }],
          metadata: { kind: AGENT_LINK_ACTIVITY_KIND, link_id: data.link_id, exchange_id: data.exchange_id },
        },
      },
      { onConflict: 'conversation_id,ui_message_id' },
    )
    if (error) console.warn('[agent-link] activity not written:', error.message)
  } catch (err) {
    console.warn('[agent-link] activity not written:', err instanceof Error ? err.message : String(err))
  }
}

// ── ask_agent ───────────────────────────────────────────────────────────────

export interface AskAgentInput {
  /** The linked person, by name (starting an exchange). */
  to?: string
  /** An exchange to follow up in. */
  exchange_id?: string
  message: string
  /** An action item handed to them: a suggestion on their board, with `message` as its note. */
  hand_off?: { title: string; due_date?: string }
}

export interface AskAgentScope {
  userId: string
  workspaceId: string
  /** The person's own turn (decision 6): only it starts an exchange. */
  mayStart: boolean
  /** eve's ids for this call: a retried call sends once. */
  callKey?: string | null
  /**
   * Only check it could be sent (the link, the other half, room, today's
   * limit), write nothing and send nothing: the chat route checks before it
   * holds the message as the person's card (every send waits for their yes).
   */
  check?: boolean
}

export interface AskAgentDeps {
  send?: (event: { name: typeof AGENT_LINK_TURN_REQUESTED_EVENT; data: HomeTurnRequestedData; id: string }) => Promise<unknown>
  persist?: typeof persistEveMessage
  now?: number
}

function linkedList(sides: ReadonlyArray<{ name: string }>): string {
  return sides.length ? `Linked: ${sides.map((s) => s.name).join(', ')}.` : 'The person has no linked agents yet (People > Their agent).'
}

/** Pick the link a name means: exact first, then a first-name or partial match, only when it is one. */
export function matchLinked<T extends { name: string }>(linked: readonly T[], to: string): T | 'ambiguous' | null {
  const want = to.trim().toLowerCase()
  if (!want) return null
  const exact = linked.filter((l) => l.name.toLowerCase() === want)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return 'ambiguous'
  const partial = linked.filter((l) => l.name.toLowerCase().split(/\s+/).includes(want) || l.name.toLowerCase().includes(want))
  if (partial.length === 1) return partial[0]
  return partial.length > 1 ? 'ambiguous' : null
}

/**
 * ask_agent (see the header). The output is what the asking agent reads.
 * Throws on a failed read or write (the route answers that it couldn't
 * confirm the send).
 */
export async function askAgent(supabase: SupabaseClient, scope: AskAgentScope, input: AskAgentInput, deps: AskAgentDeps = {}): Promise<Record<string, unknown>> {
  const now = deps.now ?? Date.now()
  const message = input.message.trim()
  if (!message) return { success: false, code: 'INPUT_INVALID', message: 'Say what to ask.' }

  // Which link, and which exchange.
  let side: LinkSide | null = null
  let exchange: ExchangeRow | null = null
  if (input.exchange_id) {
    exchange = await readExchange(supabase, input.exchange_id)
    const linkRow = exchange ? await supabase.from('agent_link').select(AGENT_LINK_SELECT).eq('id', exchange.link_id).maybeSingle() : null
    if (linkRow?.error) throw new Error(linkRow.error.message)
    side = linkRow?.data ? sideOf(toLink(linkRow.data as Parameters<typeof toLink>[0]), scope.userId) : null
    if (!exchange || !side || side.myWorkspaceId !== scope.workspaceId) {
      return { success: false, code: 'EXCHANGE_NOT_FOUND', message: 'No such conversation with another agent here. Nothing was sent.' }
    }
  } else {
    if (!scope.mayStart) {
      return {
        success: false,
        code: 'NEEDS_PERSON',
        message: "Only the person can start a conversation with another agent. Follow up inside the open one with its exchange_id, or tell the person. Nothing was sent.",
      }
    }
    const sides = await activeLinksIn(supabase, scope.userId, scope.workspaceId)
    const named = await Promise.all(sides.map(async (s) => ({ side: s, name: (await namesOf(supabase, s.peerUserId, s.peerWorkspaceId)).name })))
    const match = input.to ? matchLinked(named, input.to) : null
    if (match === 'ambiguous') return { success: false, code: 'AMBIGUOUS', message: `More than one linked person matches "${input.to}": say which. ${linkedList(named)}` }
    if (!match) return { success: false, code: 'NOT_LINKED', message: `${input.to ? `No linked agent for "${input.to}".` : 'Say whose agent to ask.'} ${linkedList(named)} Nothing was sent.` }
    side = match.side
  }

  // Still allowed: the other half takes my agent, and both workspaces allow outside links.
  const [theirHalf, peer, me] = await Promise.all([
    readHalf(supabase, side.peerUserId, side.peerHalfId),
    namesOf(supabase, side.peerUserId, side.peerWorkspaceId),
    namesOf(supabase, scope.userId, scope.workspaceId),
  ])
  if (!halfOpen(theirHalf, scope.userId) || !(await outsideStillAllowed(supabase, side))) {
    return { success: false, code: 'LINK_OFF', message: `${peer.name}'s agent isn't taking messages from this agent right now. Nothing was sent: tell the person.` }
  }

  // Room for it: a follow-up needs room for its answer; a new one counts against the day.
  if (exchange) {
    if (exchange.state !== 'open' || exchangeRoom(exchange.message_count) < 2) {
      return { success: false, code: 'EXCHANGE_FULL', message: `That conversation with ${peer.name}'s agent is at its limit. Nothing was sent: tell the person what you have, and ask them before starting another.` }
    }
  } else {
    const { count, error } = await supabase
      .from('agent_link_exchange')
      .select('id', { count: 'exact', head: true })
      .eq('link_id', side.link.id)
      .gt('created_at', new Date(now - DAY_MS).toISOString())
    if (error) throw new Error(error.message)
    if ((count ?? 0) >= AGENT_LINK_EXCHANGES_PER_DAY) {
      return { success: false, code: 'DAILY_LIMIT', message: `That's the most conversations with ${peer.name}'s agent for today. Nothing was sent: tell the person.` }
    }
  }

  // A hand-off needs their agent to take tasks (the "tasks" group the other
  // person gave it): never a write on their board they didn't allow.
  if (input.hand_off && !guestCeiling(theirHalf).has('create_action')) {
    return { success: false, code: 'NO_TASKS', message: `${peer.name}'s agent doesn't take tasks, so nothing was sent. Send the message without hand_off, or tell the person.` }
  }

  // A check before the person's card (scope.check): it could be sent, and to whom. Nothing is written.
  if (scope.check) return { success: true, sendable: true, peer_name: peer.name }

  // The other half's thread first: when it can't be made, nothing is written (no exchange or ask left behind).
  const thread = await ensureGuestThread(supabase, theirHalf, NI_CHANNEL)

  // The exchange: a new one is written now (the follow-up's was read above).
  if (!exchange) {
    const exchangeId = callUuid(`agent-link-exchange:${side.link.id}`, scope.callKey)
    const made = await supabase
      .from('agent_link_exchange')
      .insert({ id: exchangeId, link_id: side.link.id, started_by_user_id: scope.userId, topic: clip(message, TOPIC_MAX), state: 'open', message_count: 0 })
      .select(EXCHANGE_SELECT)
      .single()
    if (made.error && made.error.code !== '23505') throw new Error(made.error.message)
    exchange = (made.data as ExchangeRow | null) ?? (await readExchange(supabase, exchangeId))
    if (!exchange) throw new Error('exchange not written')
  }

  // The ask: once per call (a retry finds it written, and only delivers again).
  const messageId = callUuid(`agent-link-ask:${exchange.id}`, scope.callKey)
  const inserted = await supabase
    .from('agent_link_message')
    .insert({ id: messageId, exchange_id: exchange.id, link_id: side.link.id, from_user_id: scope.userId, kind: 'ask', body: clip(message, AGENT_LINK_MESSAGE_MAX) })
  if (inserted.error && inserted.error.code !== '23505') throw new Error(inserted.error.message)
  const count = inserted.error ? exchange.message_count : await bumpExchange(supabase, exchange, now)

  // Into the other half's thread, as their agent's message, and that half's turn.
  const uiId = `${NI_MESSAGE_ID_PREFIX}${messageId}`
  const written = await (deps.persist ?? persistEveMessage)(supabase, {
    conversationId: thread.id,
    userId: side.peerUserId,
    workspaceId: side.peerWorkspaceId,
    role: 'user',
    parts: [{ type: 'text', text: clip(message, AGENT_LINK_MESSAGE_MAX) }],
    messageId: uiId,
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: NI_CHANNEL, guest_id: theirHalf.id, agent_link: { link_id: side.link.id, exchange_id: exchange.id, message_id: messageId } },
  })
  if (!written.written && written.reason) throw new Error(`ask not written (${written.reason})`)
  const send = deps.send ?? (async (event) => (await import('@/lib/inngest/client')).inngest.send(event as never))
  await send({
    name: AGENT_LINK_TURN_REQUESTED_EVENT,
    id: `agent-ask-${messageId}`,
    data: { conversationId: thread.id, userId: side.peerUserId, workspaceId: side.peerWorkspaceId, workItemIds: [], reason: 'agent_ask', guestId: theirHalf.id },
  })

  const at = new Date(now).toISOString()
  await Promise.all([
    writeLinkActivity(supabase, { userId: scope.userId, workspaceId: scope.workspaceId }, {
      link_id: side.link.id,
      peer: { name: peer.name, workspace_name: peer.workspaceName },
      exchange_id: exchange.id,
      summary: `Asked ${peer.name}'s agent: ${clip(message, 160)}`,
      count,
      last_at: at,
    }),
    writeLinkActivity(supabase, { userId: side.peerUserId, workspaceId: side.peerWorkspaceId }, {
      link_id: side.link.id,
      peer: { name: me.name, workspace_name: me.workspaceName },
      exchange_id: exchange.id,
      summary: `${me.name}'s agent asked: ${clip(message, 160)}`,
      count,
      last_at: at,
    }),
  ])

  // The action item, on their board as a suggestion they confirm (never a
  // confirmed task: their own yes promotes it). Once per send (callKey).
  // Only by the send that wrote the ask: a retried call never files it twice.
  const handOff = input.hand_off && !inserted.error ? await handOffAction(supabase, side, { from: me.name, title: input.hand_off.title, dueDate: input.hand_off.due_date, note: message }) : null

  return {
    success: true,
    sent: true,
    exchange_id: exchange.id,
    room_left: exchangeRoom(count),
    ...(handOff ? { handed_off: handOff.ok, ...(handOff.ok ? {} : { hand_off_error: handOff.error }) } : {}),
    message:
      `Sent to ${peer.name}'s agent. Its answer comes back in this chat on its own: don't wait for it or ask again. Tell the person you've asked.` +
      (handOff ? (handOff.ok ? ` The action item is on ${peer.name}'s board as a suggestion for them to confirm.` : ` The action item could not be put on ${peer.name}'s board: ${handOff.error}`) : ''),
  }
}

/**
 * File a handed-off action item on the other person's board, as THEM (their
 * workspace, their default team), always a suggestion for them to confirm,
 * assigned to them, its note saying whose agent sent it. Through the real
 * create_action (its validation and routing), under the unattended rules.
 * Never throws.
 */
async function handOffAction(
  supabase: SupabaseClient,
  side: LinkSide,
  item: { from: string; title: string; dueDate?: string; note: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { createTools } = await import('@/lib/ai/tools')
    const tools = createTools(side.peerUserId, supabase, side.peerWorkspaceId, undefined, {
      strictWorkspace: true,
      unattended: true,
      origin: { actor: 'agent', depth: 1 },
      actionRules: { unattended: true, fileActionsAsSuggested: true },
    }) as unknown as Record<string, { execute?: (input: unknown, options: unknown) => Promise<unknown> }>
    const create = tools.create_action
    if (typeof create?.execute !== 'function') return { ok: false, error: 'their board is not available.' }
    const member = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', side.peerWorkspaceId)
      .eq('user_id', side.peerUserId)
      .maybeSingle<{ id: string }>()
    const out = (await create.execute(
      {
        title: clip(item.title, 200),
        description: `From ${item.from}'s agent (agent link):\n\n${clip(item.note, AGENT_LINK_MESSAGE_MAX)}`,
        ...(item.dueDate ? { due_date: item.dueDate } : {}),
        ...(member.data?.id ? { assignee_id: member.data.id } : {}),
        confirmation: 'suggested',
        source_type: 'agent_handoff',
      },
      { toolCallId: `agent-handoff-${side.link.id}`, messages: [] },
    )) as { success?: unknown; error?: unknown } | null
    if (out && out.success === false) return { ok: false, error: typeof out.error === 'string' ? out.error : 'it was refused.' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'it could not be written.' }
  }
}

// ── The answering half's reply ──────────────────────────────────────────────

export interface LinkReplyDeps {
  send?: (event: { name: typeof HOME_TURN_REQUESTED_EVENT; data: HomeTurnRequestedData; id: string }) => Promise<unknown>
  now?: number
}

export type LinkReplyResult = { recorded: true; messageId: string } | { recorded: false; reason: 'no_link' | 'no_ask' | 'empty' }

/**
 * The answering half's turn ended: its reply (kind 'answer'), or a note
 * Native Intelligence wrote when it couldn't answer ('note'), becomes the exchange's next
 * message, and the asker's agent gets it in an agent_answer turn. `rowId` is
 * the turn's home_turn row: a retried step records it once. Throws on a
 * failed read or write.
 */
export async function recordLinkReply(
  supabase: SupabaseClient,
  turn: { ownerUserId: string; workspaceId: string; guestId: string; rowId: string },
  reply: { kind: 'answer' | 'note'; body: string },
  deps: LinkReplyDeps = {},
): Promise<LinkReplyResult> {
  const now = deps.now ?? Date.now()
  const body = clip(reply.body, AGENT_LINK_MESSAGE_MAX)
  if (!body) return { recorded: false, reason: 'empty' }
  const half = await readHalf(supabase, turn.ownerUserId, turn.guestId)
  if (!half?.peerUserId) return { recorded: false, reason: 'no_link' }
  const link = await openLinkBetween(supabase, turn.ownerUserId, half.peerUserId)
  const side = link ? sideOf(link, turn.ownerUserId) : null
  if (!side || side.myHalfId !== half.id || side.myWorkspaceId !== turn.workspaceId) return { recorded: false, reason: 'no_link' }

  // The exchange it answers: the newest ask from their agent on this link.
  const { data: asks, error: asksError } = await supabase
    .from('agent_link_message')
    .select('exchange_id, created_at')
    .eq('link_id', side.link.id)
    .eq('from_user_id', side.peerUserId)
    .eq('kind', 'ask')
    .order('created_at', { ascending: false })
    .limit(1)
  if (asksError) throw new Error(asksError.message)
  const exchangeId = (asks as Array<{ exchange_id: string }> | null)?.[0]?.exchange_id
  const exchange = exchangeId ? await readExchange(supabase, exchangeId) : null
  if (!exchange) return { recorded: false, reason: 'no_ask' }

  const messageId = callUuid(`agent-link-reply:${turn.guestId}`, turn.rowId)
  const inserted = await supabase
    .from('agent_link_message')
    .insert({ id: messageId, exchange_id: exchange.id, link_id: side.link.id, from_user_id: turn.ownerUserId, kind: reply.kind, body })
  if (inserted.error && inserted.error.code !== '23505') throw new Error(inserted.error.message)
  const count = inserted.error || exchange.message_count >= AGENT_LINK_EXCHANGE_MAX_MESSAGES ? exchange.message_count : await bumpExchange(supabase, exchange, now)

  // The asker's agent hears it in their home thread (agent_answer).
  const home = await resolveHomeConversation(supabase, { userId: side.peerUserId, workspaceId: side.peerWorkspaceId })
  if (home) {
    const send = deps.send ?? (async (event) => (await import('@/lib/inngest/client')).inngest.send(event as never))
    try {
      await send({
        name: HOME_TURN_REQUESTED_EVENT,
        id: `agent-answer-${messageId}`,
        data: { conversationId: home.conversationId, userId: side.peerUserId, workspaceId: side.peerWorkspaceId, workItemIds: [], reason: 'agent_answer' },
      })
    } catch (err) {
      // The answer stands: the asker's next agent_answer turn carries it.
      console.warn('[agent-link] answer turn not requested:', err instanceof Error ? err.message : String(err))
    }
  }

  const [me, them] = await Promise.all([namesOf(supabase, turn.ownerUserId, turn.workspaceId), namesOf(supabase, side.peerUserId, side.peerWorkspaceId)])
  const at = new Date(now).toISOString()
  const said = reply.kind === 'note' ? body : clip(body, 160)
  await Promise.all([
    writeLinkActivity(supabase, { userId: turn.ownerUserId, workspaceId: turn.workspaceId }, {
      link_id: side.link.id,
      peer: { name: them.name, workspace_name: them.workspaceName },
      exchange_id: exchange.id,
      summary: `Told ${them.name}'s agent: ${said}`,
      count,
      last_at: at,
    }),
    writeLinkActivity(supabase, { userId: side.peerUserId, workspaceId: side.peerWorkspaceId }, {
      link_id: side.link.id,
      peer: { name: me.name, workspace_name: me.workspaceName },
      exchange_id: exchange.id,
      summary: `${me.name}'s agent ${reply.kind === 'note' ? 'said' : 'answered'}: ${said}`,
      count,
      last_at: at,
    }),
  ])
  return { recorded: true, messageId }
}

// ── The asker's agent_answer turn ───────────────────────────────────────────

interface AnswerRow {
  id: string
  exchange_id: string
  link_id: string
  kind: string
  body: string
  created_at: string
}

/**
 * The other agents' messages this person's agent hasn't been given yet,
 * oldest first, on their live links answering from this workspace. Null when
 * there are none. Throws on a failed read.
 */
export async function gatherAgentAnswers(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string },
  now: number = Date.now(),
): Promise<HomeTurnAgentAnswers | null> {
  const sides = await activeLinksIn(supabase, scope.userId, scope.workspaceId)
  if (sides.length === 0) return null
  const byLink = new Map(sides.map((s) => [s.link.id, s]))
  const { data, error } = await supabase
    .from('agent_link_message')
    .select('id, exchange_id, link_id, kind, body, created_at')
    .in('link_id', [...byLink.keys()])
    .neq('from_user_id', scope.userId)
    .in('kind', ['answer', 'decline', 'note'])
    .is('delivered_at', null)
    .gte('created_at', new Date(now - AGENT_ANSWER_WINDOW_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(AGENT_ANSWER_TURN_MAX)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as AnswerRow[]
  if (rows.length === 0) return null

  const { data: exchanges, error: exError } = await supabase.from('agent_link_exchange').select(EXCHANGE_SELECT).in('id', [...new Set(rows.map((r) => r.exchange_id))])
  if (exError) throw new Error(exError.message)
  const exchangeById = new Map(((exchanges ?? []) as ExchangeRow[]).map((e) => [e.id, e]))
  const names = new Map<string, { name: string; workspaceName: string | null }>()
  for (const linkId of new Set(rows.map((r) => r.link_id))) {
    const s = byLink.get(linkId)
    if (s) names.set(linkId, await namesOf(supabase, s.peerUserId, s.peerWorkspaceId))
  }
  const answers: PlannedAgentAnswer[] = rows.map((r) => {
    const ex = exchangeById.get(r.exchange_id)
    const who = names.get(r.link_id) ?? { name: 'Someone', workspaceName: null }
    return {
      messageId: r.id,
      exchangeId: r.exchange_id,
      linkId: r.link_id,
      peerName: who.name,
      workspaceName: who.workspaceName,
      kind: r.kind === 'decline' || r.kind === 'note' ? r.kind : 'answer',
      body: r.body,
      topic: ex ? clip(ex.topic, 120) : '',
      left: ex && ex.state === 'open' ? exchangeRoom(ex.message_count) : 0,
      createdAt: r.created_at,
    }
  })
  return { answers, messageIds: answers.map((a) => a.messageId) }
}

/** After the turn: these answers were carried (a later turn won't carry them again). Never throws. */
export async function markAgentAnswersDelivered(
  supabase: SupabaseClient,
  input: { messageIds: readonly string[]; homeTurnId: string },
  now: number = Date.now(),
): Promise<void> {
  if (input.messageIds.length === 0) return
  try {
    const { error } = await supabase
      .from('agent_link_message')
      .update({ delivered_at: new Date(now).toISOString(), home_turn_id: input.homeTurnId })
      .in('id', [...input.messageIds])
      .is('delivered_at', null)
    if (error) console.warn('[agent-link] delivered mark failed:', error.message)
  } catch (err) {
    console.warn('[agent-link] delivered mark failed:', err instanceof Error ? err.message : String(err))
  }
}
