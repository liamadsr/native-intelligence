/**
 * Revise one of the person's own unsent email drafts in place (bots v3 Phase 5,
 * `revise_email_draft`; docs/plans/bots-v3.md "tell it what to do next"): "make
 * it more formal" on a draft rewrites it where it lives, never sends it.
 *
 * A draft is named by either id the person's surfaces hold:
 *   - an `email_draft` row id (a drafting pass's draft, the about section's
 *     deliverable): its row AND its mailbox draft (`provider_draft_id`) change;
 *   - a provider MESSAGE id (an agent's `create_email_draft` result, Mail's
 *     thread view): its mailbox draft changes, and a drafting-pass row that
 *     names it follows.
 *
 * OWNER-ONLY, both ways: the row is read with `user_id = the caller` in the
 * caller's workspace, and a provider id must be a draft the caller's own
 * thread index lists in that workspace (and the mailbox must say it is a draft
 * on that thread, updateProviderDraft). A sent or dismissed draft is refused.
 *
 * The mailbox first, then the row: when the mailbox's draft can't be written
 * (gone, edited since, not a draft), the row is left as it was, so Dial8 and
 * Mail never disagree about what the draft says. A pass's row whose mailbox
 * copy was never saved (provider_draft_id NULL) is revised in Dial8 only, and
 * says so. Sending stays the person's click. A mailbox draft a plain-text
 * rewrite would strip (attachments, inline images, an Outlook HTML body) is
 * refused, NOT_REVISABLE (updateProviderDraft's `rich`).
 *
 * Gmail gives a revised draft a NEW message id. The caller's work items
 * (tracked_job) and runs (agent_run) that delivered the old id are re-pointed
 * at the new one, so the run's output still shows the draft and sending it
 * still settles the item (repointDeliverables).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { updateProviderDraft, type DraftRevision } from '@/lib/integrations/email'
import { isProviderId } from '@/lib/email/provider-drafts'
import { plainTextToHtml } from '@/lib/email/plain-text-to-html'
import { parseDraftEdits, type DraftEdits } from '@/lib/email/draft-edits'
import { jsonbNeedle } from '@/lib/supabase/jsonb-needle'
import { isPre343Error } from '@/lib/email/hold'

/** `email_draft` statuses that still wait on the person (the thread view's set). */
export const REVISABLE_DRAFT_STATUSES: readonly string[] = ['pending_review', 'approved', 'edited']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ReviseDraftInput extends DraftRevision {
  /** An email_draft row id, or a provider draft message id. */
  draftId: string
}

export type ReviseDraftResult =
  | {
      success: true
      /** The email_draft row revised, when there is one. */
      draft_row_id: string | null
      /** The mailbox draft's message id now (a new one at Gmail), when it was written. */
      draft_id: string | null
      /** False when the row had no mailbox copy to write (revised in Dial8 only). */
      mailbox_updated: boolean
      subject: string
      to: string[]
      cc: string[]
      message: string
    }
  | { success: false; code: 'NOT_FOUND' | 'NOT_REVISABLE' | 'INVALID' | 'MAILBOX_CHANGED' | 'FAILED'; error: string }

interface DraftRow {
  id: string
  status: string | null
  subject: string | null
  to_emails: string[] | null
  cc_emails: string[] | null
  provider_thread_id: string | null
  provider_draft_id: string | null
}

const DRAFT_ROW_SELECT = 'id, status, subject, to_emails, cc_emails, provider_thread_id, provider_draft_id'

const NOT_SENT = 'Not sent: it waits in Drafts for the person to review and send.'

/**
 * Revise the caller's draft `input.draftId` in workspace `workspaceId`. Reads
 * on `supabase` with explicit owner fences (it may be a service-role client).
 * Never throws: a failure is a `success: false` the model can read.
 */
