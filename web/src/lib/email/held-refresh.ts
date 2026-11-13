import type { SupabaseClient } from '@supabase/supabase-js'
import { generateEmailDrafts } from '@/lib/crm/email-drafts'
import { readEmailThread, type EmailThreadForAI } from './email-read-service'
import { findHold, heldThreadAction, holdThread, newestHeldMessageId, releaseHold, type EmailHoldRow } from './hold'
import { mailboxAddresses } from './reply-policy'
import { automatedThreadReason } from './automated-sender'
import { ownedMailbox } from './thread-mailbox'
import { deleteDraftInMailbox } from './provider-drafts'
import type { ArrivalDraft } from './arrival-drafts'
import { scheduledThreadKeys } from './scheduled-refs'

/**
 * A new message on a held thread (Liam, 2026-10-15: "re-draft if untouched,
 * mark stale if edited"). Triage (./triage.ts) hands over the held threads
 * whose newest message changed; for each, read live from its own mailbox:
 *   - gone (nothing left, and its index rows went with it): the hold goes;
 *   - the newest sent message is the person's own (answered elsewhere): the
 *     hold goes; their mailbox draft is left alone;
 *   - our draft is gone from the mailbox (discarded there): the hold goes;
 *   - our draft changed in the mailbox, or the person edited it here (status
 *     'edited'), or drafting is gated: the copy is refreshed and the draft is
 *     marked stale ("New reply since this draft"), their text kept;
 *   - untouched: the old draft steps aside, a new one is written through the
 *     same gated generateEmailDrafts (reply gate, email.trust, the daily cap);
 *     when one lands the old row and its mailbox draft go; when the cap stops
 *     it the old one comes back, stale; when the reply gate says no reply is
 *     needed any more the hold goes, with the untouched mailbox draft;
 *   - the new message is automated mail (an out-of-office, a list post, a
 *     no-reply notice: ./automated-sender.ts): no draft is written for it; the
 *     copy is refreshed and the draft stays as it was (it still answers the
 *     person who wrote before).
 *   - a send is scheduled on the thread (send later): left alone entirely; the
 *     person already said yes to their draft (./scheduled-refs.ts).
 * Never throws: a thread that fails is left for the next push.
 */

const OPEN_DRAFT_STATUSES = ['pending_review', 'approved', 'edited']

export interface HeldRefreshInput {
  userId: string
  workspaceId: string
  accountId: string | null
  provider: 'google' | 'microsoft'
  providerThreadIds: readonly string[]
  /** The mailbox's own address: a newest message from it means answered elsewhere. */
  mailboxEmail: string | null
  /** False when the gates (kill switch, dormancy, usage, cap) refuse drafting: stale instead of re-drafting. */
  mayDraft: boolean
  allowAnother?: () => Promise<boolean>
}

export interface HeldRefreshResult {
  redrafted: ArrivalDraft[]
  staled: number
  released: number
}

export interface HeldRefreshDeps {
  readThread?: typeof readEmailThread
  generate?: typeof generateEmailDrafts
  deleteMailboxDraft?: (hold: EmailHoldRow, draftMessageId: string) => Promise<boolean>
}

interface OpenDraft {
  id: string
  status: string | null
  stale: boolean | null
  provider_draft_id: string | null
}

async function openDraftOn(supabase: SupabaseClient, userId: string, holdId: string): Promise<OpenDraft | null> {
  const { data, error } = await supabase
    .from('email_draft')
    .select('id, status, stale, provider_draft_id')
    .eq('user_id', userId)
    .eq('hold_id', holdId)
    .in('status', OPEN_DRAFT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as OpenDraft[])[0] ?? null
}

/** Where our mailbox draft stands on the thread just read: there, changed (Gmail gives an edit a new id), or gone. */
export function mailboxDraftState(thread: Pick<EmailThreadForAI, 'messages'>, providerDraftId: string | null): 'there' | 'changed' | 'gone' | 'unknown' {
  if (!providerDraftId) return 'unknown'
  const drafts = thread.messages.filter((m) => m.isDraft).map((m) => m.messageId)
  if (drafts.includes(providerDraftId)) return 'there'
  return drafts.length ? 'changed' : 'gone'
}

async function defaultDeleteMailboxDraft(hold: EmailHoldRow, draftMessageId: string): Promise<boolean> {
  if (!hold.account_id) return false
  const mailbox = await ownedMailbox(hold.user_id, hold.account_id)
  return mailbox ? deleteDraftInMailbox(mailbox, draftMessageId) : false
}

