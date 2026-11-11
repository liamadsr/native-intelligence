/**
 * Team chat by email while you are away (phase 2, migration 560): a burst of
 * messages in one conversation becomes one email, not one per message.
 *
 * Each person a message notified (./notify.ts) is handed on as one
 * `team-chat/email.requested`, keyed by the person and the conversation
 * ({@link teamChatEmailKey}: a channel's own messages, a DM, or one thread).
 * The `team-chat-email` Inngest function (src/lib/inngest/team-chat-reach.ts)
 * is debounced on that key: it starts once the conversation has been quiet
 * for TEAM_CHAT_EMAIL_WAIT, and a newer request, or the person reading the
 * conversation (`team-chat/read`, sent by the read routes), cancels a run
 * that is waiting. Then it runs {@link planTeamChatEmail} until there is
 * nothing left to do:
 *
 *   gather   their notifications for the conversation that are still unread,
 *            of messages not deleted, less any already emailed (reach_notice,
 *            'team_chat_notification'); none: they read it, nothing goes
 *   present  at a Native Intelligence app (src/lib/presence, as the router
 *            reads it): the in-app notice and the banner were the reach; look
 *            again in TEAM_CHAT_EMAIL_RECHECK, a few times
 *   quiet    21:00 to 08:00 in their zone (the router's quiet hours,
 *            src/lib/reach/dispatch.ts): wait until they end
 *   away     the router's order for someone away (src/lib/reach/route.ts
 *            routeChoice), with texts and Slack left out (team chat never
 *            texts): push first, which has no adapter yet (the iOS app's
 *            slot: targets.push is false until it exists, and a push that
 *            doesn't go falls through), then email to their account's
 *            address, every message it carries claimed first, so a retried
 *            step or a second run never emails one twice
 *
 * Privacy: step outputs hold ids and counts; the words are read and sent
 * inside the step.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isPresent, type PresenceRow } from '@/lib/presence/presence'
import { smsQuietUntil } from '@/lib/reach/dispatch'
import { routeChoice } from '@/lib/reach/route'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { appUrl } from '@/lib/app-url'
import { TEAM_CHAT_NOTIFICATION_TYPE } from './notify'

export const TEAM_CHAT_EMAIL_EVENT = 'team-chat/email.requested' as const
export const TEAM_CHAT_READ_EVENT = 'team-chat/read' as const

/** How long a conversation is quiet before its email goes (and how long a burst can hold it back). */
export const TEAM_CHAT_EMAIL_WAIT = '3m'
export const TEAM_CHAT_EMAIL_WAIT_MAX = '10m'
/** At an app: how long before it looks again, and how many times (10 min × 6 = an hour, then the in-app notice was all). */
export const TEAM_CHAT_EMAIL_RECHECK = '10m'
export const TEAM_CHAT_EMAIL_RECHECKS = 6
/** How far back one email looks, and the most messages it carries. */
export const TEAM_CHAT_EMAIL_LOOKBACK_MS = 24 * 60 * 60_000
export const TEAM_CHAT_EMAIL_MAX_MESSAGES = 20
/** A routine email held by quiet hours goes this long after they end (as the router's). */
export const TEAM_CHAT_EMAIL_QUIET_RELEASE_MS = 5 * 60_000

/** The key one person's email for one conversation is debounced and cancelled by. */
export function teamChatEmailKey(userId: string, groupKey: string): string {
  return `${userId}:${groupKey}`
}

