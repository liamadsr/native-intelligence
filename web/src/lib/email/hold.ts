import type { SupabaseClient } from '@supabase/supabase-js'
import type { EmailThreadForAI } from './email-read-service'
import { mailboxAddresses } from './reply-policy'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'

/**
 * True when an error says 343 is not applied yet (email_draft.hold_id or
 * .stale unknown): callers then fall back to the pre-343 shape, so code
 * deployed before the migration keeps drafting, sending and dismissing.
 */
export function isPre343Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, 'hold_id') || isMissingColumnError(error, 'stale')
}

/**
 * The holding pattern (migration 343; no stored mail, 2026-10-15).
 *
 * Native Intelligence keeps no copy of the person's mail, with ONE exception: a thread it
 * drafted a reply to. That thread's copy (its subject, and for each message
 * the sender, recipients, date, plain-text body and attachment names) waits in
 * `email_hold` beside the draft until the person acts:
 *
 *   draft    holdThread()        the copy is written (or refreshed) and the
 *                                draft row points at it (email_draft.hold_id);
 *   send     markHoldsSending()  status 'sending' while the provider sends,
 *            releaseDraftRows()  then the hold is deleted, its drafts with it
 *                                (restoreHolds() puts it back if the send fails);
 *   dismiss  releaseDraftRows()  the hold and its drafts are deleted (the
 *                                caller deletes the provider draft too);
 *   expiry   expireHolds()       14 days untouched, or stuck 'sending' for an
 *                                hour: deleted (the provider draft stays in the
 *                                mailbox, it is theirs). touchHold() on open or
 *                                edit pushes the expiry out;
 *   refresh  heldThreadAction()  a new message on a held thread: re-draft when
 *                                the draft is untouched, mark it stale when the
 *                                person edited it (src/lib/email/held-refresh.ts).
 *
 * This file is the ONLY place received-mail text is written to the database
 * (the tripwire test, src/lib/email/__tests__/no-stored-mail-tripwire.test.ts).
 * Only the mailbox owner reads a hold (RLS: auth.uid() = user_id); every read
 * here also fences on user_id, since callers use the service role.
 */

/** A hold left untouched this long is deleted. */
export const HOLD_TTL_MS = 14 * 24 * 60 * 60_000
/** A hold stuck 'sending' this long had its send die mid-flight: deleted. */
export const HOLD_SENDING_STUCK_MS = 60 * 60_000
/** A settled draft row ('sent', 'dismissed') untouched this long is swept (never one mid-settle). */
export const SETTLED_DRAFT_GRACE_MS = 10 * 60_000
/** The reply gate's own limits: at most this many messages, each body at most this long. */
export const HOLD_MAX_MESSAGES = 30
export const HOLD_MAX_BODY_CHARS = 20_000
/** Subjects are kept short: the review shows a line, not a paragraph. */
const HOLD_MAX_SUBJECT_CHARS = 500
/** Attachment names per message, each clipped. */
const HOLD_MAX_ATTACHMENTS = 20
const HOLD_MAX_ATTACHMENT_NAME = 200

/** One message of a held chain: plain text only, never HTML, never attachment bytes. */
export interface HeldMessage {
  message_id: string | null
  from: string
  to: string[]
  cc: string[]
  /** ISO when the provider said; else its display string. */
  date: string | null
  body_text: string
  attachment_names: string[]
}

export interface EmailHoldRow {
  id: string
  user_id: string
  workspace_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
  held_message_id: string
  subject: string | null
  messages: HeldMessage[]
  trust: 'injection' | null
  status: 'held' | 'sending'
  last_touched_at: string
  expires_at: string
  created_at: string
}

/** The columns a hold is read with (all of it: only its owner reads it). */
export const HOLD_COLUMNS =
  'id, user_id, workspace_id, account_id, provider, provider_thread_id, held_message_id, subject, messages, trust, status, last_touched_at, expires_at, created_at'

export interface HoldTarget {
  userId: string
  workspaceId: string
  accountId: string | null
  provider: 'google' | 'microsoft'
  providerThreadId: string
}

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** A header's addresses, lowercased (the review shows who, the body says what). */
function addressList(header: unknown): string[] {
  return typeof header === 'string' && header.trim() ? mailboxAddresses(header) : []
}

/**
 * The chain a hold keeps: the thread's sent messages (drafts are not part of
 * what the person answers), oldest first, the newest HOLD_MAX_MESSAGES, each
 * body plain text capped at HOLD_MAX_BODY_CHARS. Pure.
 */