export async function reviseEmailDraft(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  input: ReviseDraftInput,
): Promise<ReviseDraftResult> {
  try {
    const { draftId, ...revision } = input
    if (typeof draftId !== 'string' || !(UUID.test(draftId) || isProviderId(draftId))) {
      return { success: false, code: 'NOT_FOUND', error: 'No draft with that id.' }
    }

    // The drafting pass's row, by its own id, or by the mailbox draft it names.
    let row: DraftRow | null = null
    if (UUID.test(draftId)) row = await readDraftRow(supabase, userId, workspaceId, 'id', draftId)
    if (!row && isProviderId(draftId)) row = await readDraftRow(supabase, userId, workspaceId, 'provider_draft_id', draftId)
    if (row && !REVISABLE_DRAFT_STATUSES.includes(row.status ?? '')) {
      return { success: false, code: 'NOT_REVISABLE', error: `This draft is already ${row.status ?? 'settled'}; it can't be revised.` }
    }

    // The mailbox draft and its thread: the row's, else the caller's own thread index's.
    const messageId = row ? row.provider_draft_id : isProviderId(draftId) ? draftId : null
    const threadId = row
      ? row.provider_thread_id
      : messageId
        ? await indexedDraftThread(supabase, userId, workspaceId, messageId)
        : null
    if (!row && !threadId) return { success: false, code: 'NOT_FOUND', error: 'No draft of yours with that id in this workspace.' }

    // A pass's row whose mailbox copy was never saved: Dial8 only.
    if (row && (!messageId || !threadId)) {
      const edits = parseDraftEdits({
        to: revision.to ?? row.to_emails ?? [],
        cc: revision.cc ?? row.cc_emails ?? [],
        subject: revision.subject ?? row.subject ?? '',
        body: revision.body,
      })
      if (!edits || edits === 'invalid') return invalid()
      await writeRow(supabase, userId, row.id, edits, null)
      return ok(row.id, null, false, edits, `Revised in Dial8 (this draft has no copy in the mailbox). ${NOT_SENT}`)
    }

    const updated = await updateProviderDraft(userId, workspaceId, threadId!, messageId!, revision)
    if (!updated.ok) {
      if (updated.reason === 'rich') {
        return {
          success: false,
          code: 'NOT_REVISABLE',
          error:
            'This draft has attachments, images or formatting from the mailbox (a signature, the quoted thread) that a plain-text revision would drop; nothing was changed. Suggest the person edits it in their mailbox.',
        }
      }
      return updated.reason === 'invalid'
        ? invalid()
        : {
            success: false,
            code: 'MAILBOX_CHANGED',
            error: 'The draft in the mailbox was edited, sent or discarded since; nothing was changed. Read it again first.',
          }
    }
    if (row) await writeRow(supabase, userId, row.id, updated.edits, updated.messageId)
    // Gmail gives a revised draft a NEW message id: every work item (and its
    // run) that delivered the old one follows, so its output still finds the
    // draft and sending it still settles the item.
    if (updated.messageId !== messageId) {
      await repointDeliverables(supabase, userId, workspaceId, messageId!, updated.messageId)
    }
    return ok(row?.id ?? null, updated.messageId, true, updated.edits, `Revised in Dial8 and in the mailbox (the body is plain text now). ${NOT_SENT}`)
  } catch (err) {
    console.warn('[revise-draft] failed:', err instanceof Error ? err.message : err)
    return { success: false, code: 'FAILED', error: 'The draft could not be revised just now.' }
  }
}

function ok(rowId: string | null, messageId: string | null, mailbox: boolean, edits: DraftEdits, message: string): ReviseDraftResult {
  return {
    success: true,
    draft_row_id: rowId,
    draft_id: messageId,
    mailbox_updated: mailbox,
    subject: edits.subject,
    to: edits.to,
    cc: edits.cc,
    message,
  }
}

function invalid(): ReviseDraftResult {
  return {
    success: false,
    code: 'INVALID',
    error: 'That is not a well-formed draft: it needs at least one recipient, bare email addresses, and a subject and body within their limits.',
  }
}

async function readDraftRow(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  column: 'id' | 'provider_draft_id',
  value: string,
): Promise<DraftRow | null> {
  const { data, error } = await supabase
    .from('email_draft')
    .select(DRAFT_ROW_SELECT)
    .eq(column, value)
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .limit(1)
    .maybeSingle<DraftRow>()
  if (error) throw new Error(error.message)
  return data ?? null
}

