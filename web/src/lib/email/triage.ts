import type { SupabaseClient } from '@supabase/supabase-js'
import { deleteThreadCopies, indexGmailThread, indexOutlookThread, type ThreadIndexOutcome, type ThreadIndexTarget } from '@/lib/crm/email-sync'
import { ownMailAddresses } from './own-addresses'
import { rearchiveMutedArrivals, type MutedArrivalsInput } from './thread-triage'

/**
 * Triage on arrival: when a push brings new mail, index each thread it touched
 * from the provider's metadata (ids, flags and addresses; no message is stored:
 * no stored mail, 2026-10-15), then say which threads now want a drafted reply
 * and which held threads (src/lib/email/hold.ts) got a new message, so the
 * draft is waiting in the inbox minutes after the mail lands instead of after
 * the next daily pass (cron/email-management).
 *
 * This is the ONE writer of a pushed thread's index row: each touched thread is
 * read once, as metadata. The drafting step reads the bodies it needs live, in
 * memory only. Only a new newest message is triaged: a read, star or archive
 * leaves the thread's newest message as it was, and so leaves its tags alone (a
 * "no reply needed" decision made for a message, email-reply-gate.ts, stands
 * until another message arrives). A muted thread's new message (migration
 * 441, ./thread-triage.ts) is archived again and goes to neither drafting nor
 * the agent.
 */

/** The categories the automatic draft pass replies to (generateEmailDrafts selects the same). */
const DRAFTABLE_CATEGORIES = new Set(['personal', 'important'])

type TriagedRow = { provider_thread_id: string; needs_reply: boolean | null; auto_classified: string | null; is_draft: boolean | null; from_email?: string | null }

/** A thread the agent's understanding pass (E2) takes: not a newsletter (decision 2), a draft, or the person's own message. Pure. */
function isUnderstandable(row: TriagedRow, own: ReadonlySet<string>): boolean {
  return !row.is_draft && row.auto_classified !== 'newsletter' && !own.has((row.from_email ?? '').trim().toLowerCase())
}

/**
 * Of the threads the reply gate turned away on arrival (GEN-1164), the ones
 * the understanding pass takes, by the same rule as triage's, against every
 * address the person sends from. Never throws: a failed read hands over none.
 */
export async function understandableThreads(
  supabase: SupabaseClient,
  input: { userId: string; workspaceId: string; threadIds: readonly string[]; mailboxEmail: string | null },
): Promise<string[]> {
  if (!input.threadIds.length) return []
  try {
    const own = await ownMailAddresses(supabase, input.userId)
    const mailbox = input.mailboxEmail?.trim().toLowerCase()
    if (mailbox) own.add(mailbox)
    const { data, error } = await supabase
      .from('email_thread_index')
      .select('provider_thread_id, needs_reply, auto_classified, is_draft, from_email')
      .eq('user_id', input.userId)
      .eq('workspace_id', input.workspaceId)
      .in('provider_thread_id', [...input.threadIds])
    if (error) throw new Error(error.message)
    return [...new Set(((data ?? []) as TriagedRow[]).filter((row) => isUnderstandable(row, own)).map((row) => row.provider_thread_id))]
  } catch (err) {
    console.warn('[email-triage] turned-away threads not handed over:', err instanceof Error ? err.message : err)
    return []
  }
}

/** Most threads one triage call indexes; the push runs one call per this many (email-functions.ts). */
export const MAX_ARRIVAL_THREADS = 100

export interface MailboxRef {
  userId: string
  provider: 'google' | 'microsoft'
  /** The connected account; null for a legacy user+provider mailbox. */
  accountId: string | null
}

/** Each thread's newest message id as the index holds it now (copies in every workspace agree). */
export async function readThreadRevisions(
  supabase: SupabaseClient,
  ref: MailboxRef,
  threadIds: string[],
): Promise<Record<string, string | null>> {
  if (!threadIds.length) return {}
  let query = supabase
    .from('email_thread_index')
    .select('provider_thread_id, provider_message_id')
    .eq('user_id', ref.userId)
    .eq('provider', ref.provider)
    .in('provider_thread_id', threadIds)
  query = ref.accountId ? query.eq('account_id', ref.accountId) : query.is('account_id', null)
  const { data, error } = await query
  if (error) throw new Error(`Failed to read thread revisions: ${error.message}`)
  const revisions: Record<string, string | null> = {}
  for (const row of (data ?? []) as Array<{ provider_thread_id: string; provider_message_id: string | null }>) {
    revisions[row.provider_thread_id] = row.provider_message_id ?? null
  }
  return revisions
}

export interface TriageInput extends MailboxRef {
  /** The workspace whose copy the drafts belong to (the account's own). */
  workspaceId: string
  threadIds: string[]
  accessToken: string
  /** The mailbox's own address: a thread whose newest message is from it needs no reply. */
  mailboxEmail: string | null
}