export function heldMessagesFrom(thread: Pick<EmailThreadForAI, 'messages'>): HeldMessage[] {
  return thread.messages
    .filter((m) => !m.isDraft)
    .slice(-HOLD_MAX_MESSAGES)
    .map((m) => ({
      message_id: m.messageId ?? null,
      from: clip(m.from, 320),
      to: addressList(m.to),
      cc: addressList(m.cc),
      date: m.dateISO ?? (m.date ? String(m.date) : null),
      body_text: clip(m.bodyText, HOLD_MAX_BODY_CHARS),
      attachment_names: (m.attachmentNames ?? []).slice(0, HOLD_MAX_ATTACHMENTS).map((n) => clip(n, HOLD_MAX_ATTACHMENT_NAME)),
    }))
}

/** The newest sent message's provider id, which the hold reflects. Pure. */
export function newestHeldMessageId(thread: Pick<EmailThreadForAI, 'messages'>): string | null {
  return thread.messages.filter((m) => !m.isDraft).at(-1)?.messageId ?? null
}

function nowIso(now: Date): string {
  return now.toISOString()
}

function expiryFrom(now: Date): string {
  return new Date(now.getTime() + HOLD_TTL_MS).toISOString()
}

/** The hold for a thread of one mailbox, or null. Never throws. */
export async function findHold(
  supabase: SupabaseClient,
  target: Pick<HoldTarget, 'userId' | 'accountId' | 'providerThreadId'>,
): Promise<EmailHoldRow | null> {
  try {
    let query = supabase
      .from('email_hold')
      .select(HOLD_COLUMNS)
      .eq('user_id', target.userId)
      .eq('provider_thread_id', target.providerThreadId)
    query = target.accountId ? query.eq('account_id', target.accountId) : query.is('account_id', null)
    const { data, error } = await query.maybeSingle()
    if (error || !data) return null
    return data as unknown as EmailHoldRow
  } catch {
    return null
  }
}

/** Holds by id, the owner's only. Never throws: a failed read is none. */
export async function readHolds(supabase: SupabaseClient, userId: string, holdIds: readonly string[]): Promise<EmailHoldRow[]> {
  const ids = [...new Set(holdIds.filter((id) => typeof id === 'string' && id))]
  if (!ids.length) return []
  try {
    const { data, error } = await supabase.from('email_hold').select(HOLD_COLUMNS).eq('user_id', userId).in('id', ids)
    if (error || !Array.isArray(data)) return []
    return data as unknown as EmailHoldRow[]
  } catch {
    return []
  }
}

/**
 * Hold a thread: write its copy (or refresh an existing hold's) from the
 * thread just read live, and return the hold's id for the draft row. The ONE
 * writer of received mail text. Upserts on (owner, mailbox, thread): a found
 * hold is updated in place, else one is inserted (a racing insert that loses
 * on the unique key updates the winner). A refresh leaves the expiry alone:
 * only the person's own open or edit pushes it out (touchHold). Fails soft:
 * null when nothing could be written (the draft is then saved without a hold).
 */
export async function holdThread(
  supabase: SupabaseClient,
  target: HoldTarget & {
    thread: Pick<EmailThreadForAI, 'subject' | 'messages'>
    trust?: string | null
    /** A refresh: update an existing hold that is not mid-send, never create one. */
    mustExist?: boolean
  },
  now: Date = new Date(),
): Promise<string | null> {
  const heldMessageId = newestHeldMessageId(target.thread)
  if (!heldMessageId) return null
  const copy = {
    held_message_id: heldMessageId,
    subject: clip(target.thread.subject, HOLD_MAX_SUBJECT_CHARS) || null,
    messages: heldMessagesFrom(target.thread),
    trust: target.trust === 'injection' ? 'injection' : null,
    updated_at: nowIso(now),
  }
  try {
    const existing = await findHold(supabase, target)
    if (target.mustExist && (!existing || existing.status === 'sending')) return null
    if (existing) {
      // A refresh never writes over a hold mid-send.
      let update = supabase.from('email_hold').update(copy).eq('id', existing.id).eq('user_id', target.userId)
      if (target.mustExist) update = update.eq('status', 'held')
      const { error } = await update
      return error ? null : existing.id
    }
    const { data, error } = await supabase
      .from('email_hold')
      .insert({
        user_id: target.userId,
        workspace_id: target.workspaceId,
        account_id: target.accountId,
        provider: target.provider,
        provider_thread_id: target.providerThreadId,
        status: 'held',
        last_touched_at: nowIso(now),
        expires_at: expiryFrom(now),
        ...copy,
      })
      .select('id')
      .single()
    if (!error && data) return (data as { id: string }).id
    // Lost a race on the unique key: the other writer's hold gets this copy.
    const winner = await findHold(supabase, target)
    if (!winner) return null
    const { error: updateError } = await supabase.from('email_hold').update(copy).eq('id', winner.id).eq('user_id', target.userId)
    return updateError ? null : winner.id
  } catch {
    return null
  }
}

