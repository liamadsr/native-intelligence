/**
 * SEND LATER (migration 642): a person's own message, saved as a draft in the
 * mailbox they picked, sent by the app at the time they chose.
 *
 * Nothing of the message is stored here: it waits in their mailbox as a
 * provider draft, and an `email_scheduled_send` row names it (by the id that
 * survives edits: Gmail's DRAFT id `r-…`, Graph's message id), the mailbox
 * (`account_id`), its thread, and when. `to_emails` and `subject` are for the
 * Scheduled folder only: cleared once it is sent or cancelled (a failed row
 * keeps them until dismissed, so its owner sees which one failed), and every
 * row that is done is purged after PURGE_AFTER_MS.
 *
 * Who sends it: an Inngest event timed at `send_at`
 * (src/lib/inngest/email-scheduled-send.ts), and the 5-minute sweep
 * (/api/cron/email-scheduled-send) for any due row the event missed; "Send
 * now" in the Scheduled folder too. Each goes through sendScheduledEmail,
 * which first takes the row from 'scheduled' to 'sending' in ONE conditional
 * update (stamping `claimed_at`): whoever loses that race sends nothing, so a
 * row is sent at most once. Then:
 *   - BEFORE the send (the mailbox's token, finding the draft): an error that
 *     says nothing about the draft (a 429, a 5xx, a token refresh that failed)
 *     puts the row back to 'scheduled' a little later (RETRY_AFTER_MS: 5, 15,
 *     then 45 minutes; `attempts` counts them), then fails it. A mailbox that
 *     is no longer connected, or a draft that is gone, fails it at once.
 *   - THE SEND (sendProviderDraft, pinned to the row's mailbox, which settles
 *     the thread's index as any draft send does): an error there fails the
 *     row at once, never retried, since the mail may have gone.
 * Then the row is 'sent' (its words cleared), or 'failed' with a short reason
 * and the person told ('email_send_failed', which opens the Scheduled
 * folder). A row left 'sending' STALE_SENDING_MS after its claim (the process
 * died mid-send) is failed, never sent again.
 *
 * An agent's draft that is scheduled leaves review ('approved': scheduling is
 * the person's yes), and the agent-draft expiry and the held-thread refresh
 * leave any draft with a live schedule alone (./scheduled-refs.ts). A draft
 * sent or discarded by hand cancels its schedule (sendProviderDraft,
 * discardProviderDraft). Scheduling a draft that already waits moves that
 * schedule (one waiting row per draft).
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
import { pinnedMailboxState, sendProviderDraft, updateProviderDraft, type PinnedMailbox } from '@/lib/integrations/email'
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

/** A row 'sending' this long after its claim was cut off mid-send: failed, never sent again. */
export const STALE_SENDING_MS = 60 * 60 * 1000

/** After a pre-send error, the row is tried again this much later (by attempt); then it fails. */
export const RETRY_AFTER_MS = [5, 15, 45].map((m) => m * 60 * 1000)

/** Rows that are done (sent, cancelled, failed) are deleted this long after their time. */
export const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** The most due rows one sweep sends (one at a time, oldest first). */
export const SWEEP_LIMIT = 20

/** The columns the app reads. */
export const SCHEDULED_SEND_COLUMNS =
  'id, workspace_id, user_id, account_id, provider, provider_draft_id, thread_id, to_emails, subject, send_at, status, error, sent_at, claimed_at, attempts, created_at'

/** What the browser is told about a row (never the draft's id, the owner's or the workspace's). */
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
  claimed_at: string | null
  attempts: number
  created_at: string
}

/** The reasons a send fails, as the person reads them (short; the column holds at most 300). */
export const FAILURE = {
  mailbox: 'The mailbox it was to go from is no longer connected. It is still a draft there.',
  unreachable: 'Your mailbox could not be reached. It is still a draft there.',
  gone: 'The draft was no longer in your mailbox: it was sent or deleted.',
  noRecipients: 'The draft has no recipients. It is still a draft.',
  refused: 'Your mailbox did not send it. It is still a draft, unless it shows in Sent.',
  unconfirmed: 'It could not be confirmed as sent. Check Sent before sending it again.',
} as const

type MailboxState = PinnedMailbox | 'not_connected' | 'unreachable'

