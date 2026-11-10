/**
 * A Slack DM as a turn in the person's home thread (docs/plans/slack-connect.md
 * §2 decision 14, §4 piece 5): the intake half and the reply half. The turn
 * itself is a home turn with reason 'slack' (src/lib/chat/home-turn-server.ts),
 * run by its own consumer (src/lib/inngest/slack-turn.ts).
 *
 * Intake ({@link deliverSlackDm}), called by the events route once
 * src/lib/slack/inbound.ts has decided the sender is the person (their linked
 * Slack account, in the Slack team bound to this workspace):
 *   - they must still be a member of the workspace (else one notice, nothing
 *     written);
 *   - the message is written into their home thread as THEIR message (id
 *     `slack-in:<team>:<channel>:<ts>`: a retried event converges on one row),
 *     with where it came from in its metadata (the reply goes back there);
 *   - an 👀 reaction on their message says Native Intelligence is on it;
 *   - `slack/turn.requested` is sent (its id is the message's, so a retry
 *     never starts a second turn).
 *
 * Reply ({@link settleSlackTurn}): finish the turn (write the reply unless it
 * is empty), then post the reply as stored in the thread back to the DM,
 * claimed on the row first (home_turn.reply_sent_at, one conditional update),
 * so a retried step never posts twice. A failed turn posts a short notice.
 * The 👀 comes off either way.
 *
 * Privacy: an Inngest step output is stored, so the plan step hands on the
 * messages' ids only ({@link redactChannelPlan}), the send step reads the
 * words back ({@link hydrateChannelPlan}), and the reply is read back from the
 * thread inside the step that posts it. Logs carry ids and outcomes, never
 * words.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { ensureHomeThread } from '@/lib/chat/home-thread'
import { persistEveMessage } from '@/lib/chat/eve-message-writer'
import { CHANNEL_MESSAGE_KIND, SLACK_CHANNEL, SLACK_MESSAGE_ID_PREFIX, slackMessageId, type PlannedChannelMessage } from '@/lib/chat/channel-turn'
import { homeTurnMessageId, isQuietReply, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { replyTextOfParts } from '@/lib/chat/channel-reply'
import {
  finishHomeTurn,
  type HomeTurnPlanResult,
  type HomeTurnReadResult,
  type HomeTurnRow,
  type HomeTurnSkip,
} from '@/lib/chat/home-turn-server'
import { appOrigin } from './config'
import { slackTextToPlain, type SlackInbound } from './events'
import { claimReachNotice } from '@/lib/reach/notice'
import { approvalBlocks, approvalsRaisedSince } from './approvals'
import { markdownToSlack } from './format'
import {
  ensureSlackThread,
  getInstallation,
  linksForUser,
  memberRole,
  noteThreadMention,
  threadForConversation,
  type SlackInstallation,
  type SlackUserLink,
} from './store'
import type { SlackApiResult } from './web-api'
import { guestSlackTarget } from '@/lib/guests/slack'

/** The Inngest event a Slack turn is requested with (home/turn.requested's data, reason 'slack'). */
export const SLACK_TURN_REQUESTED_EVENT = 'slack/turn.requested' as const

/** The reaction that says Native Intelligence is working on a message. */
export const WORKING_REACTION = 'eyes'

type Dm = Extract<SlackInbound, { kind: 'dm' }>

/**
 * What a Slack message's home-thread row keeps of where it came from: its
 * team and its ts. The person can write their own chat_messages rows, so this
 * is only ever a hint ({@link replyOrigin} rebuilds the target from what the
 * server holds).
 */
export interface SlackMessageRef {
  team_id: string
  ts: string
}

/** Where a turn's reply goes: rebuilt by {@link replyOrigin}, never read from a row. */
export interface SlackOrigin {
  team_id: string
  /**
   * Where the reply is posted: the person's own DM with the bot, or the
   * channel of the Slack thread their conversation answers (slack_thread).
   */
  channel_id: string
  /** The thread the reply goes in (a channel thread only). */
  thread_ts?: string
  /**
   * The person's own DM with the bot (conversations.open with their linked
   * Slack user): approval cards go here, never into a channel thread others
   * read. Absent when it can't be opened (the cards wait in Native Intelligence).
   */
  dm_channel_id?: string
  /** The message the 👀 is on (a DM: a hint from the row, in their own DM; a thread: the server's own last_mention_ts). */
  ts: string
  /**
   * Every carried message's ts in this channel (from the turn's own message
   * ids): the 👀 comes off each, not just the newest. Only the bot's own
   * reaction can be removed, so a wrong one changes nothing.
   */
  reaction_ts?: string[]
  /** The person's own Slack user: a channel thread's notices go to them alone (ephemeral). */
  slack_user_id?: string
  /** The installation row's own id, never the row's word. */
  installation_id: string
}