/** The person opened or edited the hold: it lives another 14 days. Never throws. */
export async function touchHold(supabase: SupabaseClient, userId: string, holdId: string, now: Date = new Date()): Promise<void> {
  try {
    await supabase
      .from('email_hold')
      .update({ last_touched_at: nowIso(now), expires_at: expiryFrom(now) })
      .eq('id', holdId)
      .eq('user_id', userId)
  } catch {
    // The hold keeps its old expiry.
  }
}

/** A draft row as the lifecycle reads it. */
export interface HeldDraftRow {
  id: string
  /** The draft's workspace (where a send or dismiss counts as the person's activity). */
  workspace_id?: string | null
  hold_id: string | null
  status: string | null
  stale?: boolean | null
  provider_draft_id: string | null
}

const DRAFT_LIFECYCLE_COLUMNS = 'id, workspace_id, hold_id, status, stale, provider_draft_id'
/** Before 343: no hold_id or stale (every row is then a loose draft). */
const DRAFT_LIFECYCLE_COLUMNS_PRE_343 = 'id, workspace_id, status, provider_draft_id'

/**
 * The owner's draft rows named by row id or by their provider draft id. With
 * `providerThreadId` too, a provider id that names no row (the person edited
 * the draft in Gmail, which gives it a new message id) falls back to the open
 * draft rows on that thread. Never throws.
 */
export async function draftRowsFor(
  supabase: SupabaseClient,
  userId: string,
  by: {
    draftId?: string | null
    providerDraftId?: string | null
    providerThreadId?: string | null
    /** The thread fallback only when exactly one open Native Intelligence draft is on it (a discard must not release another). */
    onlyIfSingle?: boolean
  },
): Promise<HeldDraftRow[]> {
  const exact = await draftRowsBy(supabase, userId, by)
  if (exact.length || by.draftId || !by.providerThreadId) return exact
  const open = (await draftRowsBy(supabase, userId, { providerThreadId: by.providerThreadId })).filter((r) =>
    ['pending_review', 'approved', 'edited'].includes(r.status ?? ''),
  )
  return by.onlyIfSingle && open.length !== 1 ? [] : open
}

async function draftRowsBy(
  supabase: SupabaseClient,
  userId: string,
  by: { draftId?: string | null; providerDraftId?: string | null; providerThreadId?: string | null },
): Promise<HeldDraftRow[]> {
  const [column, value] = by.draftId
    ? ['id', by.draftId]
    : by.providerDraftId
      ? ['provider_draft_id', by.providerDraftId]
      : by.providerThreadId
        ? ['provider_thread_id', by.providerThreadId]
        : [null, null]
  if (!column || !value) return []
  const read = (columns: string) => supabase.from('email_draft').select(columns).eq('user_id', userId).eq(column, value)
  try {
    let { data, error } = await read(DRAFT_LIFECYCLE_COLUMNS)
    if (error && isPre343Error(error)) ({ data, error } = await read(DRAFT_LIFECYCLE_COLUMNS_PRE_343))
    if (error || !Array.isArray(data)) return []
    return (data as unknown as Array<Partial<HeldDraftRow> & { id: string }>).map((r) => ({
      id: r.id,
      workspace_id: r.workspace_id ?? null,
      hold_id: r.hold_id ?? null,
      status: r.status ?? null,
      stale: r.stale ?? false,
      provider_draft_id: r.provider_draft_id ?? null,
    }))
  } catch {
    return []
  }
}

/**
 * Before a send: the holds behind these drafts go 'sending', so expiry and a
 * refresh leave them alone while the provider sends. Returns the hold ids it
 * marked (for restoreHolds). Never throws.
 */