export interface ArrivalTriage {
  /** Threads that now want a drafted reply (none of them held). */
  draftable: string[]
  /**
   * Threads with a new newest message that the agent should understand
   * (docs/plans/email-through-the-agent.md E2): not drafted, not held, not a
   * newsletter (decision 2), not a draft, and not the person's own message.
   */
  understandable?: string[]
  /** Held threads whose newest message changed, or that are gone: their hold is refreshed or released. */
  held: string[]
  /** Threads indexed (or found gone) this push. */
  indexed: number
}

export interface TriageDeps {
  indexThread?: (supabase: SupabaseClient, target: ThreadIndexTarget) => Promise<ThreadIndexOutcome>
  rearchiveMuted?: (supabase: SupabaseClient, input: MutedArrivalsInput) => Promise<Set<string>>
}

/**
 * Index the threads a push touched, then sort the ones whose newest message
 * changed: held ones to the hold refresh, the rest that need a reply (personal
 * or important, not a draft) to drafting in `input.workspaceId`. A thread the
 * provider holds nothing of any more loses its index rows (and its hold is
 * released by the refresh). A thread that can't be read is left as it was.
 */
export async function triageArrivals(supabase: SupabaseClient, input: TriageInput, deps: TriageDeps = {}): Promise<ArrivalTriage> {
  const threadIds = [...new Set(input.threadIds)].slice(0, MAX_ARRIVAL_THREADS)
  if (!threadIds.length) return { draftable: [], understandable: [], held: [], indexed: 0 }
  const before = await readThreadRevisions(supabase, input, threadIds)

  const indexThread = deps.indexThread ?? (input.provider === 'google' ? indexGmailThread : indexOutlookThread)
  const gone: string[] = []
  let indexed = 0
  for (const threadId of threadIds) {
    try {
      const outcome = await indexThread(supabase, {
        accessToken: input.accessToken,
        userEmail: input.mailboxEmail,
        userId: input.userId,
        workspaceId: input.workspaceId,
        threadId,
        accountId: input.accountId,
      })
      if (outcome === 'gone') {
        gone.push(threadId)
        await deleteThreadCopies(supabase, { userId: input.userId, accountId: input.accountId, provider: input.provider, threadId })
      }
      if (outcome !== 'unreadable') indexed += 1
    } catch (err) {
      console.error(`[email-triage] thread ${threadId} could not be read:`, err instanceof Error ? err.message : err)
    }
  }

  const after = await readThreadRevisions(supabase, input, threadIds)
  const changed = threadIds.filter((id) => after[id] != null && after[id] !== before[id])
  const candidates = [...changed, ...gone]
  if (!candidates.length) return { draftable: [], understandable: [], held: [], indexed }

  // Held threads: the hold refresh owns them (re-draft, stale, or release).
  let heldQuery = supabase
    .from('email_hold')
    .select('provider_thread_id')
    .eq('user_id', input.userId)
    .in('provider_thread_id', candidates)
  heldQuery = input.accountId ? heldQuery.eq('account_id', input.accountId) : heldQuery.is('account_id', null)
  const { data: holds, error: holdError } = await heldQuery
  if (holdError) console.warn('[email-triage] holds not read:', holdError.message)
  const held = new Set(((holds ?? []) as Array<{ provider_thread_id: string }>).map((h) => h.provider_thread_id))

  // Muted threads: out of the inbox again, and nobody is told.
  const muted = await (deps.rearchiveMuted ?? rearchiveMutedArrivals)(supabase, {
    userId: input.userId,
    provider: input.provider,
    accountId: input.accountId,
    accessToken: input.accessToken,
    threadIds: changed,
  })
  const fresh = changed.filter((id) => !held.has(id) && !muted.has(id))
  let draftable: string[] = []
  let understandable: string[] = []
  if (fresh.length) {
    const { data, error } = await supabase
      .from('email_thread_index')
      .select('provider_thread_id, needs_reply, auto_classified, is_draft, from_email')
      .eq('user_id', input.userId)
      .eq('workspace_id', input.workspaceId)
      .in('provider_thread_id', fresh)
    if (error) throw new Error(`Failed to read triaged threads: ${error.message}`)
    const rows = (data ?? []) as TriagedRow[]
    const isDraftable = (row: TriagedRow) => row.needs_reply === true && !row.is_draft && DRAFTABLE_CATEGORIES.has(row.auto_classified ?? '')
    draftable = rows.filter(isDraftable).map((row) => row.provider_thread_id)
    const own = new Set(input.mailboxEmail?.trim() ? [input.mailboxEmail.trim().toLowerCase()] : [])
    understandable = rows.filter((row) => !isDraftable(row) && isUnderstandable(row, own)).map((row) => row.provider_thread_id)
  }
  return { draftable, understandable, held: candidates.filter((id) => held.has(id)), indexed }
}
