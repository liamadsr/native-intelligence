/**
 * A guest on Slack (guest access, migration 434): someone the owner added,
 * with Slack among the channels they may reach their agent on, messaging the
 * Dial8 app in a Slack workspace bound to the owner's Dial8 workspace. The
 * Slack twin of ./texting.ts.
 *
 * Who is speaking is decided from what Slack verified (the team, the user id)
 * and what Dial8 holds, never from the message's words. Called by
 * src/lib/slack/inbound.ts for a DM from a Slack user who is NOT linked to a
 * Dial8 account (a linked person always gets their own agent), in a team with
 * a live installation, from that team's own members (Slack Connect outsiders
 * were turned away before this). In this order:
 *
 *   1. a DM from a Slack user bound to an active guest of this workspace, who
 *      still has Slack among their channels, goes to their own agent: written
 *      into their thread as their message and a Slack turn is requested with
 *      their `guestId` (src/lib/inngest/slack-turn.ts), answered back in the
 *      DM. Past their daily cap, a short notice and nothing written;
 *   2. a DM carrying an open invite code of a guest of this workspace who has
 *      Slack among their channels and no Slack account bound yet binds this
 *      Slack user to them (the code is hashed with the guest's id and number,
 *      or '' for a Slack-only guest, so it works for that guest only). The
 *      sender must be a real member of the team (users.info: not a bot, not
 *      deactivated, not a stranger). Wrong codes count toward the same
 *      per-user and per-team cap as link codes, so a code can't be guessed;
 *   3. anything else is not a guest's: null, and the "link your account"
 *      reply takes it.
 *
 * Also here: where a guest's Slack turn answers ({@link guestSlackOrigin}),
 * and sending a guest a message on Slack outside a turn (an answer from the
 * owner's agent: {@link messageGuest} picks the channel they last used).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import type { HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { CHANNEL_MESSAGE_KIND, SLACK_CHANNEL, SLACK_MESSAGE_ID_PREFIX, SMS_MESSAGE_ID_PREFIX, slackMessageId } from '@/lib/chat/channel-turn'
import { textGuest } from '@/lib/chat/text-turn-server'
import { slackTextToPlain, type SlackInbound } from '@/lib/slack/events'
import { getInstallation, type SlackInstallation } from '@/lib/slack/store'
import type { SlackUserInfo, SlackApiResult } from '@/lib/slack/web-api'
import { recordGuestActivity } from './activity'
import { ownerDisplayName } from './guest-turn'
import type { GuestChannel } from './reach-owner'
import { AGENT_GUEST_SELECT, inviteCodeMatches, toGuest, touchGuestInbound, unboundChannels, type AgentGuest } from './store'
import { GUEST_DAILY_TEXT_CAP, codeCandidates, ensureGuestThread } from './texting'

type Dm = Extract<SlackInbound, { kind: 'dm' }>

/** Messages one guest may send their agent on Slack in a day (each is a turn the owner pays for). */
export const GUEST_SLACK_DAILY_CAP = GUEST_DAILY_TEXT_CAP
const DAY_MS = 24 * 60 * 60_000

/** The Inngest event a Slack turn is requested with (src/lib/slack/turn.ts SLACK_TURN_REQUESTED_EVENT; not imported, to keep this module off the turn's). */
const SLACK_TURN_EVENT = 'slack/turn.requested'
const WORKING_REACTION = 'eyes'

// ── The store (migration 434's columns) ─────────────────────────────────────

/** The active guest of this workspace bound to this Slack user, with Slack still among their channels. Throws on a failed read. */
export async function findActiveGuestBySlack(
  supabase: SupabaseClient,
  who: { teamId: string; slackUserId: string; workspaceId: string },
): Promise<AgentGuest | null> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(AGENT_GUEST_SELECT)
    .eq('slack_team_id', who.teamId)
    .eq('slack_user_id', who.slackUserId)
    .eq('workspace_id', who.workspaceId)
    .eq('state', 'active')
    .contains('channels', [SLACK_CHANNEL])
    .maybeSingle()
  if (error) throw new Error(error.message)
  const guest = data ? toGuest(data as GuestRow) : null
  return guest && guest.channels.includes('slack') ? guest : null
}

type GuestRow = Parameters<typeof toGuest>[0]

/**
 * Invites in this workspace that a Slack user can still take up: Slack among
 * the guest's channels, no Slack account bound yet, the code unexpired (the
 * guest may already be active by text). Throws on a failed read.
 */