export async function markHoldsSending(supabase: SupabaseClient, userId: string, rows: readonly HeldDraftRow[]): Promise<string[]> {
  const holdIds = [...new Set(rows.map((r) => r.hold_id).filter((id): id is string => typeof id === 'string' && !!id))]
  if (!holdIds.length) return []
  try {
    const { data, error } = await supabase
      .from('email_hold')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .in('id', holdIds)
      .eq('status', 'held')
      .select('id')
    if (error || !Array.isArray(data)) return []
    return (data as Array<{ id: string }>).map((r) => r.id)
  } catch {
    return []
  }
}

/** The send failed: the holds go back to 'held'. Never throws. */
export async function restoreHolds(supabase: SupabaseClient, userId: string, holdIds: readonly string[]): Promise<void> {
  if (!holdIds.length) return
  try {
    await supabase.from('email_hold').update({ status: 'held' }).eq('user_id', userId).in('id', [...holdIds]).eq('status', 'sending')
  } catch {
    // Expiry clears a hold stuck 'sending' within the hour.
  }
}

/**
 * Sent or dismissed: the drafts are done, and so is the mail behind them. A
 * row with a hold goes with its hold (the cascade deletes every draft on it);
 * a draft of the person's own words (no hold) is deleted on its own. Returns
 * the draft row ids released (their work items stop waiting). Never throws: a
 * row left behind is cleared by expiry.
 *
 * `keepSharedHolds` (one draft dismissed of several, src/lib/email/discard-drafts.ts):
 * a hold that still carries an open draft outside `rows` stays, and only the
 * rows go, so the thread's other draft keeps its review row (its mailbox copy
 * is still there). A kept hold whose last open draft went meanwhile (two
 * discards at once, each keeping it for the other) goes after all. When that
 * can't be read, every hold stays: expiry clears it.
 */
export async function releaseDraftRows(
  supabase: SupabaseClient,
  userId: string,
  rows: readonly HeldDraftRow[],
  opts: { reviewed?: boolean; keepSharedHolds?: boolean } = {},
): Promise<string[]> {
  if (!rows.length) return []
  // The person sent or dismissed it: a durable activity signal (the rows
  // themselves are deleted), which dormancy reads (workspaceIsDormant).
  if (opts.reviewed) await stampMailReview(supabase, userId, rows.map((r) => r.workspace_id ?? null))
  let holdIds = [...new Set(rows.map((r) => r.hold_id).filter((id): id is string => typeof id === 'string' && !!id))]
  let loose = rows.filter((r) => !r.hold_id).map((r) => r.id)
  let kept: string[] = []
  if (opts.keepSharedHolds && holdIds.length) {
    const shared = await sharedHolds(supabase, userId, holdIds, rows.map((r) => r.id))
    kept = holdIds.filter((id) => shared.has(id))
    holdIds = holdIds.filter((id) => !shared.has(id))
    loose = rows.filter((r) => !r.hold_id || shared.has(r.hold_id)).map((r) => r.id)
  }
  try {
    if (holdIds.length) await supabase.from('email_hold').delete().eq('user_id', userId).in('id', holdIds)
  } catch (err) {
    console.warn('[email-hold] hold not released:', err instanceof Error ? err.message : err)
  }
  try {
    if (loose.length) await supabase.from('email_draft').delete().eq('user_id', userId).in('id', loose)
  } catch (err) {
    console.warn('[email-hold] draft not released:', err instanceof Error ? err.message : err)
  }
  if (kept.length) {
    // Read again now these rows are gone: a kept hold no open draft rides on any more goes.
    const stillShared = await sharedHolds(supabase, userId, kept, [])
    const empty = kept.filter((id) => !stillShared.has(id))
    try {
      if (empty.length) await supabase.from('email_hold').delete().eq('user_id', userId).in('id', empty)
    } catch (err) {
      console.warn('[email-hold] hold not released:', err instanceof Error ? err.message : err)
    }
  }
  return rows.map((r) => r.id)
}

/** The holds among `holdIds` that carry an open draft outside `releasing`; every one when the read fails. */
async function sharedHolds(
  supabase: SupabaseClient,
  userId: string,
  holdIds: readonly string[],
  releasing: readonly string[],
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('email_draft')
      .select('id, hold_id')
      .eq('user_id', userId)
      .in('hold_id', [...holdIds])
      .in('status', ['pending_review', 'approved', 'edited'])
    if (error || !Array.isArray(data)) return new Set(holdIds)
    const going = new Set(releasing)
    return new Set(
      (data as Array<{ id: string; hold_id: string | null }>).filter((r) => !going.has(r.id) && r.hold_id).map((r) => r.hold_id as string),
    )
  } catch {
    return new Set(holdIds)
  }
}

