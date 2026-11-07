import type { SupabaseClient } from '@supabase/supabase-js'
import { ownedMailbox } from './thread-mailbox'
import { deleteDraftInMailbox } from './provider-drafts'
import { releaseHold } from './hold'

/**
 * One live draft per thread (Liam, 2026-10-27, GEN-1164: Guidepoint's thread
 * had one draft declining and one accepting; seven more threads had two). A
 * new draft someone asked for (Mail's Generate again, the agent in a chat)
 * replaces the thread's older untouched ones ('pending_review'): their rows
 * go, and so do their drafts in the mailbox, by the id Dial8 saved (an edit
 * made in Gmail has a new id and stays). A draft the person edited
 * ('edited') or saved to their mailbox ('approved') is theirs and stays. A
 * hold no draft rests on any more goes too (the received mail it keeps is
 * only for a draft). Automatic passes never get here: they skip a thread
 * with any open draft (generateEmailDrafts, automaticDraftRefusal). Never
 * throws.
 */

export interface SupersedeDeps {
  deleteMailboxDraft?: (userId: string, accountId: string, providerDraftId: string) => Promise<boolean>
}

async function defaultDeleteMailboxDraft(userId: string, accountId: string, providerDraftId: string): Promise<boolean> {
  const mailbox = await ownedMailbox(userId, accountId)
  return mailbox ? deleteDraftInMailbox(mailbox, providerDraftId) : false
}

/** Removes the thread's other open, untouched drafts. Returns how many rows went. */
export async function supersedeOtherDrafts(
  supabase: SupabaseClient,
  args: { userId: string; providerThreadId: string | null | undefined; keepId: string },
  deps: SupersedeDeps = {},
): Promise<number> {
  if (!args.providerThreadId) return 0
  const deleteMailboxDraft = deps.deleteMailboxDraft ?? defaultDeleteMailboxDraft
  try {
    const { data, error } = await supabase
      .from('email_draft')
      .select('id, account_id, provider_draft_id, hold_id')
      .eq('user_id', args.userId)
      .eq('provider_thread_id', args.providerThreadId)
      .eq('status', 'pending_review')
      .neq('id', args.keepId)
      .limit(20)
    if (error) return 0
    const older = (data ?? []) as Array<{ id: string; account_id: string | null; provider_draft_id: string | null; hold_id: string | null }>
    if (!older.length) return 0
    // Still untouched at the delete: one edited since the read stays.
    const { data: deleted, error: deleteError } = await supabase.from('email_draft').delete()
      .eq('user_id', args.userId).eq('status', 'pending_review').in('id', older.map((d) => d.id)).select('id')
    if (deleteError) return 0
    const goneIds = new Set(((deleted ?? []) as Array<{ id: string }>).map((d) => d.id))
    const gone = older.filter((d) => goneIds.has(d.id))
    for (const draft of gone) {
      if (draft.account_id && draft.provider_draft_id) {
        await deleteMailboxDraft(args.userId, draft.account_id, draft.provider_draft_id).catch(() => false)
      }
    }
    for (const holdId of new Set(gone.map((d) => d.hold_id).filter((id): id is string => !!id))) {
      const { data: rest, error: restError } = await supabase.from('email_draft').select('id').eq('user_id', args.userId).eq('hold_id', holdId).limit(1)
      if (!restError && rest && !rest.length) await releaseHold(supabase, args.userId, holdId)
    }
    return gone.length
  } catch (err) {
    console.warn('[email-drafts] older drafts not replaced:', err instanceof Error ? err.message : err)
    return 0
  }
}