export async function findOpenSlackInvites(
  supabase: SupabaseClient,
  workspaceId: string,
  now: number = Date.now(),
): Promise<Array<{ guest: AgentGuest; inviteHash: string }>> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(`${AGENT_GUEST_SELECT}, invite_code_hash`)
    .eq('workspace_id', workspaceId)
    .in('state', ['invited', 'active'])
    .contains('channels', [SLACK_CHANNEL])
    .is('slack_user_id', null)
    .gt('invite_expires_at', new Date(now).toISOString())
    .limit(50)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<GuestRow & { invite_code_hash?: unknown }>)
    .filter((row) => typeof row.invite_code_hash === 'string' && row.invite_code_hash.length > 0)
    .map((row) => ({ guest: toGuest(row), inviteHash: row.invite_code_hash as string }))
    .filter(({ guest }) => guest.channels.includes('slack'))
}

/**
 * Bind this Slack user to the guest whose code they sent: they are active
 * (activated_at only on their first binding), and the code is spent unless
 * their number is still owed a binding (Text among their channels, not yet
 * proven: store.ts unboundChannels). 'conflict' when this Slack user is
 * already bound to another active guest; 'gone' when the invite was used,
 * renewed or removed in the meantime.
 */
export async function bindGuestSlack(
  supabase: SupabaseClient,
  target: Pick<AgentGuest, 'id' | 'ownerUserId' | 'state' | 'channels' | 'phoneBoundAt' | 'slackUserId'>,
  binding: { teamId: string; slackUserId: string },
  now: number = Date.now(),
): Promise<{ ok: true; guest: AgentGuest } | { ok: false; reason: 'conflict' | 'gone' | 'failed' }> {
  const at = new Date(now).toISOString()
  const firstBinding = target.state === 'invited'
  const textStillOwed = unboundChannels(target).includes('sms')
  const { data, error } = await supabase
    .from('agent_guest')
    .update({
      slack_team_id: binding.teamId,
      slack_user_id: binding.slackUserId,
      state: 'active',
      updated_at: at,
      ...(firstBinding ? { activated_at: at } : {}),
      ...(textStillOwed ? {} : { invite_code_hash: null, invite_expires_at: null }),
    })
    .eq('id', target.id)
    .eq('owner_user_id', target.ownerUserId)
    .eq('state', target.state)
    .is('slack_user_id', null)
    .contains('channels', [SLACK_CHANNEL])
    .select(AGENT_GUEST_SELECT)
    .maybeSingle()
  if (error) return { ok: false, reason: (error as { code?: string }).code === '23505' ? 'conflict' : 'failed' }
  return data ? { ok: true, guest: toGuest(data as GuestRow) } : { ok: false, reason: 'gone' }
}

/** A guest's Slack messages in their thread since `sinceMs` (the daily cap). Throws on a failed read. */
export async function countGuestSlackMessagesSince(supabase: SupabaseClient, guest: Pick<AgentGuest, 'id' | 'ownerUserId'>, sinceMs: number): Promise<number> {
  const { data: thread, error: threadError } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('agent_guest_id', guest.id)
    .eq('user_id', guest.ownerUserId)
    .maybeSingle<{ id: string }>()
  if (threadError) throw new Error(threadError.message)
  if (!thread) return 0
  const { count, error } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', thread.id)
    .like('ui_message_id', `${SLACK_MESSAGE_ID_PREFIX}%`)
    .gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(error.message)
  return count ?? 0
}

// ── The DM, as a guest's ────────────────────────────────────────────────────

export type GuestSlackOutcome =
  | 'guest_queued'
  | 'guest_no_text'
  | 'guest_limited'
  | 'guest_welcomed'
  | 'guest_conflict'
  | 'guest_code_blocked'
  | 'guest_not_member'

