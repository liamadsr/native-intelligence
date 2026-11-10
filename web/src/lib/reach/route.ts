/**
 * The router: the agent's messages find the person where they are
 * (docs/plans/reach-follows-you.md §3, Liam's answers in §7).
 *
 * Every writer of a message that routes (a home turn, the look-ahead, a
 * guest's note or request, an approval asked at home) sends one
 * `reach/route.requested` with ids only. The `reach-route` Inngest function
 * (src/lib/inngest/reach-route.ts) waits out a short grace, then runs
 * {@link planRoute} until there is nothing left to do:
 *
 *   gather   the thread's routed messages since max(seen, now - 24 h), oldest
 *            first, at most 25 live ones (./route-policy.ts says which and
 *            what each says), less any already claimed in reach_notice and
 *            any with nothing left to say (an answered ask, a look-ahead past
 *            its shelf life)
 *   seen     a message is seen when it is no newer than the thread's seen_at,
 *            or when the person wrote in the thread after it (any channel)
 *   present  at a Native Intelligence app (src/lib/presence): one `agent_message` banner
 *            (the native banner on the desktop, a toast otherwise) unless its
 *            writer already notified, then a recheck every 10 minutes for 2
 *            hours. Present but never opened: the last recheck claims what it
 *            bannered on 'banner', so those messages are done for good and no
 *            later run texts them. A message that only ever banners is
 *            claimed so when it is bannered
 *   absent   per message: the channel he last talked on (a text or Slack
 *            within 12 h, and after his last activity in an app), then push
 *            (iOS, no adapter yet), then a text (any linked phone that
 *            hasn't said STOP: dispatch.ts smsConsent), then Slack
 *   quiet    21:00 to 08:00 in his zone, on every channel: a routine message
 *            waits until 08:05 (with the morning digest); an urgent one
 *            (metadata.urgent_by, close enough) goes now
 *   send     oldest first, one text per message, each claimed first, so a
 *            retried step or a second run never sends one twice
 *
 * No caps on the person (Liam: "We don't need a text cap"), and no shadow
 * mode: REACH_ROUTE_LIVE=off is only a kill switch that logs what it would
 * have done and sends nothing.
 *
 * Privacy: a step output is stored by Inngest, so {@link planRoute} returns ids
 * and decisions only; the words are read and sent inside the step.
 *
 * {@link planRoute} is pure over {@link RouteDeps}; {@link liveRouteDeps} is the
 * real store and channels.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChannelApproval } from '@/lib/attention/channel-approvals'
import { SLACK_CHANNEL, SMS_CHANNEL } from '@/lib/chat/channel-turn'
import { isPresent, isUuid, type PresenceRow } from '@/lib/presence/presence'
import { readPresence } from '@/lib/presence/store'
import { slackTarget, smsConsent, smsQuietUntil, type SlackReachTarget, type SmsConsent } from './dispatch'
import { claimReachNotice, claimedReachRefs, releaseTextedApproval, type ReachChannel, type ReachClaimChannel } from './notice'
import { ROUTED_MESSAGE_KINDS, agentMessageNoticeCopy, awayTextBody, routeOf, urgentNow, type OutboundMessage, type RoutedMessage, type RouteRef, type RouteRow } from './route-policy'

/** The Inngest event a route is requested with (ids only). */
export const REACH_ROUTE_EVENT = 'reach/route.requested' as const

export interface RouteRequestData {
  userId: string
  workspaceId: string
  /** The person's home thread the message is in. */
  conversationId: string
}

/** The grace before anything goes (he may be reading it), and how long a steady stream of messages can hold it back. */
export const REACH_ROUTE_DEBOUNCE_PERIOD = '2m'
export const REACH_ROUTE_DEBOUNCE_TIMEOUT = '5m'
/** How long a banner waits before the router looks again, and how many times (10 min × 12 = 2 h). */
export const REACH_ROUTE_RECHECK = '10m'
export const REACH_ROUTE_RECHECKS = 12
/** A routine message held by quiet hours goes this long after they end: with the 08:00 digest. */
export const QUIET_RELEASE_MS = 5 * 60_000
/** How far back the router looks, and how many messages it takes at once. */
export const ROUTE_LOOKBACK_MS = 24 * 60 * 60_000
export const ROUTE_GATHER_MAX = 25
/**
 * Pages of ROUTE_GATHER_MAX one round reads past messages already claimed or
 * with nothing left to say, looking for ROUTE_GATHER_MAX live ones before the
 * window ends: a bound on one step's reads, far past a day of messages.
 */
