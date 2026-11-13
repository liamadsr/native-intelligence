/**
 * SEND LATER (migration 642): a person's own message, saved as a draft in the
 * mailbox they picked, sent by the app at the time they chose.
 *
 * Nothing of the message is stored here: it waits in their mailbox as a
 * provider draft, and an `email_scheduled_send` row names it (by the id that
 * survives edits: Gmail's DRAFT id `r-…`, Graph's message id), the mailbox
 * (`account_id`), and when. `to_emails` and `subject` are for the Scheduled
 * folder only, and are cleared once it is sent.
 *
 * Who sends it: an Inngest event timed at `send_at`
 * (src/lib/inngest/email-scheduled-send.ts), and the 5-minute sweep
 * (/api/cron/email-scheduled-send) for any due row the event missed; "Send
 * now" in the Scheduled folder too. Each goes through sendScheduledEmail,
 * which first takes the row from 'scheduled' to 'sending' in ONE conditional
 * update: whoever loses that race sends nothing, so a row is sent at most
 * once. The draft then goes out through the provider-draft send path
 * (sendProviderDraft, pinned to the row's mailbox), which settles the thread's
 * index the way any draft send does. Then the row is 'sent' (its words
 * cleared), or 'failed' with a short reason and the person told
 * ('email_send_failed'). A row left 'sending' (the process died mid-send) is
 * never sent again: the sweep marks it failed after STALE_SENDING_MS, since
 * the mail may already have gone.
 *
 * Not here yet: the chat agent scheduling a send. It would plug in at
 * scheduleNewMessage / scheduleExistingDraft below, as a tool on the eve
 * agent's mail tools, with the same ownership checks.
 *
 * Server only (service-role writes; the routes check the row is the caller's).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { createNotification } from '@/lib/notifications'
import { saveDraftToProvider } from '@/lib/crm/email-client'
import { pinnedMailbox, sendProviderDraft, updateProviderDraft } from '@/lib/integrations/email'
import { GMAIL_API, GRAPH_API, gmailDraftIdFor, isProviderId } from '@/lib/email/provider-drafts'
import type { DraftEdits } from '@/lib/email/draft-edits'

export const SCHEDULED_SEND_STATUSES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled'] as const
export type ScheduledSendStatus = (typeof SCHEDULED_SEND_STATUSES)[number]

/** The Inngest event that sends one row at its time. */
export const SCHEDULED_SEND_EVENT = 'email/scheduled-send.due' as const

/** What the Scheduled folder lists: waiting, going out, or failed (until dismissed). */
export const LISTED_STATUSES: readonly ScheduledSendStatus[] = ['scheduled', 'sending', 'failed']

/** The furthest ahead a send may be scheduled. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000

/** A row 'sending' this long after its time was cut off mid-send: failed, never sent again. */
export const STALE_SENDING_MS = 60 * 60 * 1000

/** The most due rows one sweep sends (one at a time, oldest first). */
export const SWEEP_LIMIT = 20

/** The columns the app reads (never the draft's id to the browser). */
export const SCHEDULED_SEND_COLUMNS = 'id, workspace_id, user_id, account_id, provider, provider_draft_id, thread_id, to_emails, subject, send_at, status, error, sent_at, created_at'

/** What the browser is told about a row. */
export const SCHEDULED_SEND_PUBLIC_COLUMNS = 'id, account_id, provider, thread_id, to_emails, subject, send_at, status, error, sent_at, created_at'

export interface ScheduledSendRow {
  id: string
  workspace_id: string
  user_id: string
  account_id: string
  provider: 'google' | 'microsoft'
  provider_draft_id: string
  thread_id: string | null
  to_emails: string[] | null
  subject: string | null
  send_at: string
  status: ScheduledSendStatus
  error: string | null
  sent_at: string | null
  created_at: string
}

/** The reasons a send fails, as the person reads them (short; the column holds at most 300). */
export const FAILURE = {
  mailbox: 'The mailbox it was to go from is no longer connected. It is still a draft there.',
  gone: 'The draft was no longer in your mailbox: it was sent or deleted.',
  noRecipients: 'The draft has no recipients. It is still a draft.',
  refused: 'Your mailbox did not send it. It is still a draft.',
  unconfirmed: 'It could not be confirmed as sent. Check Sent before sending it again.',
} as const

type Mailbox = { provider: 'google' | 'microsoft'; token: string; email: string | null }

