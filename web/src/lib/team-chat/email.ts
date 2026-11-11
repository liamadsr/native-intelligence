/**
 * Team chat by email while you are away (phase 2, migration 560): one email
 * per PERSON, not one per message or per conversation. A burst becomes one
 * email, and the conversations still unread when it goes are its sections.
 *
 * Each person a message notified (./notify.ts) is handed on as one
 * `team-chat/email.requested`, keyed by the person ({@link teamChatEmailEvent}).
 * The `team-chat-email` Inngest function (src/lib/inngest/team-chat-reach.ts)
 * is debounced on that key: it starts once team chat has been quiet for them
 * for TEAM_CHAT_EMAIL_WAIT, and a newer request cancels a run that is
 * waiting (the newer run reads everything again). Then it runs
 * {@link planTeamChatEmail} until there is nothing left to do:
 *
 *   gather   their team chat notifications still unread (every workspace
 *            they are in), less any already emailed (reach_notice,
 *            'team_chat_notification'), and of those only the messages they
 *            may still read, with the words as they are NOW (560's
 *            team_chat_readable_messages: not deleted, channel not archived,
 *            still in the workspace and allowed in the channel). A
 *            conversation they read meanwhile has no unread notification
 *            left (its read mark read them, 560), so it drops out of the
 *            email; none left: nothing goes (reading is the cancel)
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
 *            address. Every message it carries is claimed first, so a
 *            retried step or a second run never emails one twice, and what
 *            they may read is asked AGAIN right before it goes: a message
 *            they lost access to (removed from the channel, gone from the
 *            workspace), or that was deleted, in between is left out
 *
 * The email is bounded: at most TEAM_CHAT_EMAIL_MAX_CONVERSATIONS sections,
 * the newest TEAM_CHAT_EMAIL_MAX_PER_CONVERSATION messages in each, with "and
 * N more" for the rest. Every link names its workspace.
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

/** How long team chat is quiet for the person before their email goes (and how long a burst can hold it back). */
export const TEAM_CHAT_EMAIL_WAIT = '3m'
export const TEAM_CHAT_EMAIL_WAIT_MAX = '10m'
/** At an app: how long before it looks again, and how many times (10 min × 6 = an hour, then the in-app notice was all). */
export const TEAM_CHAT_EMAIL_RECHECK = '10m'
export const TEAM_CHAT_EMAIL_RECHECKS = 6
/** How far back one email looks, and the most notifications it reads. */
export const TEAM_CHAT_EMAIL_LOOKBACK_MS = 24 * 60 * 60_000
export const TEAM_CHAT_EMAIL_MAX_NOTICES = 100
/** What one email shows: conversations, messages in each, and characters of one message. */
export const TEAM_CHAT_EMAIL_MAX_CONVERSATIONS = 5
export const TEAM_CHAT_EMAIL_MAX_PER_CONVERSATION = 4
export const TEAM_CHAT_EMAIL_WORDS = 400
/** A routine email held by quiet hours goes this long after they end (as the router's). */
export const TEAM_CHAT_EMAIL_QUIET_RELEASE_MS = 5 * 60_000

export interface TeamChatEmailRequest {
  /** The person: one email each (the debounce and cancel key). */
  key: string
  userId: string
  /** The workspace of the message that asked (their zone is read there first). */
  workspaceId: string
}