export interface GuestSlackDeps {
  findActive(who: { teamId: string; slackUserId: string; workspaceId: string }): Promise<AgentGuest | null>
  findInvites(workspaceId: string, now: number): Promise<Array<{ guest: AgentGuest; inviteHash: string }>>
  bind(target: AgentGuest, binding: { teamId: string; slackUserId: string }, now: number): ReturnType<typeof bindGuestSlack>
  /** The sender as Slack knows them (users.info), to refuse a bot, a deactivated account or a stranger. */
  sender(): Promise<SlackApiResult<SlackUserInfo>>
  /** Past the wrong-code cap (shared with link codes: store.ts linkAttemptsBlocked). */
  attemptsBlocked(now: number): Promise<boolean>
  recordFailedAttempt(): Promise<void>
  countToday(guest: AgentGuest, sinceMs: number): Promise<number>
  ownerName(ownerUserId: string, workspaceId: string): Promise<string>
  /** Answer in the DM. */
  reply(text: string): Promise<void>
  /** Write the message into the guest's thread and request its turn. */
  deliver(guest: AgentGuest): Promise<void>
  /** The invite key (null: no invite can be checked, so none binds). */
  inviteKey: string | null
}

export const GUEST_SLACK_REPLIES = {
  welcome: (owner: string) => `You're set. This is ${owner}'s Dial8 agent: message me here anytime for help.`,
  conflict: () => 'This Slack account already messages another Dial8 agent, so this invite can’t be used here. Ask whoever invited you.',
  limited: (owner: string) => `That's the most messages ${owner}'s agent can answer today. Try again tomorrow.`,
  tooManyCodes: () => 'Too many wrong codes. Try again in an hour.',
  notMember: () => "I can only take an invite from a member of this Slack workspace.",
  noText: () => 'I can only read words for now. Message me what you need.',
} as const

/**
 * A DM from an unlinked member of a live team, as a guest's: the outcome, or
 * null when it isn't one (the "link your account" reply takes it). Throws on
 * a failed store call.
 */
export async function handleGuestSlackDm(
  input: { teamId: string; slackUserId: string; workspaceId: string; text: string },
  deps: GuestSlackDeps,
  now: number = Date.now(),
): Promise<GuestSlackOutcome | null> {
  // 1. A bound guest: their agent.
  const active = await deps.findActive({ teamId: input.teamId, slackUserId: input.slackUserId, workspaceId: input.workspaceId })
  if (active) {
    if (!input.text.trim()) {
      await deps.reply(GUEST_SLACK_REPLIES.noText())
      return 'guest_no_text'
    }
    if ((await deps.countToday(active, now - DAY_MS)) >= GUEST_SLACK_DAILY_CAP) {
      await deps.reply(GUEST_SLACK_REPLIES.limited(await deps.ownerName(active.ownerUserId, active.workspaceId)))
      return 'guest_limited'
    }
    await deps.deliver(active)
    return 'guest_queued'
  }

  // 2. An invite code for a guest of this workspace.
  const candidates = codeCandidates(input.text)
  if (!candidates.length || !deps.inviteKey) return null
  if (await deps.attemptsBlocked(now)) {
    await deps.reply(GUEST_SLACK_REPLIES.tooManyCodes())
    return 'guest_code_blocked'
  }
  const key = deps.inviteKey
  const invites = await deps.findInvites(input.workspaceId, now)
  const match = invites.find(({ guest, inviteHash }) =>
    candidates.some((code) => inviteCodeMatches(code, { guestId: guest.id, phone: guest.phone ?? '' }, inviteHash, key)),
  )
  if (!match) {
    await deps.recordFailedAttempt().catch(() => {})
    return null
  }
  // A real member of this team: never a bot, a deactivated account or a stranger.
  const sender = await deps.sender()
  const user = sender.ok ? sender.user : undefined
  if (!user || user.is_stranger || user.is_bot || user.deleted || (user.team_id && user.team_id !== input.teamId)) {
    await deps.reply(GUEST_SLACK_REPLIES.notMember())
    return 'guest_not_member'
  }
  const bound = await deps.bind(match.guest, { teamId: input.teamId, slackUserId: input.slackUserId }, now)
  if (bound.ok) {
    await deps.reply(GUEST_SLACK_REPLIES.welcome(await deps.ownerName(bound.guest.ownerUserId, bound.guest.workspaceId)))
    return 'guest_welcomed'
  }
  if (bound.reason === 'conflict') {
    await deps.reply(GUEST_SLACK_REPLIES.conflict())
    return 'guest_conflict'
  }
  // Used, renewed or removed in the meantime, or a failed write: not a guest's message after all.
  return null
}

/** The Slack calls delivering a guest's DM makes (the installation's bot token). */
export interface GuestDmSlack {
  react: (channel: string, ts: string, name: string) => Promise<SlackApiResult<object>>
}