export interface TeamChatEmailRequest {
  key: string
  userId: string
  memberId: string
  workspaceId: string
  groupKey: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GROUP = /^team_chat(_thread)?:[0-9a-f-]{36}$/i

/** The event, checked. Null when malformed. */
export function parseTeamChatEmailRequest(raw: unknown): TeamChatEmailRequest | null {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const ok =
    typeof d.userId === 'string' && UUID.test(d.userId) &&
    typeof d.memberId === 'string' && UUID.test(d.memberId) &&
    typeof d.workspaceId === 'string' && UUID.test(d.workspaceId) &&
    typeof d.groupKey === 'string' && GROUP.test(d.groupKey)
  if (!ok) return null
  const req = { userId: d.userId as string, memberId: d.memberId as string, workspaceId: d.workspaceId as string, groupKey: d.groupKey as string }
  return { ...req, key: teamChatEmailKey(req.userId, req.groupKey) }
}

/** One unread notification as the email reads it. */
export interface TeamChatEmailNotice {
  id: string
  created_at: string
  title: string
  body: string | null
  target_id: string | null
  metadata: Record<string, unknown> | null
}

export interface TeamChatEmailDeps {
  now?: () => number
  /** Their unread team chat notifications of this conversation since `sinceIso`, oldest first. */
  unread(input: TeamChatEmailRequest & { sinceIso: string; limit: number }): Promise<TeamChatEmailNotice[]>
  /** Which of these notification ids went out already (on any channel). */
  claimed(input: { userId: string; ids: string[] }): Promise<Set<string>>
  /** Which of these messages are still there (not deleted). */
  liveMessages(ids: string[]): Promise<Set<string>>
  presence(userId: string): Promise<PresenceRow[]>
  timeZone(input: { userId: string; workspaceId: string }): Promise<string | null>
  /** The iOS app's push for them. No adapter yet: always false today. */
  pushTarget(userId: string): Promise<boolean>
  /** Their account's email address, or null. */
  address(userId: string): Promise<string | null>
  claim(input: { userId: string; workspaceId: string; notificationId: string; channel: 'push' | 'email' }): Promise<'claimed' | 'taken' | 'unavailable'>
  /** Send on push (no adapter yet: false). */
  sendPush?(input: { userId: string; notices: TeamChatEmailNotice[] }): Promise<boolean>
  sendEmail(input: { to: string; subject: string; html: string; text: string }): Promise<boolean>
  /** Their deep link to a message. */
  link(messageId: string): string
}

/**
 * One round's decision (ids and counts only: a step output).
 *   done     nothing more to do
 *   present  at an app: look again later
 *   wait     quiet hours: look again at `untilMs`
 */
export type TeamChatEmailDecision =
  | { kind: 'done'; outcome: 'read' | 'sent' | 'no_address' | 'taken' | 'failed' | 'pushed'; messages: number }
  | { kind: 'present'; messages: number }
  | { kind: 'wait'; untilMs: number; messages: number }

/** Where someone away is reached about team chat: the router's order with texts and Slack off, then email. Pure. */
export function teamChatAwayChannel(targets: { push: boolean }): 'push' | 'email' {
  return routeChoice({ targets: { push: targets.push, sms: null, slack: null }, sticky: null })?.channel === 'push' ? 'push' : 'email'
}

/** The words of one batched email. Pure. */
export function teamChatEmailContent(input: { notices: readonly TeamChatEmailNotice[]; link: string }): { subject: string; html: string; text: string } {
  const notices = input.notices
  const meta = (n: TeamChatEmailNotice) => n.metadata ?? {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const first = notices[0]
  const place = str(meta(first).place)
  const inThread = !!str(meta(first).thread_root_id)
  const authors = [...new Set(notices.map((n) => str(meta(n).author_name) ?? 'A teammate'))]
  const count = notices.length
  const where = inThread ? (place ? `a thread in ${place}` : 'a thread') : place
  const subject =
    count === 1
      ? first.title
      : where
        ? `${count} new ${inThread ? 'replies' : 'messages'} in ${where}`
        : `${count} new messages from ${authors.length === 1 ? authors[0] : `${authors[0]} and others`}`
  const lines = notices.map((n) => ({ who: str(meta(n).author_name) ?? 'A teammate', words: n.body?.trim() || '' }))
  const text = [subject, '', ...lines.map((l) => `${l.who}: ${l.words}`), '', `Open in Native Intelligence: ${input.link}`].join('\n')
  const rows = lines
    .map(
      (l) =>
        `<p style="margin: 0 0 12px; line-height: 1.5;"><strong>${escapeHtml(l.who)}</strong><br/><span style="color: #333;">${escapeHtml(l.words)}</span></p>`,
    )
    .join('')
  const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 20px;">
          <h2 style="margin: 0 0 20px; font-size: 18px;">${escapeHtml(subject)}</h2>
          ${rows}
          <a href="${escapeHtml(input.link)}" style="display: inline-block; margin: 16px 0; padding: 10px 20px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">
            Open in Native Intelligence
          </a>
          <p style="color: #888; font-size: 13px; line-height: 1.5;">
            You get this because you were away when these came in. Reading them in the app stops these emails; a channel's menu sets what notifies you there.
          </p>
        </div>
      `
  return { subject, html, text }
}

/**
 * One round (see the header): read, decide, and, when they are away, email
 * them once for every message still unread. Throws only when a read it can't
 * do without throws (the step retries).
 */
export async function planTeamChatEmail(req: TeamChatEmailRequest, deps: TeamChatEmailDeps): Promise<TeamChatEmailDecision> {
  const now = (deps.now ?? Date.now)()
  const unread = await deps.unread({ ...req, sinceIso: new Date(now - TEAM_CHAT_EMAIL_LOOKBACK_MS).toISOString(), limit: TEAM_CHAT_EMAIL_MAX_MESSAGES })
  const claimed = unread.length ? await deps.claimed({ userId: req.userId, ids: unread.map((n) => n.id) }) : new Set<string>()
  const pending = unread.filter((n) => !claimed.has(n.id) && !!n.target_id)
  const live = pending.length ? await deps.liveMessages(pending.map((n) => n.target_id!)) : new Set<string>()
  const notices = pending.filter((n) => live.has(n.target_id!))
  if (notices.length === 0) return { kind: 'done', outcome: 'read', messages: 0 }

  if (isPresent(await deps.presence(req.userId), now)) return { kind: 'present', messages: notices.length }

  const quietEnd = smsQuietUntil(now, await deps.timeZone(req))
  if (quietEnd !== null) return { kind: 'wait', untilMs: quietEnd + TEAM_CHAT_EMAIL_QUIET_RELEASE_MS, messages: notices.length }

  const channel = teamChatAwayChannel({ push: await deps.pushTarget(req.userId) })
  if (channel === 'push' && deps.sendPush) {
    const mine: TeamChatEmailNotice[] = []
    for (const n of notices) if ((await deps.claim({ userId: req.userId, workspaceId: req.workspaceId, notificationId: n.id, channel: 'push' })) === 'claimed') mine.push(n)
    if (mine.length && (await deps.sendPush({ userId: req.userId, notices: mine }))) return { kind: 'done', outcome: 'pushed', messages: mine.length }
    // A push that didn't go falls through to email (its claims say it was tried).
  }

  const to = await deps.address(req.userId)
  if (!to) return { kind: 'done', outcome: 'no_address', messages: notices.length }
  // Claimed before it goes: a second run, or a retried step, finds them taken.
  const mine: TeamChatEmailNotice[] = []
  for (const n of notices) {
    if ((await deps.claim({ userId: req.userId, workspaceId: req.workspaceId, notificationId: n.id, channel: 'email' })) === 'claimed') mine.push(n)
  }
  if (mine.length === 0) return { kind: 'done', outcome: 'taken', messages: 0 }
  const newest = mine[mine.length - 1]
  const content = teamChatEmailContent({ notices: mine, link: deps.link(newest.target_id!) })
  // Claimed and not sent: at most once, like every unasked message (it stays in the app).
  const ok = await deps.sendEmail({ to, ...content }).catch(() => false)
  return { kind: 'done', outcome: ok ? 'sent' : 'failed', messages: mine.length }
}

/** The real store and channels behind {@link planTeamChatEmail}, on the service client. */
export function liveTeamChatEmailDeps(svc: SupabaseClient): TeamChatEmailDeps {
  return {
    unread: async (input) => {
      const { data, error } = await svc
        .from('notification')
        .select('id, created_at, title, body, target_id, metadata')
        .eq('recipient_id', input.memberId)
        .eq('workspace_id', input.workspaceId)
        .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
        .eq('group_key', input.groupKey)
        .eq('is_read', false)
        .eq('is_archived', false)
        .gt('created_at', input.sinceIso)
        .order('created_at', { ascending: true })
        .limit(input.limit)
      if (error) throw new Error(`notification read failed: ${error.message}`)
      return (data ?? []) as TeamChatEmailNotice[]
    },
    claimed: async (input) => {
      const { data, error } = await svc
        .from('reach_notice')
        .select('ref_id')
        .eq('user_id', input.userId)
        .eq('ref_type', 'team_chat_notification')
        .in('ref_id', input.ids)
      if (error) throw new Error(`reach_notice read failed: ${error.message}`)
      return new Set(((data ?? []) as Array<{ ref_id: string }>).map((r) => r.ref_id))
    },
    liveMessages: async (ids) => {
      const { data, error } = await svc.from('team_chat_message').select('id').in('id', ids).is('deleted_at', null)
      if (error) throw new Error(`team_chat_message read failed: ${error.message}`)
      return new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
    },
    presence: async (userId) => {
      const { readPresence } = await import('@/lib/presence/store')
      return readPresence(svc, userId)
    },
    timeZone: async (input) => {
      const { readMemberTimeZone } = await import('@/lib/agent-events/member-time-zone')
      const zone = await readMemberTimeZone(svc, input)
      return zone.source === 'utc' ? null : zone.timeZone
    },
    // The iOS app's push has no adapter yet (src/lib/reach/route.ts targets): never a target today.
    pushTarget: async () => false,
    address: async (userId) => {
      try {
        const { data } = await svc.auth.admin.getUserById(userId)
        const email = data?.user?.email?.trim()
        return email || null
      } catch {
        return null
      }
    },
    claim: async (input) => {
      const { claimReachNotice } = await import('@/lib/reach/notice')
      return claimReachNotice(svc, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        approvalId: input.notificationId,
        refType: 'team_chat_notification',
        channel: input.channel,
      })
    },
    sendEmail: async (input) => {
      const { sendEmail } = await import('@/lib/email')
      try {
        const { error } = await sendEmail({ to: input.to, subject: input.subject, html: input.html, text: input.text })
        if (error) console.warn('[team-chat-email] refused:', error.name)
        return !error
      } catch (err) {
        console.warn('[team-chat-email] failed:', err instanceof Error ? err.message : 'unknown')
        return false
      }
    },
    link: (messageId) => teamChatMessageLink(messageId),
  }
}

/**
 * The app's link to a message: the boot deep link
 * (`/account?team_chat_message=<id>`, the entity actions registry's), which
 * opens team chat on it. On the app's address in production, as every email's
 * links are (src/lib/email.ts BASE_URL).
 */
export function teamChatMessageLink(messageId: string, origin?: string): string {
  const base = origin ?? (process.env.NODE_ENV === 'production' ? appUrl() : 'http://localhost:3000')
  return `${base.replace(/\/$/, '')}/account?team_chat_message=${encodeURIComponent(messageId)}`
}

// ── Reading cancels it ──────────────────────────────────────────────────────

/**
 * Whether the person (their client, under RLS) has unread notifications for
 * this conversation: read BEFORE a read mark clears them, so the read route
 * knows to cancel a waiting email. Never throws (false).
 */
export async function hasUnreadTeamChatNotices(supabase: SupabaseClient, input: { memberId: string; groupKey: string }): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('notification')
      .select('id')
      .eq('recipient_id', input.memberId)
      .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
      .eq('group_key', input.groupKey)
      .eq('is_read', false)
      .limit(1)
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

/** Tell a waiting email the person read the conversation (it is cancelled). Never throws. */
export async function sendTeamChatRead(input: { userId: string; groupKey: string }, send?: (e: { name: string; data: { key: string } }) => Promise<unknown>): Promise<void> {
  const event = { name: TEAM_CHAT_READ_EVENT, data: { key: teamChatEmailKey(input.userId, input.groupKey) } }
  try {
    if (send) await send(event)
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(event)
    }
  } catch (err) {
    console.warn('[team-chat-email] read not sent:', err instanceof Error ? err.message : 'unknown')
  }
}