/** The event that asks for a person's email (ids only). */
export function teamChatEmailEvent(input: { userId: string; workspaceId: string }) {
  return { name: TEAM_CHAT_EMAIL_EVENT, data: { key: input.userId, userId: input.userId, workspaceId: input.workspaceId } }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The event, checked. Null when malformed. */
export function parseTeamChatEmailRequest(raw: unknown): TeamChatEmailRequest | null {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (typeof d.userId !== 'string' || !UUID.test(d.userId) || typeof d.workspaceId !== 'string' || !UUID.test(d.workspaceId)) return null
  return { key: d.userId, userId: d.userId, workspaceId: d.workspaceId }
}

/** One unread notification as the email reads it (never its words: those are read live). */
export interface TeamChatEmailNotice {
  id: string
  created_at: string
  recipient_id: string
  workspace_id: string
  group_key: string
  title: string
  target_id: string | null
  metadata: Record<string, unknown> | null
}

/** A message as it is now, for a member who may read it. */
export interface TeamChatLiveMessage {
  body: string
  files: number
}

/** A notice with its message's words now: what the email shows. */
export interface TeamChatEmailItem extends TeamChatEmailNotice {
  words: string
}

export interface TeamChatEmailDeps {
  now?: () => number
  /** Their unread team chat notifications since `sinceIso` (every workspace they are in), oldest first. */
  unread(input: { userId: string; sinceIso: string; limit: number }): Promise<TeamChatEmailNotice[]>
  /** Which of these notification ids went out already (on any channel). */
  claimed(input: { userId: string; ids: string[] }): Promise<Set<string>>
  /** Of these messages, the ones this member may read now, with their words now (560's team_chat_readable_messages). */
  readable(input: { memberId: string; ids: string[] }): Promise<Map<string, TeamChatLiveMessage>>
  presence(userId: string): Promise<PresenceRow[]>
  timeZone(input: { userId: string; workspaceId: string }): Promise<string | null>
  /** The iOS app's push for them. No adapter yet: always false today. */
  pushTarget(userId: string): Promise<boolean>
  /** Their account's email address, or null. */
  address(userId: string): Promise<string | null>
  claim(input: { userId: string; workspaceId: string; notificationId: string; channel: 'push' | 'email' }): Promise<'claimed' | 'taken' | 'unavailable'>
  /** Send on push (no adapter yet: false). */
  sendPush?(input: { userId: string; items: TeamChatEmailItem[] }): Promise<boolean>
  sendEmail(input: { to: string; subject: string; html: string; text: string }): Promise<boolean>
  /** Their deep link to a message, in its workspace. */
  link(messageId: string, workspaceId: string): string
}

/**
 * One round's decision (ids and counts only: a step output).
 *   done     nothing more to do
 *   present  at an app: look again later
 *   wait     quiet hours: look again at `untilMs`
 */
export type TeamChatEmailDecision =
  | { kind: 'done'; outcome: 'read' | 'sent' | 'no_address' | 'taken' | 'failed' | 'pushed' | 'gone'; messages: number }
  | { kind: 'present'; messages: number }
  | { kind: 'wait'; untilMs: number; messages: number }

/** Where someone away is reached about team chat: the router's order with texts and Slack off, then email. Pure. */
export function teamChatAwayChannel(targets: { push: boolean }): 'push' | 'email' {
  return routeChoice({ targets: { push: targets.push, sms: null, slack: null }, sticky: null })?.channel === 'push' ? 'push' : 'email'
}

/** A message's words as an email line: one line, bounded; files alone say so. Pure. */
export function teamChatEmailWords(live: TeamChatLiveMessage): string {
  const line = live.body.replace(/\s+/g, ' ').trim()
  if (line) return line.length > TEAM_CHAT_EMAIL_WORDS ? `${line.slice(0, TEAM_CHAT_EMAIL_WORDS - 1).trimEnd()}…` : line
  return live.files > 1 ? `Sent ${live.files} files` : live.files === 1 ? 'Sent a file' : ''
}

/**
 * Of these notices, the ones whose message the recipient may read now, with
 * its words now (each recipient asked once). Pure but for `readable`.
 */
async function liveItems(notices: readonly TeamChatEmailNotice[], readable: TeamChatEmailDeps['readable']): Promise<TeamChatEmailItem[]> {
  const byMember = new Map<string, string[]>()
  for (const n of notices) if (n.target_id) byMember.set(n.recipient_id, [...(byMember.get(n.recipient_id) ?? []), n.target_id])
  const live = new Map<string, Map<string, TeamChatLiveMessage>>()
  for (const [memberId, ids] of byMember) live.set(memberId, await readable({ memberId, ids: [...new Set(ids)] }))
  const out: TeamChatEmailItem[] = []
  for (const n of notices) {
    const m = n.target_id ? live.get(n.recipient_id)?.get(n.target_id) : undefined
    if (m) out.push({ ...n, words: teamChatEmailWords(m) })
  }
  return out
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** One conversation's section: where, its newest messages (oldest first), and how many more. */
interface Section {
  heading: string
  link: string
  shown: Array<{ who: string; words: string }>
  more: number
  newest: number
}

/** The words of one email, its conversations in sections, newest first, bounded. Pure. */
export function teamChatEmailContent(input: { items: readonly TeamChatEmailItem[]; link: (messageId: string, workspaceId: string) => string }): { subject: string; html: string; text: string } {
  const groups = new Map<string, TeamChatEmailItem[]>()
  for (const item of input.items) groups.set(item.group_key, [...(groups.get(item.group_key) ?? []), item])
  const sections: Section[] = [...groups.values()]
    .map((list): Section => {
      const sorted = [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      const newest = sorted[sorted.length - 1]
      const meta = newest.metadata ?? {}
      const place = str(meta.place)
      const inThread = !!str(meta.thread_root_id)
      const who = str(meta.author_name) ?? 'A teammate'
      const heading = inThread ? (place ? `A thread in ${place}` : `A thread with ${who}`) : (place ?? `${who}, directly to you`)
      const shown = sorted.slice(-TEAM_CHAT_EMAIL_MAX_PER_CONVERSATION).map((n) => ({ who: str(n.metadata?.author_name) ?? 'A teammate', words: n.words }))
      return { heading, link: input.link(newest.target_id ?? '', newest.workspace_id), shown, more: sorted.length - shown.length, newest: Date.parse(newest.created_at) || 0 }
    })
    .sort((a, b) => b.newest - a.newest)
  const total = input.items.length
  const kept = sections.slice(0, TEAM_CHAT_EMAIL_MAX_CONVERSATIONS)
  const otherConversations = sections.length - kept.length
  const subject =
    total === 1
      ? input.items[0].title
      : sections.length === 1
        ? `${total} new messages: ${sections[0].heading}`
        : `${total} new messages in ${sections.length} conversations`
  const more = (n: number, what: string) => (n > 0 ? `and ${n} more ${what}` : null)
  const text = [
    subject,
    '',
    ...kept.flatMap((s) => [s.heading, ...s.shown.map((l) => `${l.who}: ${l.words}`), ...[more(s.more, s.more === 1 ? 'message' : 'messages')].filter(Boolean), `Open: ${s.link}`, '']),
    ...[more(otherConversations, otherConversations === 1 ? 'conversation' : 'conversations')].filter(Boolean),
  ].join('\n')
  const sectionHtml = kept
    .map(
      (s) => `
          <h3 style="margin: 24px 0 8px; font-size: 15px;">${escapeHtml(s.heading)}</h3>
          ${s.shown.map((l) => `<p style="margin: 0 0 10px; line-height: 1.5;"><strong>${escapeHtml(l.who)}</strong><br/><span style="color: #333;">${escapeHtml(l.words)}</span></p>`).join('')}
          ${s.more > 0 ? `<p style="margin: 0 0 10px; color: #888; font-size: 13px;">${escapeHtml(more(s.more, s.more === 1 ? 'message' : 'messages')!)}</p>` : ''}
          <a href="${escapeHtml(s.link)}" style="display: inline-block; margin: 4px 0 8px; padding: 8px 16px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-size: 14px;">Open in Native Intelligence</a>`,
    )
    .join('')
  const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 20px;">
          <h2 style="margin: 0 0 4px; font-size: 18px;">${escapeHtml(subject)}</h2>
          ${sectionHtml}
          ${otherConversations > 0 ? `<p style="margin: 16px 0 0; color: #888; font-size: 13px;">${escapeHtml(more(otherConversations, otherConversations === 1 ? 'conversation' : 'conversations')!)}</p>` : ''}
          <p style="margin: 24px 0 0; color: #888; font-size: 13px; line-height: 1.5;">
            You get this because you were away when these came in. Reading them in the app stops these emails; a channel's menu sets what notifies you there.
          </p>
        </div>
      `
  return { subject, html, text }
}

/**
 * One round (see the header): read, decide, and, when they are away, email
 * them once for everything still unread that they may still read. Throws
 * only when a read it can't do without throws (the step retries).
 */
export async function planTeamChatEmail(req: TeamChatEmailRequest, deps: TeamChatEmailDeps): Promise<TeamChatEmailDecision> {
  const now = (deps.now ?? Date.now)()
  const unread = await deps.unread({ userId: req.userId, sinceIso: new Date(now - TEAM_CHAT_EMAIL_LOOKBACK_MS).toISOString(), limit: TEAM_CHAT_EMAIL_MAX_NOTICES })
  const claimed = unread.length ? await deps.claimed({ userId: req.userId, ids: unread.map((n) => n.id) }) : new Set<string>()
  const items = await liveItems(
    unread.filter((n) => !claimed.has(n.id) && !!n.target_id),
    deps.readable,
  )
  if (items.length === 0) return { kind: 'done', outcome: 'read', messages: 0 }

  if (isPresent(await deps.presence(req.userId), now)) return { kind: 'present', messages: items.length }

  const quietEnd = smsQuietUntil(now, await deps.timeZone(req))
  if (quietEnd !== null) return { kind: 'wait', untilMs: quietEnd + TEAM_CHAT_EMAIL_QUIET_RELEASE_MS, messages: items.length }

  const claimAll = async (channel: 'push' | 'email') => {
    const mine: TeamChatEmailItem[] = []
    for (const n of items) {
      if ((await deps.claim({ userId: req.userId, workspaceId: n.workspace_id, notificationId: n.id, channel })) === 'claimed') mine.push(n)
    }
    return mine
  }

  const channel = teamChatAwayChannel({ push: await deps.pushTarget(req.userId) })
  if (channel === 'push' && deps.sendPush) {
    const mine = await claimAll('push')
    if (mine.length && (await deps.sendPush({ userId: req.userId, items: mine }))) return { kind: 'done', outcome: 'pushed', messages: mine.length }
    // A push that didn't go falls through to email (its claims say it was tried).
  }

  const to = await deps.address(req.userId)
  if (!to) return { kind: 'done', outcome: 'no_address', messages: items.length }
  // Claimed before it goes: a second run, or a retried step, finds them taken.
  const mine = await claimAll('email')
  if (mine.length === 0) return { kind: 'done', outcome: 'taken', messages: 0 }
  // Right before it goes: what they may read NOW, with its words now (access, deletes and edits since the plan).
  const sendable = await liveItems(mine, deps.readable)
  if (sendable.length === 0) return { kind: 'done', outcome: 'gone', messages: 0 }
  const content = teamChatEmailContent({ items: sendable, link: deps.link })
  // Claimed and not sent: at most once, like every unasked message (it stays in the app).
  const ok = await deps.sendEmail({ to, ...content }).catch(() => false)
  return { kind: 'done', outcome: ok ? 'sent' : 'failed', messages: sendable.length }
}

/** The real store and channels behind {@link planTeamChatEmail}, on the service client. */
export function liveTeamChatEmailDeps(svc: SupabaseClient): TeamChatEmailDeps {
  return {
    unread: async (input) => {
      const { data: members, error: memberError } = await svc.from('member').select('id').eq('user_id', input.userId)
      if (memberError) throw new Error(`member read failed: ${memberError.message}`)
      const ids = ((members ?? []) as Array<{ id: string }>).map((m) => m.id)
      if (ids.length === 0) return []
      const { data, error } = await svc
        .from('notification')
        .select('id, created_at, recipient_id, workspace_id, group_key, title, target_id, metadata')
        .in('recipient_id', ids)
        .eq('type', TEAM_CHAT_NOTIFICATION_TYPE)
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
    readable: async (input) => {
      const { data, error } = await svc.rpc('team_chat_readable_messages', { mem: input.memberId, ids: input.ids })
      if (error) throw new Error(`team_chat_readable_messages failed: ${error.message}`)
      return new Map(((data ?? []) as Array<{ id: string; body: string | null; files: number | null }>).map((r) => [r.id, { body: r.body ?? '', files: Number(r.files) || 0 }]))
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
    link: (messageId, workspaceId) => teamChatMessageLink(messageId, workspaceId),
  }
}

/**
 * The app's link to a message: the boot deep link
 * (`/account?team_chat_message=<id>&workspace=<id>`, read by the main chat's
 * deepLinkCard), which switches to the message's workspace and opens team
 * chat on it. On the app's address in production, as every email's links are
 * (src/lib/email.ts BASE_URL).
 */
export function teamChatMessageLink(messageId: string, workspaceId: string | null, origin?: string): string {
  const base = origin ?? (process.env.NODE_ENV === 'production' ? appUrl() : 'http://localhost:3000')
  const ws = workspaceId ? `&workspace=${encodeURIComponent(workspaceId)}` : ''
  return `${base.replace(/\/$/, '')}/account?team_chat_message=${encodeURIComponent(messageId)}${ws}`
}