export interface ScheduledSendDeps {
  db: () => SupabaseClient
  now: () => Date
  /** The row's mailbox: usable, not connected, or unreachable now; throws when it can't be read. */
  mailbox: (userId: string, accountId: string) => Promise<MailboxState>
  fetch: typeof fetch
  sendDraft: typeof sendProviderDraft
  notify: typeof createNotification
  queue: (row: Pick<ScheduledSendRow, 'id' | 'send_at'>) => Promise<void>
}

export const defaultScheduledSendDeps: ScheduledSendDeps = {
  db: () => getServiceClient(),
  now: () => new Date(),
  mailbox: (userId, accountId) => pinnedMailboxState(userId, accountId),
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
const NOT_SCHEDULED = 'It was saved as a draft, but could not be scheduled.'

function summary(to: readonly string[] | null | undefined, subject: string | null | undefined) {
  return {
    to_emails: (to ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, SUMMARY_RECIPIENTS).map((t) => t.trim().slice(0, 320)),
    subject: typeof subject === 'string' ? subject.slice(0, SUMMARY_SUBJECT) : '',
  }
}

type NewRow = Pick<ScheduledSendRow, 'workspace_id' | 'user_id' | 'account_id' | 'provider' | 'provider_draft_id' | 'thread_id' | 'to_emails' | 'subject' | 'send_at'>

/**
 * Save the schedule: the draft's waiting row moved to the new time when it
 * has one (scheduling the same draft again replaces its schedule), else a new
 * row. Then the timed event is queued (the sweep sends it if it never comes).
 */
async function saveSchedule(deps: ScheduledSendDeps, row: NewRow): Promise<ScheduledSendRow | null> {
  const db = deps.db()
  const moveWaiting = async () => {
    const { data } = await db
      .from('email_scheduled_send')
      .update({ ...row, attempts: 0, error: null, claimed_at: null })
      .eq('user_id', row.user_id)
      .eq('provider_draft_id', row.provider_draft_id)
      .eq('status', 'scheduled')
      .select(SCHEDULED_SEND_COLUMNS)
      .maybeSingle()
    return (data as ScheduledSendRow | null) ?? null
  }
  let saved = await moveWaiting()
  if (!saved) {
    const { data, error } = await db
      .from('email_scheduled_send')
      .insert({ ...row, status: 'scheduled' })
      .select(SCHEDULED_SEND_COLUMNS)
      .single()
    if (error?.code === '23505') saved = await moveWaiting()
    else if (error || !data) console.error('[scheduled-send] insert failed:', error?.message ?? 'no row')
    else saved = data as ScheduledSendRow
  }
  if (!saved) return null
  try {
    await deps.queue(saved)
  } catch (err) {
    console.warn('[scheduled-send] event not queued (the sweep will send it):', err instanceof Error ? err.message : err)
  }
  return saved
}

/** A draft just saved for a schedule that then could not be saved: deleted, so a retry makes no second one. */
async function deleteSavedDraft(deps: ScheduledSendDeps, mailbox: PinnedMailbox, draftRef: string): Promise<void> {
  const url = mailbox.provider === 'google' ? `${GMAIL_API}/drafts/${encodeURIComponent(draftRef)}` : `${GRAPH_API}/messages/${encodeURIComponent(draftRef)}`
  try {
    const res = await deps.fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${mailbox.token}` } })
    if (!res.ok && res.status !== 404) console.warn('[scheduled-send] unscheduled draft not deleted:', res.status)
  } catch (err) {
    console.warn('[scheduled-send] unscheduled draft not deleted:', err instanceof Error ? err.message : err)
  }
}

async function usableMailbox(deps: ScheduledSendDeps, userId: string, accountId: string): Promise<PinnedMailbox | 'not_connected' | 'unreachable'> {
  try {
    return await deps.mailbox(userId, accountId)
  } catch {
    return 'unreachable'
  }
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
  const mailbox = await usableMailbox(deps, input.userId, input.accountId)
  if (mailbox === 'not_connected') return { ok: false, reason: 'account', message: 'Pick one of your own connected mailboxes to send from.' }
  if (mailbox === 'unreachable') return { ok: false, reason: 'failed', message: 'Your mailbox could not be reached. Try again.' }
  let saved: { draft_id: string; thread_id: string | null }
  try {
    // The DRAFT's id at Gmail (drafts.create answers it), the message id at Graph.
    saved = await saveDraftToProvider(input.userId, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      body_html: input.bodyHtml,
      account_id: input.accountId,
    })
  } catch (err) {
    console.error('[scheduled-send] draft not saved:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'failed', message: 'Could not save the message to your mailbox.' }
  }
  if (!isProviderId(saved.draft_id)) return { ok: false, reason: 'failed', message: 'Could not save the message to your mailbox.' }
  const row = await saveSchedule(deps, {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    account_id: input.accountId,
    provider: mailbox.provider,
    provider_draft_id: saved.draft_id,
    thread_id: isProviderId(saved.thread_id) ? saved.thread_id : null,
    ...summary([...input.to, ...(input.cc ?? [])], input.subject),
    send_at: input.sendAt.toISOString(),
  })
  if (!row) {
    await deleteSavedDraft(deps, mailbox, saved.draft_id)
    return { ok: false, reason: 'failed', message: 'Could not schedule the message. Nothing was saved.' }
  }
  return { ok: true, row }
}

/**
 * A draft already on a thread (a reply, from Mail's thread view), with the
 * person's edits if they made any: the edits are written into the draft first
 * (flattened to text, exactly as Send with edits sends them), then it is
 * scheduled from the thread's own mailbox (its index row's account). An
 * agent's draft for it leaves review. `shown` is what the folder lists when
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
  const mailbox = await usableMailbox(deps, input.userId, accountId)
  if (mailbox === 'not_connected') return { ok: false, reason: 'account', message: 'This thread’s mailbox is no longer connected.' }
  if (mailbox === 'unreachable') return { ok: false, reason: 'failed', message: 'Your mailbox could not be reached. Try again.' }

  let messageId = input.draftMessageId
  let shown = input.shown ?? null
  try {
    if (input.edits) {
      const updated = await updateProviderDraft(
        input.userId,
        input.workspaceId,
        input.threadId,
        input.draftMessageId,
        { body: input.edits.body, subject: input.edits.subject, to: input.edits.to, cc: input.edits.cc },
        { flatten: true },
      )
      if (!updated.ok) {
        if (updated.reason === 'invalid') return { ok: false, reason: 'invalid', message: 'Check the recipients, the subject and the message' }
        if (updated.reason === 'rich') return { ok: false, reason: 'rich', message: 'This draft can’t be edited here. Schedule it without editing.' }
        return { ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' }
      }
      messageId = updated.messageId
      shown = { to: [...updated.edits.to, ...updated.edits.cc], subject: updated.edits.subject }
    }
    const draftRef = await draftReferenceFor(deps, mailbox, input.threadId, messageId)
    if (!draftRef) return { ok: false, reason: 'not_found', message: 'This draft is no longer in your mailbox.' }
    const row = await saveSchedule(deps, {
      workspace_id: input.workspaceId,
      user_id: input.userId,
      account_id: accountId,
      provider: mailbox.provider,
      provider_draft_id: draftRef,
      thread_id: input.threadId,
      ...summary(shown?.to, shown?.subject),
      send_at: input.sendAt.toISOString(),
    })
    if (!row) return { ok: false, reason: 'failed', message: NOT_SCHEDULED }
    await approveAgentDraft(deps, input.userId, input.draftMessageId, messageId)
    return { ok: true, row }
  } catch (err) {
    console.error('[scheduled-send] draft not scheduled:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'failed', message: 'Could not schedule the draft.' }
  }
}

/**
 * An agent's draft (an email_draft row naming this draft message) that is
 * scheduled leaves review: scheduling is the person's yes. 'approved' keeps
 * it from the untouched-draft expiry and from being re-drafted, and an edit
 * at Gmail (a new message id) re-points the row. Best-effort: the expiry and
 * the held-thread refresh also leave a scheduled thread alone.
 */
async function approveAgentDraft(deps: ScheduledSendDeps, userId: string, oldMessageId: string, messageId: string): Promise<void> {
  try {
    const { error } = await deps
      .db()
      .from('email_draft')
      .update({ status: 'approved', provider_draft_id: messageId, updated_at: deps.now().toISOString() })
      .eq('user_id', userId)
      .eq('provider_draft_id', oldMessageId)
      .in('status', ['pending_review', 'edited'])
    if (error) throw new Error(error.message)
  } catch (err) {
    console.warn('[scheduled-send] agent draft not moved out of review:', err instanceof Error ? err.message : err)
  }
}

/**
 * The id a row keeps for a draft on a thread: Gmail's draft id (found from the
 * message id), Graph's message id once the mailbox says it is a draft on that
 * thread. Null: no such draft.
 */
async function draftReferenceFor(deps: ScheduledSendDeps, mailbox: PinnedMailbox, threadId: string, messageId: string): Promise<string | null> {
  if (mailbox.provider === 'google') return gmailDraftIdFor(mailbox.token, messageId)
  const res = await deps.fetch(`${GRAPH_API}/messages/${encodeURIComponent(messageId)}?$select=isDraft,conversationId`, {
    headers: { Authorization: `Bearer ${mailbox.token}` },
  })
  if (res.status === 400 || res.status === 404) return null
  if (!res.ok) throw new Error(`Outlook message fetch error: ${res.status}`)
  const meta = (await res.json()) as { isDraft?: unknown; conversationId?: unknown }
  return meta.isDraft === true && meta.conversationId === threadId ? messageId : null
}

/** The Inngest event that sends `row` at its time (deduplicated by row and time). */
export async function queueScheduledSend(row: Pick<ScheduledSendRow, 'id' | 'send_at'>): Promise<void> {
  const ts = Date.parse(row.send_at)
  await inngest.send({
    id: `email-scheduled-send:${row.id}:${ts}`,
    name: SCHEDULED_SEND_EVENT,
    data: { scheduledSendId: row.id },
    ts,
  })
}

// ── Sending ─────────────────────────────────────────────────────────────────

export type SendOutcome = 'sent' | 'failed' | 'retrying' | 'skipped'

/**
 * Take a row to send: 'scheduled' → 'sending' (stamping claimed_at), in one
 * conditional update. A row that is not 'scheduled' any more (sent, being
 * sent, cancelled), not due (unless `immediate`: Send now, which moves its
 * time to now), or not `userId`'s (when given) comes back null and nothing
 * is sent.
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
    .update({ status: 'sending', claimed_at: nowIso, ...(opts.immediate ? { send_at: nowIso } : {}) })
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
async function locateDraft(deps: ScheduledSendDeps, mailbox: PinnedMailbox, draftRef: string): Promise<{ threadId: string; messageId: string } | null> {
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

  // Before the send: nothing has gone out, so an error here may be tried again.
  let mailbox: PinnedMailbox
  let located: { threadId: string; messageId: string } | null
  try {
    const state = await deps.mailbox(row.user_id, row.account_id)
    if (state === 'not_connected' || (typeof state !== 'string' && state.provider !== row.provider)) {
      return await markFailed(deps, row, FAILURE.mailbox)
    }
    if (state === 'unreachable') return await retryLater(deps, row)
    mailbox = state
    located = await locateDraft(deps, mailbox, row.provider_draft_id)
  } catch (err) {
    console.warn('[scheduled-send] mailbox not reached before the send:', err instanceof Error ? err.message : err)
    return await retryLater(deps, row)
  }
  if (!located) return await markFailed(deps, row, FAILURE.gone)

  // The send: an error here may have sent it, so it is never tried again.
  let reason: string
  try {
    const result = await deps.sendDraft(row.user_id, row.workspace_id, located.threadId, located.messageId, null, { accountId: row.account_id })
    if (result.ok) {
      await markSent(deps, row)
      return 'sent'
    }
    reason = result.reason === 'no_recipients' ? FAILURE.noRecipients : FAILURE.gone
  } catch (err) {
    console.error('[scheduled-send] send failed:', err instanceof Error ? err.message : err)
    reason = FAILURE.refused
  }
  return await markFailed(deps, row, reason)
}

/**
 * A pre-send error: back to 'scheduled', RETRY_AFTER_MS[attempts] later, and
 * queued for then; once those run out, failed (the mailbox could not be reached).
 */
async function retryLater(deps: ScheduledSendDeps, row: ScheduledSendRow): Promise<SendOutcome> {
  const attempts = row.attempts ?? 0
  if (attempts >= RETRY_AFTER_MS.length) return markFailed(deps, row, FAILURE.unreachable)
  const sendAt = new Date(deps.now().getTime() + RETRY_AFTER_MS[attempts]).toISOString()
  const { data, error } = await deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'scheduled', send_at: sendAt, attempts: attempts + 1, claimed_at: null })
    .eq('id', row.id)
    .eq('status', 'sending')
    .select('id')
  if (error || !data?.length) {
    if (error) console.error('[scheduled-send] retry not recorded:', error.message)
    return 'skipped'
  }
  try {
    await deps.queue({ id: row.id, send_at: sendAt })
  } catch (err) {
    console.warn('[scheduled-send] retry not queued (the sweep will send it):', err instanceof Error ? err.message : err)
  }
  return 'retrying'
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

/** Failed, with why (its words kept until dismissed); the person is told, only when this update failed it. */
async function markFailed(deps: ScheduledSendDeps, row: Pick<ScheduledSendRow, 'id' | 'user_id' | 'workspace_id'>, reason: string): Promise<SendOutcome> {
  const { data, error } = await deps
    .db()
    .from('email_scheduled_send')
    .update({ status: 'failed', error: reason.slice(0, 300) })
    .eq('id', row.id)
    .eq('status', 'sending')
    .select('id')
  if (error) {
    console.error('[scheduled-send] failure not recorded:', error.message)
    return 'failed'
  }
  if (data?.length) await tellFailed(deps, row, reason)
  return 'failed'
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
    // Its type opens Mail's Scheduled folder, where the reason shows (notification-panel.tsx).
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

export interface SweepCounts {
  sent: number
  failed: number
  retrying: number
  skipped: number
  stale: number
  purged: number
}

/**
 * Every 5 minutes: rows cut off mid-send (claimed over STALE_SENDING_MS ago)
 * are failed, never sent again (the mail may have gone); due rows the event
 * missed are sent, oldest first, one at a time, each through the same claim;
 * rows done more than PURGE_AFTER_MS ago are deleted.
 */
export async function sweepScheduledSends(deps: ScheduledSendDeps = defaultScheduledSendDeps): Promise<SweepCounts> {
  const db = deps.db()
  const now = deps.now()
  const counts: SweepCounts = { sent: 0, failed: 0, retrying: 0, skipped: 0, stale: 0, purged: 0 }
  const { data: stuck } = await db
    .from('email_scheduled_send')
    .select('id, user_id, workspace_id')
    .eq('status', 'sending')
    .lt('claimed_at', new Date(now.getTime() - STALE_SENDING_MS).toISOString())
    .order('claimed_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  for (const row of (stuck ?? []) as Array<Pick<ScheduledSendRow, 'id' | 'user_id' | 'workspace_id'>>) {
    await markFailed(deps, row, FAILURE.unconfirmed)
    counts.stale++
  }

  const { data: due, error } = await db
    .from('email_scheduled_send')
    .select('id')
    .eq('status', 'scheduled')
    .lte('send_at', now.toISOString())
    .order('send_at', { ascending: true })
    .limit(SWEEP_LIMIT)
  if (error) throw new Error(`scheduled sends unreadable: ${error.message}`)
  for (const { id } of (due ?? []) as Array<{ id: string }>) {
    counts[await sendScheduledEmail(id, {}, deps)]++
  }

  const { data: purged, error: purgeError } = await db
    .from('email_scheduled_send')
    .delete()
    .in('status', ['sent', 'cancelled', 'failed'])
    .lt('send_at', new Date(now.getTime() - PURGE_AFTER_MS).toISOString())
    .select('id')
  if (purgeError) console.warn('[scheduled-send] purge failed:', purgeError.message)
  counts.purged = Array.isArray(purged) ? purged.length : 0
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

/** Cancel (Undo, or Cancel in the folder): it stays a normal draft in the mailbox, and the row keeps no words. Only a row still 'scheduled'. */
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
    .update({ status: 'cancelled', to_emails: null, subject: null })
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

/** What the browser gets for a row: never the draft's id, the owner's, or the bookkeeping. */
export function publicRow(row: ScheduledSendRow) {
  const { provider_draft_id: _draft, user_id: _user, workspace_id: _ws, claimed_at: _claimed, attempts: _attempts, ...rest } = row
  return rest
}