/** The Slack calls the turn makes; the real ones come from ./web-api.ts with a Connect token. */
export interface SlackTurnSlack {
  post: (message: { channel: string; text: string; thread_ts?: string; blocks?: unknown[] }) => Promise<SlackApiResult<{ ts?: string }>>
  /** A message only `user` sees, in a channel (chat.postEphemeral). */
  ephemeral: (message: { channel: string; user: string; text: string; thread_ts?: string }) => Promise<SlackApiResult<object>>
  react: (channel: string, ts: string, name: string) => Promise<SlackApiResult<object>>
  unreact: (channel: string, ts: string, name: string) => Promise<SlackApiResult<object>>
}

type Mention = Extract<SlackInbound, { kind: 'mention' }>

// ── Intake ──────────────────────────────────────────────────────────────────

export type DeliverOutcome = 'queued' | 'not_member' | 'empty'

/**
 * Write a linked person's DM into their home thread and request its turn.
 * Throws when the message could not be written (the route's after() logs it;
 * Slack has been acked, so nothing retries it).
 */
export async function deliverSlackDm(
  supabase: SupabaseClient,
  input: { dm: Dm; installation: SlackInstallation; link: SlackUserLink },
  slack: SlackTurnSlack,
  deps: { send?: (event: { name: string; id: string; data: HomeTurnRequestedData }) => Promise<unknown> } = {},
): Promise<DeliverOutcome> {
  const { dm, installation, link } = input
  const role = await memberRole(supabase, installation.workspace_id, link.user_id)
  if (!role || role === 'guest') {
    await slack.post({ channel: dm.channel, text: SLACK_TURN_NOTICES.not_member() })
    return 'not_member'
  }
  const text = slackTextToPlain(dm.text, { botUserId: installation.bot_user_id })
  if (!text) return 'empty'

  const home = await ensureHomeThread(supabase, { userId: link.user_id, workspaceId: installation.workspace_id })
  const ref: SlackMessageRef = { team_id: dm.teamId, ts: dm.ts }
  const messageId = slackMessageId(dm.teamId, dm.channel, dm.ts)
  const written = await persistEveMessage(supabase, {
    conversationId: home.id,
    userId: link.user_id,
    workspaceId: installation.workspace_id,
    role: 'user',
    parts: [{ type: 'text', text }],
    messageId,
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: SLACK_CHANNEL, slack: ref },
  })
  // A replay finds the row already there (written: false, no reason): still request the turn.
  if (!written.written && written.reason) throw new Error(`slack message not written (${written.reason})`)

  await slack.react(dm.channel, dm.ts, WORKING_REACTION).catch(() => null)
  const data: HomeTurnRequestedData = {
    conversationId: home.id,
    userId: link.user_id,
    workspaceId: installation.workspace_id,
    workItemIds: [],
    reason: 'slack',
  }
  await (deps.send ?? ((e) => inngest.send(e as never)))({ name: SLACK_TURN_REQUESTED_EVENT, id: `slack-turn-${messageId}`, data })
  return 'queued'
}

/**
 * Write a linked person's @mention in a channel thread into THEIR OWN
 * conversation for that thread (made on their first mention there:
 * store.ts ensureSlackThread; never their home thread, never anyone else's)
 * and request its turn. The reply goes back into the thread. Notices that
 * concern only them are ephemeral. Throws when the message could not be
 * written.
 */