/**
 * Write a guest's DM into their thread as their message (`slack-in:<team>:<channel>:<ts>`,
 * so a replayed event converges on one row), log it for the owner, and
 * request its Slack turn with their `guestId`. Throws when the message could
 * not be written.
 */
export async function deliverGuestSlackDm(
  supabase: SupabaseClient,
  args: { guest: AgentGuest; dm: Dm; installation: Pick<SlackInstallation, 'bot_user_id'> },
  slack: GuestDmSlack,
  deps: { send?: (event: { name: string; id: string; data: HomeTurnRequestedData }) => Promise<unknown>; logActivity?: typeof recordGuestActivity } = {},
): Promise<{ conversationId: string } | null> {
  const { guest, dm } = args
  const text = slackTextToPlain(dm.text, { botUserId: args.installation.bot_user_id })
  if (!text) return null
  const thread = await ensureGuestThread(supabase, guest, SLACK_CHANNEL)
  const messageId = slackMessageId(dm.teamId, dm.channel, dm.ts)
  const written = await persistEveMessage(supabase, {
    conversationId: thread.id,
    userId: guest.ownerUserId,
    workspaceId: guest.workspaceId,
    role: 'user',
    parts: [{ type: 'text', text }],
    messageId,
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: SLACK_CHANNEL, slack: { team_id: dm.teamId, ts: dm.ts }, guest_id: guest.id },
  })
  // A replay finds the row already there (written: false, no reason): still request the turn.
  if (!written.written && written.reason) throw new Error(`guest slack message not written (${written.reason})`)
  if (written.written) {
    await (deps.logActivity ?? recordGuestActivity)(supabase, { guest, conversationId: thread.id, messageId, text, channel: 'slack' })
  }
  await slack.react(dm.channel, dm.ts, WORKING_REACTION).catch(() => null)
  const data: HomeTurnRequestedData = {
    conversationId: thread.id,
    userId: guest.ownerUserId,
    workspaceId: guest.workspaceId,
    workItemIds: [],
    reason: 'slack',
    guestId: guest.id,
  }
  await (deps.send ?? ((e) => inngest.send(e as never)))({ name: SLACK_TURN_EVENT, id: `slack-turn-${messageId}`, data })
  return { conversationId: thread.id }
}

// ── Answering a guest on Slack ──────────────────────────────────────────────

/** Where a guest's Slack turn answers: their DM with the app, in the team they are bound in. */
export interface GuestSlackTarget {
  teamId: string
  slackUserId: string
  /** The installation row's own id, never the row's word. */
  installationId: string
}

/**
 * The guest's Slack account, when they may still be answered there: active,
 * this owner's, Slack among their channels, bound in a team whose live
 * installation belongs to the guest's workspace. Null otherwise. Never throws.
 */
export async function guestSlackTarget(supabase: SupabaseClient, scope: { guestId: string; ownerUserId: string; workspaceId: string }): Promise<GuestSlackTarget | null> {
  try {
    const { data, error } = await supabase
      .from('agent_guest')
      .select(AGENT_GUEST_SELECT)
      .eq('id', scope.guestId)
      .eq('owner_user_id', scope.ownerUserId)
      .eq('workspace_id', scope.workspaceId)
      .eq('state', 'active')
      .maybeSingle()
    if (error || !data) return null
    const g = toGuest(data as GuestRow)
    if (!g.channels.includes('slack') || !g.slackTeamId || !g.slackUserId) return null
    const installation = await getInstallation(supabase, g.slackTeamId)
    if (!installation || installation.status !== 'active' || installation.workspace_id !== scope.workspaceId) return null
    return { teamId: g.slackTeamId, slackUserId: g.slackUserId, installationId: installation.connect_installation_id }
  } catch {
    return null
  }
}

/** Which channel the guest last messaged their agent on (their newest message in their thread); null when none. Never throws. */
export async function lastGuestChannel(supabase: SupabaseClient, conversationId: string): Promise<GuestChannel | null> {
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('ui_message_id')
      .eq('conversation_id', conversationId)
      .or(`ui_message_id.like.${SLACK_MESSAGE_ID_PREFIX}*,ui_message_id.like.${SMS_MESSAGE_ID_PREFIX}*`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ ui_message_id: string | null }>()
    if (error || !data?.ui_message_id) return null
    return data.ui_message_id.startsWith(SLACK_MESSAGE_ID_PREFIX) ? 'slack' : 'sms'
  } catch {
    return null
  }
}