export interface ScheduledSendDeps {
  db: () => SupabaseClient
  now: () => Date
  mailbox: (userId: string, accountId: string) => Promise<Mailbox | null>
  fetch: typeof fetch
  sendDraft: typeof sendProviderDraft
  notify: typeof createNotification
  queue: (row: Pick<ScheduledSendRow, 'id' | 'send_at'>) => Promise<void>
}

export const defaultScheduledSendDeps: ScheduledSendDeps = {
  db: () => getServiceClient(),
  now: () => new Date(),
  mailbox: (userId, accountId) => pinnedMailbox(userId, accountId),
  fetch: (input, init) => fetch(input, init),
  sendDraft: (...args) => sendProviderDraft(...args),
  notify: (params) => createNotification(params),
  queue: (row) => queueScheduledSend(row),
}

// ── When ────────────────────────────────────────────────────────────────────

/** A send time the server takes: a parseable instant, after now, within MAX_SCHEDULE_AHEAD_MS. */
export function parseSendAt(raw: unknown, now: Date): Date | 'invalid' | 'past' | 'too_far' {
  if (typeof raw !== 'string' || !raw.trim()) return 'invalid'
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return 'invalid'
  if (at.getTime() <= now.getTime()) return 'past'
  if (at.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) return 'too_far'
  return at
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export type ScheduleResult =
  | { ok: true; row: ScheduledSendRow }
  | { ok: false; reason: 'account' | 'not_found' | 'rich' | 'invalid' | 'failed'; message: string }

const SUMMARY_RECIPIENTS = 50
const SUMMARY_SUBJECT = 300

function summary(to: readonly string[] | null | undefined, subject: string | null | undefined) {
  return {
    to_emails: (to ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, SUMMARY_RECIPIENTS).map((t) => t.trim().slice(0, 320)),
    subject: typeof subject === 'string' ? subject.slice(0, SUMMARY_SUBJECT) : '',
  }
}

async function insertRow(
  deps: ScheduledSendDeps,
  row: Omit<ScheduledSendRow, 'id' | 'status' | 'error' | 'sent_at' | 'created_at'>,
): Promise<ScheduleResult> {
  const { data, error } = await deps
    .db()
    .from('email_scheduled_send')
    .insert({ ...row, status: 'scheduled' })
    .select(SCHEDULED_SEND_COLUMNS)
    .single()
  if (error || !data) {
    console.error('[scheduled-send] insert failed:', error?.message ?? 'no row')
    return { ok: false, reason: 'failed', message: 'It was saved as a draft, but could not be scheduled.' }
  }
  const saved = data as ScheduledSendRow
  // Timed at send_at; the sweep sends it if this never arrives.
  try {
    await deps.queue(saved)
  } catch (err) {
    console.warn('[scheduled-send] event not queued (the sweep will send it):', err instanceof Error ? err.message : err)
  }
  return { ok: true, row: saved }
}

/**
 * A new message (the composer's Send later): saved as a draft in the mailbox
 * the person picked (theirs: the same check sendEmail makes), then scheduled.
 */
export async function scheduleNewMessage(
  input: {
    userId: string
    workspaceId: string
    accountId: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    bodyHtml: string
    sendAt: Date
  },
  deps: ScheduledSendDeps = defaultScheduledSendDeps,
): Promise<ScheduleResult> {
  const mailbox = await deps.mailbox(input.userId, input.accountId)
  if (!mailbox) return { ok: false, reason: 'account', message: 'Pick one of your own connected mailboxes to send from.' }
  let draftId: string
  try {
    // The DRAFT's id at Gmail (drafts.create answers it), the message id at Graph.
    ;({ draft_id: draftId } = await saveDraftToProvider(input.userId, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body_html: input.bodyHtml,
      account_id: input.accountId,
    }))
  } catch (err) {
    console.error('[scheduled-send] draft not saved:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'failed', message: 'Could not save the message to your mailbox.' }
  }
  if (!isProviderId(draftId)) return { ok: false, reason: 'failed', message: 'Could not save the message to your mailbox.' }
  return insertRow(deps, {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    account_id: input.accountId,
    provider: mailbox.provider,
    provider_draft_id: draftId,
    thread_id: null,
    ...summary([...input.to, ...(input.cc ?? [])], input.subject),
    send_at: input.sendAt.toISOString(),
  })
}

/**
 * A draft already on a thread (a reply, from Mail's thread view), with the
 * person's edits if they made any: the edits are written into the draft
 * first (updateProviderDraft), then it is scheduled from the thread's own
 * mailbox (its index row's account). `shown` is what the folder lists when
 * there are no edits (the draft's recipients and subject as the pane showed
 * them): display only.
 */
export async function scheduleExistingDraft(
  input: {
    userId: string
    workspaceId: string
    threadId: string
    draftMessageId: string
    edits: DraftEdits | null
    shown?: { to: string[]; subject: string } | null
    sendAt: Date
  },
  deps: ScheduledSendDeps = defaultScheduledSendDeps,
): Promise<ScheduleResult> {
  if (!isProviderId(input.threadId) || !isProviderId(input.draftMessageId)) {
    return { ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' }
  }
  const { data: indexRow } = await deps
    .db()
    .from('email_thread_index')
    .select('account_id, provider')
    .eq('user_id', input.userId)
    .eq('workspace_id', input.workspaceId)
    .eq('provider_thread_id', input.threadId)
    .not('account_id', 'is', null)
    .limit(1)
    .maybeSingle()
  const accountId = (indexRow as { account_id?: unknown } | null)?.account_id
  if (typeof accountId !== 'string' || !accountId) {
    return { ok: false, reason: 'account', message: 'This thread’s mailbox is not one Native Intelligence can send from.' }
  }
  const mailbox = await deps.mailbox(input.userId, accountId)
  if (!mailbox) return { ok: false, reason: 'account', message: 'This thread’s mailbox is no longer connected.' }

  let messageId = input.draftMessageId
  let shown = input.shown ?? null
  try {
    if (input.edits) {
      const updated = await updateProviderDraft(input.userId, input.workspaceId, input.threadId, input.draftMessageId, {
        body: input.edits.body,
        subject: input.edits.subject,
        to: input.edits.to,
        cc: input.edits.cc,
      })
      if (!updated.ok) {
        if (updated.reason === 'rich') return { ok: false, reason: 'rich', message: 'This draft has formatting or files an edit would drop. Schedule it without editing.' }
        if (updated.reason === 'invalid') return { ok: false, reason: 'invalid', message: 'Check the recipients, the subject and the message' }
        return { ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' }
      }
      messageId = updated.messageId
      shown = { to: [...updated.edits.to, ...updated.edits.cc], subject: updated.edits.subject }
    }
    const draftRef = await draftReferenceFor(deps, mailbox, input.threadId, messageId)
    if (!draftRef) return { ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' }
    return insertRow(deps, {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      account_id: accountId,
      provider: mailbox.provider,
      provider_draft_id: draftRef,
      thread_id: input.threadId,
      ...summary(shown?.to, shown?.subject),
      send_at: input.sendAt.toISOString(),
    })
  } catch (err) {
    console.error('[scheduled-send] draft not scheduled:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'failed', message: 'Could not schedule the draft.' }
  }
}

/**
 * The id a row keeps for a draft on a thread: Gmail's draft id (found from the
 * message id), Graph's message id once the mailbox says it is a draft on that
 * thread. Null: no such draft.
 */
async function draftReferenceFor(deps: ScheduledSendDeps, mailbox: Mailbox, threadId: string, messageId: string): Promise<string | null> {
  if (mailbox.provider === 'google') return gmailDraftIdFor(mailbox.token, messageId)
  const res = await deps.fetch(`${GRAPH_API}/messages/${encodeURIComponent(messageId)}?$select=isDraft,conversationId`, {
    headers: { Authorization: `Bearer ${mailbox.token}` },
  })
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Outlook message fetch error: ${res.status}`)
  const meta = (await res.json()) as { isDraft?: unknown; conversationId?: unknown }
  return meta.isDraft === true && meta.conversationId === threadId ? messageId : null
}

/** The Inngest event that sends `row` at its time (deduplicated by row). */
export async function queueScheduledSend(row: Pick<ScheduledSendRow, 'id' | 'send_at'>): Promise<void> {
  await inngest.send({
    id: `email-scheduled-send:${row.id}`,
    name: SCHEDULED_SEND_EVENT,
    data: { scheduledSendId: row.id },
    ts: Date.parse(row.send_at),
  })
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type SendOutcome = 'sent' | 'failed' | 'skipped'

/**
 * Take a row to send: 'scheduled' → 'sending', in one conditional update.
 * A row that is not 'scheduled' any more (sent, being sent, cancelled), not
 * due (unless `immediate`: Send now, which moves its time to now), or not
 * `userId`'s (when given) comes back null and nothing is sent.
 */
export async function claimScheduledSend(
  deps: ScheduledSendDeps,
  id: string,
  opts: { userId?: string; immediate?: boolean } = {},
): Promise<ScheduledSendRow | null> {
  const nowIso = deps.now().toISOString()
  let q = deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'sending', ...(opts.immediate ? { send_at: nowIso } : {}) })
    .eq('id', id)
    .eq('status', 'scheduled')
  if (!opts.immediate) q = q.lte('send_at', nowIso)
  if (opts.userId) q = q.eq('user_id', opts.userId)
  const { data, error } = await q.select(SCHEDULED_SEND_COLUMNS).maybeSingle()
  if (error) {
    console.error('[scheduled-send] claim failed:', error.message)
    return null
  }
  return (data as ScheduledSendRow | null) ?? null
}

/**
 * Where the draft is now: its thread and current message id, read from the
 * mailbox by the id the row keeps. Null: the draft is gone (sent, deleted).
 * Throws when the mailbox can't be read (that says nothing about the draft).
 */
async function locateDraft(deps: ScheduledSendDeps, mailbox: Mailbox, draftRef: string): Promise<{ threadId: string; messageId: string } | null> {
  const auth = { Authorization: `Bearer ${mailbox.token}` }
  if (mailbox.provider === 'google') {
    const res = await deps.fetch(`${GMAIL_API}/drafts/${encodeURIComponent(draftRef)}?format=minimal`, { headers: auth })
    if (res.status === 400 || res.status === 404) return null
    if (!res.ok) throw new Error(`Gmail draft fetch error: ${res.status}`)
    const draft = (await res.json()) as { message?: { id?: unknown; threadId?: unknown } }
    const messageId = draft.message?.id
    const threadId = draft.message?.threadId
    return typeof messageId === 'string' && typeof threadId === 'string' ? { threadId, messageId } : null
  }
  const res = await deps.fetch(`${GRAPH_API}/messages/${encodeURIComponent(draftRef)}?$select=isDraft,conversationId`, { headers: auth })
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Outlook message fetch error: ${res.status}`)
  const meta = (await res.json()) as { isDraft?: unknown; conversationId?: unknown }
  return meta.isDraft === true && typeof meta.conversationId === 'string' ? { threadId: meta.conversationId, messageId: draftRef } : null
}

/**
 * Send one scheduled row, if it is still 'scheduled' and due (or `immediate`).
 * Never throws: every way it can go is the row's status, and a failure is
 * told to the person.
 */
export async function sendScheduledEmail(
  id: string,
  opts: { userId?: string; immediate?: boolean } = {},
  deps: ScheduledSendDeps = defaultScheduledSendDeps,
): Promise<SendOutcome> {
  const row = await claimScheduledSend(deps, id, opts)
  if (!row) return 'skipped'

  let reason: string
  try {
    const mailbox = await deps.mailbox(row.user_id, row.account_id)
    if (!mailbox || mailbox.provider !== row.provider) {
      reason = FAILURE.mailbox
    } else {
      const located = await locateDraft(deps, mailbox, row.provider_draft_id)
      if (!located) {
        reason = FAILURE.gone
      } else {
        const result = await deps.sendDraft(row.user_id, row.workspace_id, located.threadId, located.messageId, null, { accountId: row.account_id })
        if (result.ok) {
          await markSent(deps, row)
          return 'sent'
        }
        reason = result.reason === 'no_recipients' ? FAILURE.noRecipients : FAILURE.gone
      }
    }
  } catch (err) {
    // sendProviderDraft never throws once the provider has sent, so a throw means it did not go.
    console.error('[scheduled-send] send failed:', err instanceof Error ? err.message : err)
    reason = FAILURE.refused
  }
  await markFailed(deps, row, reason)
  return 'failed'
}

/** Sent: its time, and nothing of the message left (the folder's words cleared). */
async function markSent(deps: ScheduledSendDeps, row: ScheduledSendRow): Promise<void> {
  const { error } = await deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'sent', sent_at: deps.now().toISOString(), to_emails: null, subject: null, error: null })
    .eq('id', row.id)
    .eq('status', 'sending')
  // The mail is gone already: a row left 'sending' is failed as unconfirmed by the sweep, never sent again.
  if (error) console.error('[scheduled-send] sent, but the row was not marked:', error.message)
}

/** Failed, with why; the person is told. */
async function markFailed(deps: ScheduledSendDeps, row: Pick<ScheduledSendRow, 'id' | 'user_id' | 'workspace_id'>, reason: string): Promise<void> {
  const { error } = await deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'failed', error: reason.slice(0, 300) })
    .eq('id', row.id)
    .eq('status', 'sending')
  if (error) console.error('[scheduled-send] failure not recorded:', error.message)
  await tellFailed(deps, row, reason)
}