export const ROUTE_GATHER_PAGES = 20
/** How recent his own text or Slack message must be for its channel to win. */
export const STICKY_WINDOW_MS = 12 * 60 * 60_000

/** Where a message can go: the reach channels (push is the iOS app's slot, ordered but not built). */
export type RouteChannel = ReachChannel

/** Parse the event. Null when malformed. */
export function parseRouteRequested(raw: unknown): RouteRequestData | null {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return isUuid(d.userId) && isUuid(d.workspaceId) && isUuid(d.conversationId) ? { userId: d.userId, workspaceId: d.workspaceId, conversationId: d.conversationId } : null
}

/**
 * The event a writer sends: ids only. `key` (the message's own, e.g.
 * `home-turn:<row>`) makes a retried writer send it once; two different
 * messages never share one, so the second is never dropped.
 */
export function routeRequestEvent(data: RouteRequestData, key?: string): { name: typeof REACH_ROUTE_EVENT; data: RouteRequestData; id?: string } {
  return { name: REACH_ROUTE_EVENT, data: { userId: data.userId, workspaceId: data.workspaceId, conversationId: data.conversationId }, ...(key ? { id: `reach-route:${key}` } : {}) }
}

/**
 * Ask the router to look at a home thread, from outside an Inngest function
 * (a guest's note, an approval asked at home). Off the caller's path: the
 * Inngest client is loaded here only, and a failed send means the message
 * waits in the app. Never throws.
 */
export async function requestRoute(data: RouteRequestData, key?: string): Promise<void> {
  try {
    const { inngest } = await import('@/lib/inngest/client')
    await inngest.send(routeRequestEvent(data, key))
  } catch (err) {
    console.warn('[reach-route] not requested:', err instanceof Error ? err.message : String(err))
  }
}