/** The thread the caller's own index lists draft `messageId` on, in this workspace; null when none. */
async function indexedDraftThread(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  messageId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('email_thread_index')
    .select('provider_thread_id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('provider_message_id', messageId)
    .eq('is_draft', true)
    .limit(1)
    .maybeSingle<{ provider_thread_id: string | null }>()
  if (error) throw new Error(error.message)
  return data?.provider_thread_id ?? null
}

/** The row follows the revision (owner-fenced); `messageId` re-points it at Gmail's new message. */
async function writeRow(
  supabase: SupabaseClient,
  userId: string,
  rowId: string,
  edits: DraftEdits,
  messageId: string | null,
): Promise<void> {
  const patch = {
    body_text: edits.body,
    body_html: plainTextToHtml(edits.body),
    subject: edits.subject,
    to_emails: edits.to,
    cc_emails: edits.cc,
    ...(messageId ? { provider_draft_id: messageId } : {}),
    // A revision the person asked for is their edit: a new message on a held
    // thread keeps it (marks it stale) instead of re-drafting over it, and a
    // fresh revision is no longer stale (src/lib/email/hold.ts).
    status: 'edited',
    stale: false,
    updated_at: new Date().toISOString(),
  }
  const write = (values: Record<string, unknown>) => supabase.from('email_draft').update(values).eq('id', rowId).eq('user_id', userId)
  let { error } = await write(patch)
  if (error && isPre343Error(error)) {
    // Before 343 there is no stale column: the rest of the revision stands.
    const { stale: _stale, ...rest } = patch
    ;({ error } = await write(rest))
  }
  if (error) throw new Error(error.message)
}

/** At most this many work items / runs are re-pointed per revision (a draft rarely belongs to more than one). */
const REPOINT_BATCH = 50

interface DeliverableRef {
  type?: unknown
  id?: unknown
  [key: string]: unknown
}

/** `list` with every `{type:'email_draft', id: fromId}` naming `toId` instead (its other fields kept); null when none did. */
function repointed(list: unknown, fromId: string, toId: string): DeliverableRef[] | null {
  if (!Array.isArray(list)) return null
  let changed = false
  const next = (list as DeliverableRef[]).map((d) => {
    if (d && d.type === 'email_draft' && d.id === fromId) {
      changed = true
      return { ...d, id: toId }
    }
    return d
  })
  return changed ? next : null
}

/**
 * Re-point the caller's own work items (tracked_job, fenced on the caller's
 * member in this workspace) and their runs (agent_run: the items' own runs,
 * plus runs the caller started here) from draft message `fromId` to `toId`.
 * Best-effort: the mailbox draft is already revised, so a failure here is
 * logged, never a failed revision.
 */
async function repointDeliverables(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  fromId: string,
  toId: string,
): Promise<void> {
  const needle = jsonbNeedle([{ type: 'email_draft', id: fromId }])
  try {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle<{ id: string }>()
    const runIds = new Set<string>()
    if (member?.id) {
      const { data: items, error } = await supabase
        .from('tracked_job')
        .select('id, deliverables, agent_run_id')
        .eq('workspace_id', workspaceId)
        .eq('member_id', member.id)
        .contains('deliverables', needle)
        .limit(REPOINT_BATCH)
      if (error) throw new Error(error.message)
      for (const item of (items ?? []) as Array<{ id: string; deliverables: unknown; agent_run_id: string | null }>) {
        if (item.agent_run_id) runIds.add(item.agent_run_id)
        const next = repointed(item.deliverables, fromId, toId)
        if (!next) continue
        const { error: writeError } = await supabase
          .from('tracked_job')
          .update({ deliverables: next })
          .eq('id', item.id)
          .eq('workspace_id', workspaceId)
          .eq('member_id', member.id)
        if (writeError) throw new Error(writeError.message)
      }
    }

    const runs: Array<{ id: string; deliverables: unknown }> = []
    const seen = new Set<string>()
    const collect = (rows: unknown) => {
      for (const r of (rows ?? []) as Array<{ id: string; deliverables: unknown }>) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        runs.push(r)
      }
    }
    if (runIds.size > 0) {
      const { data, error } = await supabase
        .from('agent_run')
        .select('id, deliverables')
        .eq('workspace_id', workspaceId)
        .in('id', [...runIds])
        .contains('deliverables', needle)
        .limit(REPOINT_BATCH)
      if (error) throw new Error(error.message)
      collect(data)
    }
    const { data: own, error: ownError } = await supabase
      .from('agent_run')
      .select('id, deliverables')
      .eq('workspace_id', workspaceId)
      .eq('triggered_by', userId)
      .contains('deliverables', needle)
      .limit(REPOINT_BATCH)
    if (ownError) throw new Error(ownError.message)
    collect(own)
    for (const run of runs) {
      const next = repointed(run.deliverables, fromId, toId)
      if (!next) continue
      const { error } = await supabase
        .from('agent_run')
        .update({ deliverables: next })
        .eq('id', run.id)
        .eq('workspace_id', workspaceId)
      if (error) throw new Error(error.message)
    }
  } catch (err) {
    console.warn('[revise-draft] draft revised, but re-pointing its work items failed:', err instanceof Error ? err.message : err)
  }
}