export async function deliverSlackMention(
  supabase: SupabaseClient,
  input: { mention: Mention; installation: SlackInstallation; link: SlackUserLink },
  slack: SlackTurnSlack,
  deps: { send?: (event: { name: string; id: string; data: HomeTurnRequestedData }) => Promise<unknown> } = {},
): Promise<DeliverOutcome> {
  const { mention, installation, link } = input
  const role = await memberRole(supabase, installation.workspace_id, link.user_id)
  if (!role || role === 'guest') {
    await slack.ephemeral({ channel: mention.channel, user: mention.slackUserId, text: SLACK_TURN_NOTICES.not_member(), thread_ts: mention.threadTs })
    return 'not_member'
  }
  const text = slackTextToPlain(mention.text, { botUserId: installation.bot_user_id })
  if (!text) return 'empty'

  const thread = await ensureSlackThread(supabase, {
    teamId: mention.teamId,
    channelId: mention.channel,
    threadTs: mention.threadTs,
    userId: link.user_id,
    workspaceId: installation.workspace_id,
    title: `Slack: ${text.replace(/\s+/g, ' ').slice(0, 60)}`,
  })
  const ref: SlackMessageRef = { team_id: mention.teamId, ts: mention.ts }
  const messageId = slackMessageId(mention.teamId, mention.channel, mention.ts)
  const written = await persistEveMessage(supabase, {
    conversationId: thread.conversation_id,
    userId: link.user_id,
    workspaceId: installation.workspace_id,
    role: 'user',
    parts: [{ type: 'text', text }],
    messageId,
    metadata: { kind: CHANNEL_MESSAGE_KIND, channel: SLACK_CHANNEL, slack: ref },
  })
  if (!written.written && written.reason) throw new Error(`slack mention not written (${written.reason})`)

  await noteThreadMention(supabase, thread.conversation_id, mention.ts).catch(() => null)
  await slack.react(mention.channel, mention.ts, WORKING_REACTION).catch(() => null)
  const data: HomeTurnRequestedData = {
    conversationId: thread.conversation_id,
    userId: link.user_id,
    workspaceId: installation.workspace_id,
    workItemIds: [],
    reason: 'slack',
  }
  await (deps.send ?? ((e) => inngest.send(e as never)))({ name: SLACK_TURN_REQUESTED_EVENT, id: `slack-turn-${messageId}`, data })
  return 'queued'
}

// ── The person's words out of step outputs: shared by every channel ──────────

export { hydrateChannelPlan, plannedMessageIds, redactChannelPlan } from '@/lib/chat/channel-turn-server'

/**
 * Where to answer, rebuilt from what the server holds (the person can write
 * their own chat_messages rows, so a row is never where a reply is sent):
 *   - a conversation that answers a Slack channel thread (its slack_thread
 *     row, service-written): that thread, in that channel;
 *   - their home thread: their own DM with the bot. The newest carried
 *     message's row names its team (a hint only).
 * Either way the team must have a live installation bound to the turn's
 * workspace and the person must be linked in it; the DM is opened from their
 * linked Slack user (`openDm`, conversations.open; approval cards go there),
 * with the installation row's own id. Null when any of that fails (the reply
 * stays in Native Intelligence). Never throws.
 */
export async function replyOrigin(
  supabase: SupabaseClient,
  data: Pick<HomeTurnRequestedData, 'conversationId' | 'userId' | 'workspaceId' | 'guestId'>,
  messageIds: readonly string[],
  deps: { openDm: (installationId: string, slackUserId: string) => Promise<string | null> },
): Promise<SlackOrigin | null> {
  const last = messageIds[messageIds.length - 1]
  if (!last) return null
  try {
    // A guest's turn (guest access, migration 434): their own DM, from the
    // Slack account bound to them, in a live team of the owner's workspace.
    // No dm_channel_id: the owner's approval cards never go to a guest.
    if (data.guestId) {
      const target = await guestSlackTarget(supabase, { guestId: data.guestId, ownerUserId: data.userId, workspaceId: data.workspaceId })
      if (!target) return null
      const channel = await deps.openDm(target.installationId, target.slackUserId)
      if (!channel || !/^D[A-Z0-9]{2,30}$/.test(channel)) return null
      const ref = parseRef((await messageRow(supabase, data, last))?.ui_message?.metadata?.slack)
      return {
        team_id: target.teamId,
        channel_id: channel,
        ts: ref?.team_id === target.teamId ? ref.ts : '',
        reaction_ts: carriedTs(messageIds, target.teamId, channel),
        slack_user_id: target.slackUserId,
        installation_id: target.installationId,
      }
    }
    const thread = await threadForConversation(supabase, data.conversationId, data.userId)
    if (thread) {
      const installation = await getInstallation(supabase, thread.slack_team_id)
      if (!installation || installation.status !== 'active' || installation.workspace_id !== data.workspaceId) return null
      const [link] = await linksForUser(supabase, data.userId, [thread.slack_team_id])
      if (!link) return null
      const dm = await deps.openDm(installation.connect_installation_id, link.slack_user_id).catch(() => null)
      return {
        team_id: thread.slack_team_id,
        channel_id: thread.channel_id,
        thread_ts: thread.thread_ts,
        ...(dm && /^D[A-Z0-9]{2,30}$/.test(dm) ? { dm_channel_id: dm } : {}),
        ts: thread.last_mention_ts ?? thread.thread_ts,
        reaction_ts: carriedTs(messageIds, thread.slack_team_id, thread.channel_id),
        slack_user_id: link.slack_user_id,
        installation_id: installation.connect_installation_id,
      }
    }
    const row = await messageRow(supabase, data, last)
    if (!row) return null
    const ref = parseRef(row.ui_message?.metadata?.slack)
    if (!ref) return null
    const installation = await getInstallation(supabase, ref.team_id)
    if (!installation || installation.status !== 'active' || installation.workspace_id !== data.workspaceId) return null
    const [link] = await linksForUser(supabase, data.userId, [ref.team_id])
    if (!link) return null
    const channel = await deps.openDm(installation.connect_installation_id, link.slack_user_id)
    if (!channel || !/^D[A-Z0-9]{2,30}$/.test(channel)) return null
    return {
      team_id: ref.team_id,
      channel_id: channel,
      dm_channel_id: channel,
      ts: ref.ts,
      reaction_ts: carriedTs(messageIds, ref.team_id, channel),
      slack_user_id: link.slack_user_id,
      installation_id: installation.connect_installation_id,
    }
  } catch {
    return null
  }
}

