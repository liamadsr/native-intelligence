/**
 * The send path's flywheel hook: an agent draft the person rewrote heavily
 * before sending becomes a `draft_rewrite` candidate (./types.ts
 * DraftRewriteEvidence). A score, word counts, the draft's origin and
 * pointers only: Native Intelligence stores no mail, so neither the draft nor the sent text
 * is kept, logged or passed on; a reviewer reads the thread live.
 *
 * Wired into sendProviderDraft (src/lib/integrations/email.ts) in two halves,
 * so it can never delay or fail a send:
 *   1. `readDraftForRewrite`, started (not awaited) alongside the provider
 *      send when the person sent with edits: the Native Intelligence draft row's text, read
 *      before the send settles the row away. It never rejects.
 *   2. `deferDraftRewrite`, after the send succeeded: `noteDraftRewrite` runs
 *      after the response (Next's `after`, so a serverless invocation stays
 *      open for it; detached outside a request). The sent text is the edits'
 *      body (what the send put into the message), the draft's is the row's
 *      `body_text`. It swallows every error.
 * A draft sent without edits went out as the mailbox holds it, unchanged by
 * Native Intelligence, so there is nothing to measure. A row the person saved edits into
 * (status 'edited', PATCH /api/account/email/drafts/[id]) is measured from
 * those edits: the score can only come out higher, never a false candidate.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { after } from 'next/server'
import { recordEvalCandidate } from './record'
import { measureRewrite } from './similarity'
import { evalCandidateKey, type DraftRewriteEvidence } from './types'

/** The draft as the measure needs it. `bodyText` stays in memory, never stored. */
export interface DraftForRewrite {
  id: string
  workspaceId: string
  bodyText: string
  origin: DraftRewriteEvidence['origin']
  accountId: string | null
  emailThreadId: string | null
}

/** email_draft.metadata.origin as the evidence names it: a drafting pass's draft (automatic or on an explicit ask) or a chat's. */
export function draftOrigin(metadata: unknown): DraftRewriteEvidence['origin'] {
  const origin = metadata && typeof metadata === 'object' ? (metadata as { origin?: unknown }).origin : undefined
  if (origin === 'automatic' || origin === 'explicit') return 'automatic'
  if (origin === 'chat') return 'chat'
  return 'unknown'
}

/**
 * Read the Native Intelligence draft row behind a send: the row whose provider draft id is
 * exactly the sent message's. The send also finds the thread's other rows
 * (draftRowsFor matches the thread too), and measuring against one of those
 * would score the person's text against a different draft, so no exact match
 * means nothing to measure. Null then, when there is no such row (a draft
 * written in the mailbox), it has no text, or the read failed. Never rejects,
 * so a caller can start it and never await it.
 */
export async function readDraftForRewrite(
  supabase: SupabaseClient,
  userId: string,
  rows: ReadonlyArray<{ id: string; provider_draft_id: string | null }>,
  draftMessageId: string,
): Promise<DraftForRewrite | null> {
  try {
    const row = draftMessageId ? rows.find((r) => r.provider_draft_id === draftMessageId) : undefined
    if (!row) return null
    const { data, error } = await supabase
      .from('email_draft')
      .select('id, workspace_id, body_text, metadata, account_id, email_thread_id')
      .eq('id', row.id)
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    const d = data as Record<string, unknown>
    if (typeof d.body_text !== 'string' || !d.body_text.trim() || typeof d.workspace_id !== 'string') return null
    return {
      id: String(d.id),
      workspaceId: d.workspace_id,
      bodyText: d.body_text,
      origin: draftOrigin(d.metadata),
      accountId: typeof d.account_id === 'string' ? d.account_id : null,
      emailThreadId: typeof d.email_thread_id === 'string' ? d.email_thread_id : null,
    }
  } catch {
    return null
  }
}

/** The thread's linked contact, when the index row has one. Null otherwise. */
async function linkedContactId(supabase: SupabaseClient, emailThreadId: string | null): Promise<string | null> {
  if (!emailThreadId) return null
  const { data } = await supabase.from('email_thread_index').select('linked_contact_id').eq('id', emailThreadId).maybeSingle()
  const id = (data as { linked_contact_id?: unknown } | null)?.linked_contact_id
  return typeof id === 'string' && id ? id : null
}

/**
 * After a send: measure the sent text against the draft and record a heavy
 * rewrite. Fire and forget: resolves to what happened ('none' when there was
 * nothing to record), never rejects, never logs text.
 */
export async function noteDraftRewrite(
  supabase: SupabaseClient,
  args: { userId: string; providerThreadId: string; draft: Promise<DraftForRewrite | null> | DraftForRewrite | null; sentBody: string },
): Promise<'recorded' | 'none' | 'failed'> {
  try {
    const draft = await args.draft
    if (!draft) return 'none'
    const measure = measureRewrite(draft.bodyText, args.sentBody)
    if (!measure.heavy) return 'none'
    const contactId = await linkedContactId(supabase, draft.emailThreadId).catch(() => null)
    const evidence: DraftRewriteEvidence = {
      kind: 'draft_rewrite',
      similarity: measure.similarity,
      wordsBefore: measure.wordsBefore,
      wordsAfter: measure.wordsAfter,
      origin: draft.origin,
      providerThreadId: args.providerThreadId,
      ...(draft.accountId ? { accountId: draft.accountId } : {}),
      ...(contactId ? { contactId } : {}),
      at: new Date().toISOString(),
    }
    const outcome = await recordEvalCandidate(supabase, {
      workspaceId: draft.workspaceId,
      userId: args.userId,
      source: 'draft_rewrite',
      dedupeKey: evalCandidateKey.draft(draft.id),
      evidence,
      refType: 'email_draft',
      refId: draft.id,
      onExisting: 'skip',
    })
    return outcome === 'failed' ? 'failed' : 'recorded'
  } catch (err) {
    console.error('[eval-flywheel] draft rewrite check failed:', err instanceof Error ? err.message : 'unknown error')
    return 'failed'
  }
}

/**
 * Run noteDraftRewrite after the response, off the send's path. Never throws:
 * outside a request scope (a script, a test) it runs detached.
 */
export function deferDraftRewrite(supabase: SupabaseClient, args: Parameters<typeof noteDraftRewrite>[1]): void {
  const run = async () => {
    await noteDraftRewrite(supabase, args)
  }
  try {
    after(run)
  } catch {
    void run()
  }
}