async function tellFailed(deps: ScheduledSendDeps, row: Pick<ScheduledSendRow, 'id' | 'user_id' | 'workspace_id'>, reason: string): Promise<void> {
  try {
    const { data: member } = await deps
      .db()
      .from('member')
      .select('id')
      .eq('user_id', row.user_id)
      .eq('workspace_id', row.workspace_id)
      .maybeSingle()
    const memberId = (member as { id?: unknown } | null)?.id
    if (typeof memberId !== 'string') return
    // The reason only: never the subject or the recipients (no mail text in a notification).
    await deps.notify({
      workspaceId: row.workspace_id,
      recipientId: memberId,
      type: 'email_send_failed',
      title: 'A scheduled email wasn’t sent',
      body: reason,
      targetType: 'email_draft',
      targetId: row.id,
    })
  } catch (err) {
    console.warn('[scheduled-send] the person was not told:', err instanceof Error ? err.message : err)
  }
}

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * Every 5 minutes: rows cut off mid-send long ago are failed (never sent
 * again: the mail may have gone), then due rows the event missed are sent,
 * oldest first, one at a time, each through the same claim.
 */
export async function sweepScheduledSends(deps: ScheduledSendDeps = defaultScheduledSendDeps): Promise<{ sent: number; failed: number; skipped: number; stale: number }> {
  const db = deps.db()
  const now = deps.now()
  let stale = 0
  const { data: stuck } = await db
    .from('email_scheduled_send')
    .select('id, user_id, workspace_id')
    .eq('status', 'sending')
    .lt('send_at', new Date(now.getTime() - STALE_SENDING_MS).toISOString())
    .order('send_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  for (const row of (stuck ?? []) as Array<Pick<ScheduledSendRow, 'id' | 'user_id' | 'workspace_id'>>) {
    await markFailed(deps, row, FAILURE.unconfirmed)
    stale++
  }

  const { data: due, error } = await db
    .from('email_scheduled_send')
    .select('id')
    .eq('status', 'scheduled')
    .lte('send_at', now.toISOString())
    .order('send_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  if (error) throw new Error(`scheduled sends unreadable: ${error.message}`)
  const counts = { sent: 0, failed: 0, skipped: 0, stale }
  for (const { id } of (due ?? []) as Array<{ id: string }>) {
    counts[await sendScheduledEmail(id, {}, deps)]++
  }
  return counts
}

// ── The owner's own changes ─────────────────────────────────────────────────

export type OwnerChange = { ok: true } | { ok: false; reason: 'not_found' | 'conflict' }

/** The caller's own row, or null. */
export async function ownScheduledSend(deps: ScheduledSendDeps, userId: string, workspaceId: string, id: string): Promise<ScheduledSendRow | null> {
  const { data } = await deps
    .db()
    .from('email_scheduled_send')
    .select(SCHEDULED_SEND_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as ScheduledSendRow | null) ?? null
}

/** Cancel (Undo, or Cancel in the folder): it stays a normal draft in the mailbox. Only a row still 'scheduled'. */
export async function cancelScheduledSend(
  userId: string,
  workspaceId: string,
  id: string,
  deps: ScheduledSendDeps = defaultScheduledSendDeps,
): Promise<OwnerChange> {
  const own = await ownScheduledSend(deps, userId, workspaceId, id)
  if (!own) return { ok: false, reason: 'not_found' }
  const { data } = await deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle()
  return data ? { ok: true } : { ok: false, reason: 'conflict' }
}

/** Dismiss a failed row from the folder (its draft, if any, stays in the mailbox). */
export async function dismissScheduledSend(
  userId: string,
  workspaceId: string,
  id: string,
  deps: ScheduledSendDeps = defaultScheduledSendDeps,
): Promise<OwnerChange> {
  const own = await ownScheduledSend(deps, userId, workspaceId, id)
  if (!own) return { ok: false, reason: 'not_found' }
  if (own.status !== 'failed') return { ok: false, reason: 'conflict' }
  const { error } = await deps.db().from('email_scheduled_send').delete().eq('id', id).eq('user_id', userId).eq('status', 'failed')
  return error ? { ok: false, reason: 'conflict' } : { ok: true }
}

/** What the browser gets for a row: never the draft's id or the owner's. */
export function publicRow(row: ScheduledSendRow): Omit<ScheduledSendRow, 'provider_draft_id' | 'user_id' | 'workspace_id'> {
  const { provider_draft_id: _draft, user_id: _user, workspace_id: _ws, ...rest } = row
  return rest
}