export async function refreshHeldThreads(
  supabase: SupabaseClient,
  input: HeldRefreshInput,
  deps: HeldRefreshDeps = {},
): Promise<HeldRefreshResult> {
  const out: HeldRefreshResult = { redrafted: [], staled: 0, released: 0 }
  const readThread = deps.readThread ?? readEmailThread
  const generate = deps.generate ?? generateEmailDrafts
  const deleteMailboxDraft = deps.deleteMailboxDraft ?? defaultDeleteMailboxDraft
  const own = mailboxAddresses(input.mailboxEmail ?? '')[0] ?? null

  for (const threadId of new Set(input.providerThreadIds)) {
    try {
      const hold = await findHold(supabase, { userId: input.userId, accountId: input.accountId, providerThreadId: threadId })
      if (!hold || hold.status === 'sending') continue
      // A send scheduled here: its draft is the person's yes, never re-drafted or released (unreadable: throws, left alone).
      if ((await scheduledThreadKeys(supabase, [input.userId], [threadId])).size) continue

      const thread = await readThread(input.userId, threadId, hold.workspace_id, { accountId: hold.account_id, provider: hold.provider })
      if (!thread) {
        // Unreadable now, or gone: gone only when triage removed its index rows too.
        const { data } = await supabase
          .from('email_thread_index')
          .select('id')
          .eq('user_id', input.userId)
          .eq('provider_thread_id', threadId)
          .limit(1)
        if (!data?.length) {
          await releaseHold(supabase, input.userId, hold.id)
          out.released += 1
        }
        continue
      }

      const newest = newestHeldMessageId(thread)
      if (!newest || newest === hold.held_message_id) continue

      const latest = thread.messages.filter((m) => !m.isDraft).at(-1)
      if (own && latest && mailboxAddresses(latest.from)[0] === own) {
        await releaseHold(supabase, input.userId, hold.id)
        out.released += 1
        continue
      }

      const draft = await openDraftOn(supabase, input.userId, hold.id)
      const inMailbox = mailboxDraftState(thread, draft?.provider_draft_id ?? null)
      if (!draft || inMailbox === 'gone') {
        await releaseHold(supabase, input.userId, hold.id)
        out.released += 1
        continue
      }

      const target = {
        userId: input.userId,
        workspaceId: hold.workspace_id,
        accountId: hold.account_id,
        provider: hold.provider,
        providerThreadId: threadId,
        thread,
        trust: hold.trust,
      }
      // Automated mail never gets a draft, and doesn't make the person's stale.
      if (automatedThreadReason(thread.messages, own)) {
        await holdThread(supabase, { ...target, mustExist: true })
        continue
      }

      let action = heldThreadAction(draft, hold.status)
      if (inMailbox === 'changed') action = 'stale'
      if (action === 'redraft' && !input.mayDraft) action = 'stale'

      if (action === 'stale') {
        // Only while the hold is still there and not mid-send (a send may have just begun).
        if (await holdThread(supabase, { ...target, mustExist: true })) {
          await supabase.from('email_draft').update({ stale: true, updated_at: new Date().toISOString() }).eq('id', draft.id).eq('user_id', input.userId)
          out.staled += 1
        }
        continue
      }
      if (action !== 'redraft') continue
      // Re-check just before stepping the draft aside: the person may have just sent it.
      const current = await findHold(supabase, { userId: input.userId, accountId: input.accountId, providerThreadId: threadId })
      if (!current || current.status === 'sending') continue

      // The untouched draft steps aside so the pass can write its successor.
      // updated_at fences the expiry's settled sweep off it while the pass runs.
      await supabase.from('email_draft').update({ status: 'dismissed', updated_at: new Date().toISOString() }).eq('id', draft.id).eq('user_id', input.userId)
      let result: Awaited<ReturnType<typeof generateEmailDrafts>> | null = null
      try {
        result = await generate(input.userId, hold.workspace_id, {
          thread_ids: [threadId],
          max_drafts: 1,
          // No tone: the draft writes the way the person does (what Native Intelligence learned).
          replyIntent: 'automatic',
          // One model call per re-draft: this loop runs over every held
          // thread inside one Inngest step, with no deadline of its own.
          review: false,
          holdMustExist: true,
          ...(input.allowAnother ? { allowAnother: input.allowAnother } : {}),
        })
      } catch (err) {
        console.warn('[email-hold] re-draft failed:', err instanceof Error ? err.message : err)
      }
      const fresh = result?.drafts?.[0]
      if (fresh) {
        await supabase.from('email_draft').delete().eq('id', draft.id).eq('user_id', input.userId)
        if (draft.provider_draft_id) await deleteMailboxDraft(hold, draft.provider_draft_id)
        out.redrafted.push({
          id: String(fresh.id),
          email_thread_id: typeof fresh.email_thread_id === 'string' ? fresh.email_thread_id : null,
          created_at: typeof fresh.created_at === 'string' ? fresh.created_at : null,
        })
      } else if (result?.skipped?.[threadId] === 'no_reply') {
        // The reply gate decided no reply is needed any more (definitive): the
        // hold goes, and with it our untouched draft, here and in the mailbox.
        if (draft.provider_draft_id) await deleteMailboxDraft(hold, draft.provider_draft_id)
        await releaseHold(supabase, input.userId, hold.id)
        out.released += 1
      } else {
        // Anything else is temporary (capped, a failure, an unreadable body,
        // unverified Reply-To, the index ahead of the provider, another open
        // draft, the hold gone mid-way): the person's draft comes back, stale,
        // beside the fresh copy, and the next message tries again.
        await holdThread(supabase, { ...target, mustExist: true })
        await supabase.from('email_draft').update({ status: 'pending_review', stale: true }).eq('id', draft.id).eq('user_id', input.userId)
        out.staled += 1
      }
    } catch (err) {
      console.warn('[email-hold] held thread not refreshed:', err instanceof Error ? err.message : err)
    }
  }
  return out
}