/** Whether the router sends: live unless REACH_ROUTE_LIVE is `off` (the kill switch; nothing defaults to shadow). */
export function routeLive(env: Record<string, string | undefined> = process.env): boolean {
  return env.REACH_ROUTE_LIVE?.trim().toLowerCase() !== 'off'
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** His newest own message in the thread: when, and the channel it came by (metadata.channel), null for the app. */
export interface LatestUserMessage {
  createdAt: string
  channel: string | null
}

/** Where he can be reached outside the app right now. */
export interface RouteTargets {
  /** The iOS app's push. Its slot is ordered before a text, but no adapter exists yet: always false today. */
  push: boolean
  /** Whether his verified phone may be texted (dispatch.ts smsConsent); null for no texts. */
  sms: SmsConsent
  /** His Slack DM in this workspace, with the DMs on. */
  slack: SlackReachTarget | null
}

export interface RouteDeps {
  now?: () => number
  /** The thread's seen marker, or null when it isn't this person's home thread. */
  thread(input: RouteRequestData): Promise<{ seenAt: string | null } | null>
  latestUserMessage(input: RouteRequestData): Promise<LatestUserMessage | null>
  /** The thread's assistant messages of a routed kind newer than `sinceIso`, oldest first, at most `limit`. */
  messagesSince(input: RouteRequestData & { sinceIso: string; limit: number }): Promise<RouteRow[]>
  /** Which refs went out already, on any channel (`<type>:<id>`). */
  claimed(input: { userId: string; refs: RouteRef[] }): Promise<Set<string>>
  /** The approvals of these ids still pending, by id. */
  pendingApprovals(input: { userId: string; approvalIds: string[] }): Promise<Map<string, ChannelApproval>>
  presence(userId: string): Promise<PresenceRow[]>
  targets(input: RouteRequestData): Promise<RouteTargets>
  /** His zone; null when none is known. */
  timeZone(input: RouteRequestData): Promise<string | null>
  /** Claim a message (or an approval it carries) on a channel, or on 'banner' to settle it without sending. */
  claim(input: { userId: string; workspaceId: string; ref: RouteRef; channel: ReachClaimChannel; urgent: boolean }): Promise<'claimed' | 'taken' | 'unavailable'>
  /** Send one message on `channel`; true when it went. */
  send(input: { userId: string; workspaceId: string; channel: RouteChannel; slack: SlackReachTarget | null; message: OutboundMessage<ChannelApproval> }): Promise<boolean>
  /** Take back the text claim of an approval whose text didn't go (src/lib/reach/notice.ts releaseTextedApproval). */
  releaseTexted?(input: { userId: string; approvalId: string }): Promise<void>
  /**
   * One `agent_message` banner for the newest message (deduped on it); true
   * when one was created. `messageId` is its ui message id, so a click can
   * bring that message into the chat and land on it.
   */
  banner(input: RouteRequestData & { rowId: string; messageId: string | null; preview: string | null; count: number }): Promise<boolean>
}

/** What the kill switch would have done (logged, never done). */
export interface RouteWould {
  action: 'banner' | 'wait' | 'send'
  channel?: RouteChannel
  rows: number
  urgent?: boolean
}

export type RouteOutcome = 'not_home' | 'nothing' | 'no_channel' | 'banner_only' | 'bannered' | 'present_unread' | 'off'

/**
 * One round's decision. Ids, counts and times only: it is a step output.
 *   done    nothing more to do
 *   banner  he is at an app and was told; look again in REACH_ROUTE_RECHECK
 *   wait    quiet hours hold every message left; look again at `untilMs`
 *   sent    messages went (or were claimed and failed); look again now
 */
export type RouteDecision =
  | { kind: 'done'; outcome: RouteOutcome; rows: number; would?: RouteWould }
  | { kind: 'banner'; rows: number; bannered: boolean }
  | { kind: 'wait'; untilMs: number; rows: number; channel: RouteChannel }
  | { kind: 'sent'; channel: RouteChannel; sent: number; failed: number; skipped: number; urgent: boolean; rowIds: string[] }

/** A message the router will act on: its row, how it routes, and the approvals still pending. */
interface RouteItem {
  row: RouteRow
  route: RoutedMessage
  approvals: ChannelApproval[]
}

/** Whether a message still has something to say: a banner to give, words, or a pending approval's code. */
function isLive(item: RouteItem): boolean {
  if (item.route.kind === 'approval_ask') return item.approvals.length > 0
  if (!item.route.textable) return !item.route.notifies
  return !!item.route.text || item.approvals.length > 0
}

const refKey = (ref: RouteRef) => `${ref.type}:${ref.id}`

function time(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * The channel he last talked to the agent on, when it still counts: a text or
 * a Slack message within STICKY_WINDOW_MS, and after his last activity in an
 * app (typing in the app since takes it back). Null otherwise. Pure.
 */
export function stickyChannel(input: { latest: LatestUserMessage | null; presence: readonly PresenceRow[]; nowMs: number }): 'sms' | 'slack' | null {
  const { latest, nowMs } = input
  const lastActive = Math.max(0, ...input.presence.map((p) => time(p.active_at) ?? 0))
  const at = time(latest?.createdAt)
  if (!latest || at === null || nowMs - at > STICKY_WINDOW_MS || at <= lastActive) return null
  return latest.channel === SMS_CHANNEL ? 'sms' : latest.channel === SLACK_CHANNEL ? 'slack' : null
}

/** Where one message goes. */
export interface RouteChoice {
  channel: RouteChannel
}

/**
 * Where one message goes when he is away, in order: the sticky channel, push
 * (no adapter yet), a text (any linked phone that hasn't said STOP), Slack.
 * Null: nowhere. Pure.
 */
export function routeChoice(input: { targets: RouteTargets; sticky: 'sms' | 'slack' | null }): RouteChoice | null {
  const { targets, sticky } = input
  const sms = targets.sms === 'away'
  if (sticky === 'sms' && sms) return { channel: 'sms' }
  if (sticky === 'slack' && targets.slack) return { channel: 'slack' }
  if (targets.push) return { channel: 'push' }
  if (sms) return { channel: 'sms' }
  if (targets.slack) return { channel: 'slack' }
  return null
}

/** The channel a message goes on: {@link routeChoice}'s order. Pure. */
export function pickRouteChannel(input: { targets: RouteTargets; latest: LatestUserMessage | null; presence: readonly PresenceRow[]; nowMs: number }): RouteChannel | null {
  return routeChoice({ targets: input.targets, sticky: stickyChannel(input) })?.channel ?? null
}

/**
 * One round of the router (see the header): read, decide, and, when live, tell
 * him (a banner, or each message on its channel). `settle`: the run's last
 * recheck, so a banner he never opened settles what it covered for good.
 * Returns what it decided, ids only. Throws only when a read it can't do
 * without throws (the step retries).
 */
export async function planRoute(data: RouteRequestData, deps: RouteDeps, opts: { live?: boolean; settle?: boolean } = {}): Promise<RouteDecision> {
  const live = opts.live ?? true
  const now = (deps.now ?? Date.now)()
  const thread = await deps.thread(data)
  if (!thread) return { kind: 'done', outcome: 'not_home', rows: 0 }

  // Seen: up to the marker, or up to his own newest message (any channel).
  const latest = await deps.latestUserMessage(data)
  const seenThrough = Math.max(time(thread.seenAt) ?? 0, time(latest?.createdAt) ?? 0)
  // Oldest first, at most ROUTE_GATHER_MAX live ones: a full page of messages
  // that already went, were settled, or have nothing left to say (an answered
  // ask) reads on past them, so dead rows never hide a live one.
  let cursor = Math.max(seenThrough, now - ROUTE_LOOKBACK_MS)
  const items: RouteItem[] = []
  for (let page = 0; page < ROUTE_GATHER_PAGES && items.length < ROUTE_GATHER_MAX; page++) {
    const rows = await deps.messagesSince({ ...data, sinceIso: new Date(cursor).toISOString(), limit: ROUTE_GATHER_MAX })
    const routed = rows
      .filter((row) => (time(row.created_at) ?? 0) > seenThrough)
      .map((row) => ({ row, route: routeOf(row, data.userId, now) }))
      .filter((r): r is { row: RouteRow; route: { routes: true } & RoutedMessage } => r.route.routes)
    const claimed = routed.length ? await deps.claimed({ userId: data.userId, refs: routed.map((r) => r.route.ref) }) : new Set<string>()
    const fresh = routed.filter((r) => !claimed.has(refKey(r.route.ref)))
    const approvalIds = [...new Set(fresh.flatMap((r) => r.route.approvalIds))]
    const pending = approvalIds.length ? await deps.pendingApprovals({ userId: data.userId, approvalIds }) : new Map<string, ChannelApproval>()
    const liveItems = fresh
      .map((r) => ({ row: r.row, route: r.route, approvals: r.route.approvalIds.map((id) => pending.get(id)).filter((a): a is ChannelApproval => !!a) }))
      .filter(isLive)
    items.push(...liveItems.slice(0, ROUTE_GATHER_MAX - items.length))
    if (rows.length < ROUTE_GATHER_MAX) break
    cursor = time(rows[rows.length - 1].created_at) ?? cursor
  }
  if (items.length === 0) return { kind: 'done', outcome: 'nothing', rows: 0 }

  const textable = items.filter((i) => i.route.textable)
  // A banner for what no writer notified about already (a look-ahead, a digest and a check-in did).
  const unnotified = items.filter((i) => !i.route.notifies)
  /** Claim these on 'banner': settled without a send, so no later run picks them up. */
  const settle = async (settled: readonly RouteItem[]) => {
    for (const item of settled) await deps.claim({ userId: data.userId, workspaceId: data.workspaceId, ref: item.route.ref, channel: 'banner', urgent: false })
  }
  const tellInApp = async (): Promise<boolean> => {
    const newest = unnotified[unnotified.length - 1]
    if (!newest) return false
    const messageId = typeof newest.row.ui_message?.id === 'string' && newest.row.ui_message.id ? newest.row.ui_message.id : null
    const bannered = await deps.banner({ ...data, rowId: newest.row.id, messageId, preview: newest.route.text || null, count: unnotified.length })
    // A message that only ever banners (a prep-only report) is done once bannered.
    await settle(unnotified.filter((i) => !i.route.textable))
    return bannered
  }

  const presence = await deps.presence(data.userId)
  if (isPresent(presence, now)) {
    if (!live) return { kind: 'done', outcome: 'off', rows: items.length, would: { action: 'banner', rows: unnotified.length } }
    const bannered = await tellInApp()
    // Two hours at an app and never opened (the run's last recheck): the banner was all, for good.
    if (opts.settle) {
      await settle(items)
      return { kind: 'done', outcome: 'present_unread', rows: items.length }
    }
    // Nothing that could be texted if he leaves: the banner was all.
    return textable.length ? { kind: 'banner', rows: items.length, bannered } : { kind: 'done', outcome: 'bannered', rows: items.length }
  }

  // Away. A message that only ever banners (a prep-only report) still lands in the app's notices.
  if (textable.length === 0) {
    if (live) await tellInApp()
    return live ? { kind: 'done', outcome: 'banner_only', rows: items.length } : { kind: 'done', outcome: 'off', rows: items.length, would: { action: 'banner', rows: unnotified.length } }
  }
  const targets = await deps.targets(data)
  const sticky = stickyChannel({ latest, presence, nowMs: now })
  const planned = textable
    .map((item) => ({ item, choice: routeChoice({ targets, sticky }) }))
    .filter((p): p is { item: RouteItem; choice: RouteChoice } => p.choice !== null)
  if (planned.length === 0) return { kind: 'done', outcome: 'no_channel', rows: items.length }
  const channel = planned[0].choice.channel

  // Quiet hours hold routine messages on every channel; an urgent one close enough goes now.
  const quietEnd = smsQuietUntil(now, await deps.timeZone(data))
  let toSend = planned
  const urgent = quietEnd !== null
  if (quietEnd !== null) {
    toSend = planned.filter((p) => urgentNow(p.item.route.urgentBy, now, quietEnd))
    if (toSend.length === 0) {
      const untilMs = quietEnd + QUIET_RELEASE_MS
      return live ? { kind: 'wait', untilMs, rows: planned.length, channel } : { kind: 'done', outcome: 'off', rows: items.length, would: { action: 'wait', channel, rows: planned.length } }
    }
  }
  if (!live) return { kind: 'done', outcome: 'off', rows: items.length, would: { action: 'send', channel: toSend[0].choice.channel, rows: toSend.length, ...(urgent ? { urgent } : {}) } }

  let sent = 0
  let failed = 0
  let skipped = 0
  const rowIds: string[] = []
  for (const { item, choice } of toSend) {
    // Claimed before it goes: a second run, or a retried step, finds it taken.
    const claim = await deps.claim({ userId: data.userId, workspaceId: data.workspaceId, ref: item.route.ref, channel: choice.channel, urgent })
    if (claim !== 'claimed') {
      // Taken: it went already. Unavailable: an unasked message never risks going twice.
      skipped++
      continue
    }
    // Each approval it carries is claimed too, so a text turn's own prompt for it never repeats.
    const approvals: ChannelApproval[] = []
    for (const approval of item.approvals) {
      const ref: RouteRef = { type: 'tool_approval', id: approval.approvalId }
      if (refKey(ref) === refKey(item.route.ref) || (await deps.claim({ userId: data.userId, workspaceId: data.workspaceId, ref, channel: choice.channel, urgent })) === 'claimed') approvals.push(approval)
    }
    const message: OutboundMessage<ChannelApproval> = { text: item.route.text ?? '', approvals }
    if (!message.text.trim() && approvals.length === 0) {
      skipped++
      continue
    }
    const ok = await deps.send({ userId: data.userId, workspaceId: data.workspaceId, channel: choice.channel, slack: targets.slack, message }).catch(() => false)
    if (ok) {
      sent++
      rowIds.push(item.row.id)
    } else {
      // Claimed and not sent: at most once, like every unasked message (it stays in the thread).
      failed++
      // But an ask that never reached the phone isn't one a plain "yes" by text may answer.
      if (choice.channel === 'sms' && deps.releaseTexted) for (const approval of approvals) await deps.releaseTexted({ userId: data.userId, approvalId: approval.approvalId })
    }
  }
  return { kind: 'sent', channel: toSend[0].choice.channel, sent, failed, skipped, urgent, rowIds }
}

/** The one `[reach-route]` line per run: ids and outcomes, never words. */
export function routeLogLine(args: {
  data: Pick<RouteRequestData, 'userId' | 'conversationId'> | null
  rounds: number
  outcome: string
  sent?: number
  channel?: RouteChannel | null
  would?: RouteWould
}): string {
  const who = args.data ? `user=${args.data.userId} conversation=${args.data.conversationId}` : 'user=- conversation=-'
  const would = args.would ? ` would=${args.would.action}${args.would.channel ? `:${args.would.channel}` : ''}:${args.would.rows}${args.would.urgent ? ':urgent' : ''}` : ''
  return `[reach-route] ${who} rounds=${args.rounds} outcome=${args.outcome} sent=${args.sent ?? 0} channel=${args.channel ?? '-'}${would}`
}

// ── The real store and channels ─────────────────────────────────────────────

/** The real store and channels behind {@link planRoute}, on the service client. Heavy senders load on first use. */
export function liveRouteDeps(supabase: SupabaseClient): RouteDeps {
  return {
    thread: async (input) => {
      const { data, error } = await supabase
        .from('chat_conversations')
        .select('id, is_home, seen_at')
        .eq('id', input.conversationId)
        .eq('user_id', input.userId)
        .maybeSingle<{ id: string; is_home: boolean | null; seen_at: string | null }>()
      if (error) throw new Error(`chat_conversations read failed: ${error.message}`)
      return data && data.is_home ? { seenAt: data.seen_at } : null
    },
    latestUserMessage: async (input) => {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('created_at, ui_message')
        .eq('conversation_id', input.conversationId)
        .eq('user_id', input.userId)
        .eq('role', 'user')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ created_at: string | null; ui_message: { metadata?: { channel?: unknown } | null } | null }>()
      if (error) throw new Error(`chat_messages read failed: ${error.message}`)
      if (!data?.created_at) return null
      const channel = data.ui_message?.metadata?.channel
      return { createdAt: data.created_at, channel: typeof channel === 'string' ? channel : null }
    },
    messagesSince: async (input) => {
      const { data, error } = await supabase
        .from('chat_messages')
        .select('id, created_at, ui_message')
        .eq('conversation_id', input.conversationId)
        .eq('user_id', input.userId)
        .eq('role', 'assistant')
        .in('ui_message->metadata->>kind', [...ROUTED_MESSAGE_KINDS])
        .gt('created_at', input.sinceIso)
        .order('created_at', { ascending: true })
        .limit(input.limit)
      if (error) throw new Error(`chat_messages read failed: ${error.message}`)
      return (data ?? []) as RouteRow[]
    },
    claimed: (input) => claimedReachRefs(supabase, input),
    pendingApprovals: async (input) => {
      const { channelApprovalById } = await import('@/lib/attention/channel-approvals')
      const out = new Map<string, ChannelApproval>()
      for (const approvalId of input.approvalIds) {
        const approval = await channelApprovalById(supabase, { userId: input.userId, approvalId })
        if (approval) out.set(approvalId, approval)
      }
      return out
    },
    presence: (userId) => readPresence(supabase, userId),
    targets: async (input) => {
      const [sms, slack] = await Promise.all([smsConsent(supabase, input.userId), slackTarget(supabase, input)])
      return { push: false, sms, slack }
    },
    timeZone: async (input) => {
      const { readMemberTimeZone } = await import('@/lib/agent-events/member-time-zone')
      const zone = await readMemberTimeZone(supabase, input)
      return zone.source === 'utc' ? null : zone.timeZone
    },
    claim: (input) =>
      claimReachNotice(supabase, { userId: input.userId, workspaceId: input.workspaceId, approvalId: input.ref.id, refType: input.ref.type, channel: input.channel, urgent: input.urgent }),
    send: async (input) => {
      if (input.channel === 'sms') {
        const [{ textPerson }, { approvalPromptText }] = await Promise.all([import('@/lib/chat/text-turn-server'), import('@/lib/sms/approvals')])
        const body = awayTextBody(input.message, approvalPromptText)
        return (await textPerson(supabase, { userId: input.userId, workspaceId: input.workspaceId, body, kind: 'away' })).sent
      }
      if (input.channel === 'slack' && input.slack) return postSlackMessage(input.slack, input.message)
      // Push has no adapter yet (the iOS app): pickRouteChannel never picks it while targets.push is false.
      return false
    },
    banner: (input) => postAgentMessageBanner(supabase, input),
    releaseTexted: (input) => releaseTextedApproval(supabase, input),
  }
}

/** Into his own DM with the bot (never a channel others read): the words, then each approval as its Slack card with buttons and its code. */
async function postSlackMessage(target: SlackReachTarget, message: OutboundMessage<ChannelApproval>): Promise<boolean> {
  const [{ openSlackDm, slackTurnSlack }, { approvalBlocks }] = await Promise.all([import('@/lib/slack/deps'), import('@/lib/slack/approvals')])
  const dm = await openSlackDm(target.installationId, target.slackUserId)
  if (!dm) return false
  const slack = slackTurnSlack(target.installationId)
  let first: boolean | null = null
  if (message.text.trim()) {
    const posted = await slack.post({ channel: dm, text: message.text }).catch(() => null)
    first = !!posted?.ok
    if (!first) return false
  }
  for (const approval of message.approvals) {
    const posted = await slack.post({ channel: dm, ...approvalBlocks(approval) }).catch(() => null)
    first ??= !!posted?.ok
  }
  return first === true
}

/**
 * One `agent_message` notification on the face, from the Assistant (the one
 * face, as the digest's): the desktop shows it as a native banner when no
 * Native Intelligence window is focused, and a toast otherwise. It has no target: a click
 * opens the home thread on the message (`metadata.message_id`, its ui message
 * id; lib/chat/home-message.ts), and its arrival brings that message into an
 * open chat that lacks it. Deduped on the newest message's group key.
 * Never throws (false).
 */
async function postAgentMessageBanner(supabase: SupabaseClient, input: RouteRequestData & { rowId: string; messageId: string | null; preview: string | null; count: number }): Promise<boolean> {
  try {
    const { data: member, error } = await supabase.from('member').select('id').eq('workspace_id', input.workspaceId).eq('user_id', input.userId).maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (error || typeof memberId !== 'string') return false
    const groupKey = `agent_message:${input.rowId}`
    const { data: existing } = await supabase.from('notification').select('id').eq('recipient_id', memberId).eq('group_key', groupKey).eq('type', 'agent_message').limit(1)
    if (Array.isArray(existing) && existing.length > 0) return false
    const [{ createNotification }, { systemTeammateId }, { botNoticeCopy, botNoticeMetadata, noticeTeammateName }] = await Promise.all([
      import('@/lib/notifications'),
      import('@/lib/work/system-teammates'),
      import('@/lib/bots/bot-notice'),
    ])
    const face = await systemTeammateId(supabase, input.workspaceId, 'assistant').catch(() => null)
    const copy = agentMessageNoticeCopy(input.preview, input.count)
    const bot = face ? botNoticeMetadata({ teammateId: face, teammateName: await noticeTeammateName(supabase, input.workspaceId, face), sentence: copy.sentence }) : {}
    const said = botNoticeCopy(bot, { title: copy.title, body: copy.sentence })
    await createNotification({
      workspaceId: input.workspaceId,
      recipientId: memberId,
      type: 'agent_message',
      title: said.title,
      body: said.body,
      groupKey,
      metadata: {
        conversation_id: input.conversationId,
        home_message_id: input.rowId,
        ...(input.messageId ? { message_id: input.messageId } : {}),
        messages: input.count,
        ...bot,
      },
    })
    return true
  } catch (err) {
    console.warn('[reach-route] banner skipped:', err instanceof Error ? err.message : String(err))
    return false
  }
}