/**
 * The person sent or dismissed a draft in these workspaces: a service-only
 * row records when (mail_review_activity, migration 343), since the draft rows
 * that used to say so are deleted now. Never on member: coworkers read it and
 * it is in realtime. Never throws (before 343 the table is missing and nothing
 * is stamped; dormancy then fails open).
 */
export async function stampMailReview(supabase: SupabaseClient, userId: string, workspaceIds: ReadonlyArray<string | null | undefined>, now: Date = new Date()): Promise<void> {
  const ids = [...new Set(workspaceIds.filter((id): id is string => typeof id === 'string' && !!id))]
  if (!ids.length) return
  try {
    for (const workspace_id of ids) {
      await supabase
        .from('mail_review_activity')
        .upsert({ user_id: userId, workspace_id, last_review_at: nowIso(now) }, { onConflict: 'user_id,workspace_id' })
    }
  } catch {
    // The signal is a hint for dormancy; a lost stamp only risks a quiet day.
  }
}

/** A hold whose thread is gone or was answered elsewhere: deleted, drafts with it. Never throws. */
export async function releaseHold(supabase: SupabaseClient, userId: string, holdId: string): Promise<void> {
  try {
    await supabase.from('email_hold').delete().eq('user_id', userId).eq('id', holdId)
  } catch {
    // Expiry clears it.
  }
}

/**
 * What a new message on a held thread does to its draft (Liam, 2026-10-15):
 *   'redraft'  the draft is untouched (pending review, never edited): write a new one;
 *   'stale'    the person edited it: keep their text, mark it stale;
 *   'none'     no open draft on the hold (or it is mid-send). Pure.
 */
export function heldThreadAction(draft: Pick<HeldDraftRow, 'status' | 'stale'> | null, holdStatus: string | null = 'held'): 'redraft' | 'stale' | 'none' {
  if (!draft || holdStatus === 'sending') return 'none'
  if (draft.status === 'pending_review' && !draft.stale) return 'redraft'
  if (draft.status === 'edited' || draft.status === 'approved' || (draft.status === 'pending_review' && draft.stale)) return 'stale'
  return 'none'
}

/**
 * The hourly expiry (Inngest `email-hold-expiry`): deletes
 *   - holds past expires_at (14 days untouched), drafts with them;
 *   - holds stuck 'sending' for over an hour (the send died mid-flight);
 *   - any settled draft row ('sent', 'dismissed') left behind, untouched for
 *     10 minutes (never one a send or dismiss is still settling).
 * A pending draft with no hold is the person's own words (compose, outreach,
 * a capture's follow-up): it quotes no received mail and is never swept.
 * Each delete runs on its own, so one failing never stops the others.
 * Never throws: a failed sweep is retried by the next run.
 */
export async function expireHolds(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<{ expired: number; stuck: number; drafts: number }> {
  const out = { expired: 0, stuck: 0, drafts: 0 }
  const count = (data: unknown) => (Array.isArray(data) ? data.length : 0)
  try {
    const { data } = await supabase.from('email_hold').delete().lt('expires_at', nowIso(now)).select('id')
    out.expired = count(data)
  } catch (err) {
    console.warn('[email-hold] expiry failed:', err instanceof Error ? err.message : err)
  }
  try {
    const { data } = await supabase
      .from('email_hold')
      .delete()
      .eq('status', 'sending')
      .lt('updated_at', new Date(now.getTime() - HOLD_SENDING_STUCK_MS).toISOString())
      .select('id')
    out.stuck = count(data)
  } catch (err) {
    console.warn('[email-hold] stuck-send sweep failed:', err instanceof Error ? err.message : err)
  }
  try {
    const { data: settled, error } = await supabase
      .from('email_draft')
      .delete()
      .in('status', ['sent', 'dismissed'])
      .lt('updated_at', new Date(now.getTime() - SETTLED_DRAFT_GRACE_MS).toISOString())
      .select('id')
    if (error) throw new Error(error.message)
    out.drafts = count(settled)
  } catch (err) {
    console.warn('[email-hold] draft sweep failed:', err instanceof Error ? err.message : err)
  }
  return out
}