export interface MessageGuestDeps {
  text?: typeof textGuest
  /** Post into the guest's DM (the real one opens it with the bot token). */
  slack?: (target: GuestSlackTarget, body: string) => Promise<{ sent: true } | { sent: false; reason: string }>
}

/**
 * Send a guest `body` outside a turn (an answer from the owner's agent): on
 * the channel they last messaged on, by text otherwise; Slack when that is
 * the only way left to reach them. Never throws.
 */
export async function messageGuest(
  supabase: SupabaseClient,
  args: { guestId: string; ownerUserId: string; workspaceId: string; conversationId: string | null; body: string; kind: 'guest_reply' | 'guest_notice' },
  deps: MessageGuestDeps = {},
): Promise<{ sent: true; channel: GuestChannel } | { sent: false; reason: string }> {
  const last = args.conversationId ? await lastGuestChannel(supabase, args.conversationId) : null
  const target = await guestSlackTarget(supabase, { guestId: args.guestId, ownerUserId: args.ownerUserId, workspaceId: args.workspaceId })
  const viaText = async () => {
    const sent = await (deps.text ?? textGuest)(supabase, { guestId: args.guestId, ownerUserId: args.ownerUserId, body: args.body, kind: args.kind })
    return sent.sent ? ({ sent: true, channel: 'sms' } as const) : ({ sent: false, reason: sent.reason } as const)
  }
  if (target && last !== 'sms') {
    const posted = await (deps.slack ?? postToGuestSlack)(target, args.body)
    if (posted.sent) return { sent: true, channel: 'slack' }
    if (last === 'slack') return posted
  }
  return viaText()
}

async function postToGuestSlack(target: GuestSlackTarget, body: string): Promise<{ sent: true } | { sent: false; reason: string }> {
  // Server-only Slack calls, loaded here so this module stays importable from tests without Connect.
  const { openSlackDm, slackTurnSlack } = await import('@/lib/slack/deps')
  const { markdownToSlack } = await import('@/lib/slack/format')
  const text = markdownToSlack(body)
  // Nothing left once its HTML comments go, as textGuest says for a text.
  if (!text) return { sent: false, reason: 'empty' }
  const channel = await openSlackDm(target.installationId, target.slackUserId).catch(() => null)
  if (!channel) return { sent: false, reason: 'no_dm' }
  const sent = await slackTurnSlack(target.installationId)
    .post({ channel, text })
    .catch(() => ({ ok: false as const, error: 'request_failed' }))
  return sent.ok ? { sent: true } : { sent: false, reason: sent.error }
}

/** The real store and Slack calls behind {@link handleGuestSlackDm}. */
export function supabaseGuestSlackDeps(
  supabase: SupabaseClient,
  args: {
    dm: Dm
    installation: SlackInstallation
    token: string
    slack: {
      userInfo: (token: string, slackUserId: string) => Promise<SlackApiResult<SlackUserInfo>>
      post: (token: string, message: { channel: string; text: string }) => Promise<SlackApiResult<{ ts?: string }>>
      react: GuestDmSlack['react']
    }
    attemptsBlocked: (now: number) => Promise<boolean>
    recordFailedAttempt: () => Promise<void>
    inviteKey: string | null
  },
): GuestSlackDeps {
  const { dm, installation, token, slack } = args
  return {
    findActive: (who) => findActiveGuestBySlack(supabase, who),
    findInvites: (workspaceId, now) => findOpenSlackInvites(supabase, workspaceId, now),
    bind: (target, binding, now) => bindGuestSlack(supabase, target, binding, now),
    sender: () => slack.userInfo(token, dm.slackUserId),
    attemptsBlocked: args.attemptsBlocked,
    recordFailedAttempt: args.recordFailedAttempt,
    countToday: (guest, sinceMs) => countGuestSlackMessagesSince(supabase, guest, sinceMs),
    ownerName: (ownerUserId, workspaceId) => ownerDisplayName(supabase, ownerUserId, workspaceId),
    reply: async (text) => {
      const sent = await slack.post(token, { channel: dm.channel, text })
      if (!sent.ok) console.warn('[guest-slack] reply failed', { teamId: dm.teamId, error: sent.error })
    },
    deliver: async (guest) => {
      await deliverGuestSlackDm(supabase, { guest, dm, installation }, { react: slack.react })
      await touchGuestInbound(supabase, guest.id)
    },
    inviteKey: args.inviteKey,
  }
}