/** A carried message's row in the turn's conversation (its metadata names where it came from: a hint only). Null when missing; throws on a failed read. */
async function messageRow(
  supabase: SupabaseClient,
  data: Pick<HomeTurnRequestedData, 'conversationId' | 'userId'>,
  messageId: string,
): Promise<{ ui_message: { metadata?: { slack?: unknown } } | null } | null> {
  const { data: row, error } = await supabase
    .from('chat_messages')
    .select('ui_message')
    .eq('conversation_id', data.conversationId)
    .eq('user_id', data.userId)
    .eq('ui_message->>id', messageId)
    .maybeSingle<{ ui_message: { metadata?: { slack?: unknown } } | null }>()
  if (error) throw new Error(error.message)
  return row ?? null
}

/**
 * The ts of each carried message that came from this team and channel, read
 * from the turn's own message ids (`slack-in:<team>:<channel>:<ts>`). Used
 * only to take the bot's own 👀 off them.
 */
export function carriedTs(messageIds: readonly string[], teamId: string, channel: string): string[] {
  const prefix = `${SLACK_MESSAGE_ID_PREFIX}${teamId}:${channel}:`
  return messageIds.flatMap((id) => {
    if (!id.startsWith(prefix)) return []
    const ts = id.slice(prefix.length)
    return /^[0-9]{1,12}\.[0-9]{1,8}$/.test(ts) ? [ts] : []
  })
}

/**
 * Take the 👀 off, then say `text` to the person: in a DM as a message; in a
 * channel thread only to them (ephemeral), since it concerns no one else.
 * Never throws.
 */
export async function noticeToPerson(origin: SlackOrigin, slack: SlackTurnSlack, text: string, opts: { unreact?: boolean } = {}): Promise<void> {
  if (opts.unreact !== false) await unreactCarried(origin, slack)
  if (origin.thread_ts) {
    if (!origin.slack_user_id) return
    await slack.ephemeral({ channel: origin.channel_id, user: origin.slack_user_id, text, thread_ts: origin.thread_ts }).catch(() => null)
    return
  }
  await slack.post({ channel: origin.channel_id, text }).catch(() => null)
}

/** The bot's own 👀 off every carried message (else the newest). Never throws. */
async function unreactCarried(origin: SlackOrigin, slack: SlackTurnSlack): Promise<void> {
  const each = origin.reaction_ts?.length ? origin.reaction_ts : [origin.ts]
  for (const ts of each) await slack.unreact(origin.channel_id, ts, WORKING_REACTION).catch(() => null)
}

function parseRef(raw: unknown): SlackMessageRef | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const ok = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v)
  if (!ok(o.team_id, /^T[A-Z0-9]{2,30}$/) || !ok(o.ts, /^[0-9]{1,12}\.[0-9]{1,8}$/)) return null
  return { team_id: o.team_id as string, ts: o.ts as string }
}

// ── Settling the turn ───────────────────────────────────────────────────────

