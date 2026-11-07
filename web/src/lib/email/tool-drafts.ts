import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { readEmailThread } from './email-read-service'
import { draftRowsFor, holdThread, releaseDraftRows } from './hold'
import { plainTextToHtml } from './plain-text-to-html'
import { recordEmailEvent } from '@/lib/agent-events/email'
import { supersedeOtherDrafts } from './one-draft'

/**
 * A draft the agent's `create_email_draft` wrote (chat, a helper, a work run)
 * joins the review pile exactly as an arrival draft does (the holding pattern,
 * src/lib/email/hold.ts):
 *   - an `email_draft` row for it (pending review, naming the mailbox draft by
 *     `provider_draft_id`), so Mail's "To review", the review card, the shared
 *     daily cap and the open-draft check all see it;
 *   - for a reply, a hold of the thread, read live from the thread's own
 *     mailbox (the index row the new draft landed on names it): the person
 *     sees the chain they are answering until they send or dismiss it;
 *   - a brand-new message (no thread) quotes no received mail: the row only.
 * A revision (`previousDraftId`) releases the old draft's row first, and a
 * reply the person asked for replaces any other untouched draft on its
 * thread (one live draft per thread, GEN-1164: src/lib/email/one-draft.ts;
 * an automatic one is refused while another waits). An automatic draft (nobody asked in a chat) also lands an `email.drafted`
 * event, so the cap still counts it after it is sent and deleted. Never
 * throws: the mailbox draft already exists; a lost row is a gap in review,
 * never a failed draft.
 */
export async function recordToolDraft(
  args: {
    userId: string
    workspaceId: string
    providerDraftId: string
    /** The thread the draft replies in (the provider's), or null for a new message. */
    threadId: string | null
    subject: string
    to: string[]
    cc?: string[]
    body: string
    previousDraftId?: string | null
    automatic?: boolean
  },
  supabase: SupabaseClient = getServiceClient(),
): Promise<{ draftRowId: string | null; held: boolean }> {
  try {
    if (args.previousDraftId) {
      const previous = await draftRowsFor(supabase, args.userId, { providerDraftId: args.previousDraftId })
      await releaseDraftRows(supabase, args.userId, previous)
    }

    // The index row the draft landed on (createEmailDraft indexes it): its account and provider.
    let indexRow: { id: string; account_id: string | null; provider: 'google' | 'microsoft'; trust: string | null } | null = null
    if (args.threadId) {
      const { data } = await supabase
        .from('email_thread_index')
        .select('id, account_id, provider, trust')
        .eq('user_id', args.userId)
        .eq('workspace_id', args.workspaceId)
        .eq('provider_thread_id', args.threadId)
        .limit(1)
        .maybeSingle()
      if (data && (data.provider === 'google' || data.provider === 'microsoft')) {
        indexRow = {
          id: data.id as string,
          account_id: (data.account_id as string | null) ?? null,
          provider: data.provider,
          trust: (data.trust as string | null) ?? null,
        }
      }
    }

    let holdId: string | null = null
    if (args.threadId && indexRow) {
      const thread = await readEmailThread(args.userId, args.threadId, args.workspaceId, {
        accountId: indexRow.account_id,
        provider: indexRow.provider,
      })
      if (thread) {
        holdId = await holdThread(supabase, {
          userId: args.userId,
          workspaceId: args.workspaceId,
          accountId: indexRow.account_id,
          provider: indexRow.provider,
          providerThreadId: args.threadId,
          thread,
          trust: indexRow.trust === 'injection' ? 'injection' : null,
        })
      }
    }

    const { data: row, error } = await supabase
      .from('email_draft')
      .insert({
        workspace_id: args.workspaceId,
        user_id: args.userId,
        email_thread_id: indexRow?.id ?? null,
        provider_thread_id: args.threadId,
        provider: indexRow?.provider ?? null,
        ...(indexRow?.account_id ? { account_id: indexRow.account_id } : {}),
        ...(holdId ? { hold_id: holdId } : {}),
        subject: args.subject,
        to_emails: args.to,
        cc_emails: args.cc ?? [],
        body_text: args.body,
        body_html: plainTextToHtml(args.body),
        provider_draft_id: args.providerDraftId,
        is_reply: !!args.threadId,
        // A draft the person asked for in a chat never uses the automatic cap.
        metadata: { origin: args.automatic ? 'automatic' : 'chat' },
        status: 'pending_review',
      })
      .select('id, created_at')
      .single()
    if (error || !row) {
      console.warn('[tool-drafts] draft row not written:', error?.message ?? 'no row')
      return { draftRowId: null, held: !!holdId }
    }
    if (args.threadId && !args.automatic) await supersedeOtherDrafts(supabase, { userId: args.userId, providerThreadId: args.threadId, keepId: String(row.id) })

    if (args.automatic) {
      await recordEmailEvent(
        {
          workspaceId: args.workspaceId,
          userId: args.userId,
          drafted: [{ draftId: String(row.id), at: (row.created_at as string | null) ?? null }],
        },
        supabase,
      )
    }
    return { draftRowId: String(row.id), held: !!holdId }
  } catch (err) {
    console.warn('[tool-drafts] draft not recorded for review:', err instanceof Error ? err.message : err)
    return { draftRowId: null, held: false }
  }
}