/** What a settled Slack turn hands the consumer (ids and outcomes only). */
export interface SlackTurnSettled {
  outcome: string
  written: boolean
  posted: boolean
  /** Approval cards posted as Slack blocks after the reply. */
  approvals?: number
  postReason?: string
  notice?: 'failed' | 'unfinished'
}

/**
 * Finish the turn (write the reply unless it is empty), then post it back to
 * `to` (null: nowhere to answer, the reply stays in the home thread):
 * the reply when one is in the thread (written now, or by an earlier attempt:
 * reply_sent_at still guards a second post), a 'failed' notice for a turn
 * that failed, was cancelled or lost its session with nothing to say, an
 * 'unfinished' one for a turn still running at the read cap. Never throws.
 */
export async function settleSlackTurn(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: Pick<HomeTurnRow, 'id' | 'created_at'>,
  read: HomeTurnReadResult,
  to: { origin: SlackOrigin; slack: SlackTurnSlack } | null,
  deps: { finish?: typeof finishHomeTurn; now?: () => number; origin?: string } = {},
): Promise<SlackTurnSettled> {
  const finished = await (deps.finish ?? finishHomeTurn)(supabase, data, row, read)
  const outcome = read.done && read.end !== 'completed' ? `${finished.outcome}:${read.end}` : finished.outcome
  if (!to) return { outcome, written: finished.written, posted: false, postReason: 'no_origin' }
  const { origin, slack } = to
  // A guest is told in their own words: they have no Native Intelligence to look in.
  const notices = data.guestId ? GUEST_SLACK_TURN_NOTICES : SLACK_TURN_NOTICES
  if (!read.done) {
    await noticeToPerson(origin, slack, notices.unfinished())
    return { outcome, written: finished.written, posted: false, notice: 'unfinished' }
  }
  await unreactCarried(origin, slack)
  const posted = await postSlackTurnReply(supabase, { ...data, rowId: row.id }, origin, slack, deps)
  // What the turn held for the person's yes goes to them where they are (piece 6).
  // Never a guest's: what their turn held is the owner's to approve, in Native Intelligence.
  const approvals = row.created_at && !data.guestId ? await postRaisedApprovals(supabase, { ...data, since: row.created_at }, origin, slack) : 0
  if (posted.posted) return { outcome, written: finished.written, posted: true, ...(approvals ? { approvals } : {}) }
  if (posted.reason === 'quiet' && (read.end === 'failed' || read.end === 'cancelled' || read.end === 'session_ended')) {
    // The 👀 came off above.
    await noticeToPerson(origin, slack, notices.failed(), { unreact: false })
    return { outcome, written: finished.written, posted: false, postReason: posted.reason, notice: 'failed' }
  }
  return { outcome, written: finished.written, posted: false, postReason: posted.reason }
}

/**
 * Post a finished turn's reply, read back from the home thread
 * (`home-turn:<row>`), so it is posted whether this attempt wrote it or an
 * earlier one did. Nothing when there is none or it is empty. Claims the
 * row's reply_sent_at first, so a retried step never posts twice: at most
 * once (a post that fails after the claim is not retried; the reply is in
 * the home thread either way). Never throws.
 */
export async function postSlackTurnReply(
  supabase: SupabaseClient,
  args: { userId: string; conversationId: string; rowId: string; guestId?: string },
  origin: SlackOrigin,
  slack: SlackTurnSlack,
  deps: { now?: () => number; origin?: string } = {},
): Promise<{ posted: true } | { posted: false; reason: string }> {
  let text: string
  try {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('ui_message')
      .eq('conversation_id', args.conversationId)
      .eq('user_id', args.userId)
      .eq('ui_message->>id', homeTurnMessageId(args.rowId))
      .maybeSingle<{ ui_message: { parts?: unknown } | null }>()
    if (error) return { posted: false, reason: 'lookup_failed' }
    text = replyTextOfParts(data?.ui_message?.parts)
  } catch {
    return { posted: false, reason: 'lookup_failed' }
  }
  if (isQuietReply(text)) return { posted: false, reason: 'quiet' }
  // A guest has no Native Intelligence to open: no "more in Native Intelligence" link for them.
  const body = markdownToSlack(text, args.guestId ? {} : { moreLink: `${deps.origin ?? appOrigin()}/account` })
  // Nothing left once its HTML comments go (a reply that was only `<!-- card:4 -->`).
  if (!body) return { posted: false, reason: 'quiet' }
  if (!(await claimReply(supabase, args.rowId, deps.now))) return { posted: false, reason: 'already_sent' }
  const sent = await slack.post({ channel: origin.channel_id, text: body, ...inThread(origin) }).catch(() => ({ ok: false as const, error: 'request_failed' }))
  return sent.ok ? { posted: true } : { posted: false, reason: sent.error }
}

/** The thread a post goes in, when the turn answers a channel thread. */
export function inThread(origin: Pick<SlackOrigin, 'thread_ts'>): { thread_ts?: string } {
  return origin.thread_ts ? { thread_ts: origin.thread_ts } : {}
}

/**
 * Post each approval the turn raised as Slack blocks (approvals.ts), after the
 * reply: claimed per approval first (reach_notice), so a retried step or the
 * "needs you" ping never posts one twice. Returns how many were posted.
 * Never throws.
 */
async function postRaisedApprovals(
  supabase: SupabaseClient,
  scope: { userId: string; workspaceId: string; conversationId: string; since: string },
  origin: SlackOrigin,
  slack: SlackTurnSlack,
): Promise<number> {
  // Always the person's own DM: a card says what it would do, never in a thread others read.
  if (!origin.dm_channel_id) return 0
  let posted = 0
  for (const approval of await approvalsRaisedSince(supabase, scope)) {
    const claim = await claimReachNotice(supabase, { userId: scope.userId, workspaceId: scope.workspaceId, approvalId: approval.approvalId, channel: 'slack' })
    if (claim === 'taken') continue
    const sent = await slack.post({ channel: origin.dm_channel_id, ...approvalBlocks(approval) }).catch(() => null)
    if (sent?.ok) posted++
  }
  return posted
}

/** One conditional update: true when this call set reply_sent_at (nobody had). */
async function claimReply(supabase: SupabaseClient, rowId: string, now?: () => number): Promise<boolean> {
  try {
    const at = new Date((now ?? Date.now)()).toISOString()
    const { data, error } = await supabase.from('home_turn').update({ reply_sent_at: at, updated_at: at }).eq('id', rowId).is('reply_sent_at', null).select('id')
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

// ── Notices ─────────────────────────────────────────────────────────────────

/** What the person is told in Slack when their message could not become a turn, or null to say nothing. */
export function slackTurnSkipNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished'): string | null {
  switch (reason) {
    case 'question_pending':
      return 'You have a question from me waiting in Native Intelligence. Answer it there, then message me again.'
    case 'usage_limited':
      return "You've reached your Native Intelligence usage limit, so I can't answer here right now. Check Settings > Billing in Native Intelligence."
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return SLACK_TURN_NOTICES.not_member()
    case 'busy':
      return "I'm still busy with something else in Native Intelligence. Message me again in a few minutes."
    case 'unfinished':
      return SLACK_TURN_NOTICES.unfinished()
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
      return SLACK_TURN_NOTICES.failed()
    default:
      return null
  }
}

/**
 * What a guest is told in Slack when their message could not become a turn,
 * or null to say nothing: the person's notices name Settings and the app,
 * which a guest doesn't have.
 */
export function guestSlackTurnSkipNotice(reason: HomeTurnSkip | 'busy' | 'failed' | 'unfinished'): string | null {
  switch (reason) {
    case 'usage_limited':
      return "I can't answer here right now. Try again later."
    case 'not_member':
    case 'no_conversation':
    case 'not_home':
      return "I can't answer you here right now."
    case 'busy':
      return "I'm still working on your last message. Message me again in a few minutes."
    case 'unfinished':
      return GUEST_SLACK_TURN_NOTICES.unfinished()
    case 'failed':
    case 'no_session':
    case 'lookup_failed':
    case 'usage_check_failed':
    case 'question_pending':
      return GUEST_SLACK_TURN_NOTICES.failed()
    default:
      return null
  }
}

export const GUEST_SLACK_TURN_NOTICES = {
  unfinished: () => "That's taking me too long. Message me again in a bit.",
  failed: () => "Sorry, I couldn't get to that just now. Try again in a minute.",
} as const

export const SLACK_TURN_NOTICES = {
  not_member: () => "Your Native Intelligence account isn't in the Native Intelligence workspace this Slack is connected to any more, so I can't answer here.",
  unfinished: () => "That's taking me a while. I'll keep the answer in Native Intelligence for you.",
  failed: () => "Sorry, I couldn't get to that just now. Try again in a minute, or open Native Intelligence.",
} as const
