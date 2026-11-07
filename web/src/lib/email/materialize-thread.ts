import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { indexGmailThread, indexOutlookThread, type ThreadIndexOutcome } from '@/lib/crm/email-sync'
import { readableWorkspaceEmailAccounts } from './account-scope'
import { ownedMailbox, type LiveMailbox } from './thread-mailbox'

/**
 * A search result the index doesn't have (older than the index's 30 days, or
 * not indexed yet), indexed on demand when it is opened or acted on, so every
 * thread route (star, archive, trash, labels, mark read, reply, draft) works
 * on it unchanged. It goes through the sync's own writer (indexGmailThread /
 * indexOutlookThread): ids, flags and sender/participant addresses only,
 * never a subject, preview or body (no stored mail), and one copy per
 * workspace the mailbox is linked to, as the sync writes them.
 *
 * Only a mailbox this workspace may read (readableWorkspaceEmailAccounts) is
 * used; a thread already indexed here answers with its row and writes nothing.
 */

export type MaterializeResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; reason: 'not_readable' | 'no_mailbox' | 'gone' | 'unreadable' }

export interface MaterializeDeps {
  admin?: SupabaseClient
  readable?: typeof readableWorkspaceEmailAccounts
  mailbox?: (userId: string, accountId: string) => Promise<LiveMailbox | null>
  indexGmail?: typeof indexGmailThread
  indexOutlook?: typeof indexOutlookThread
}

async function indexRowId(admin: SupabaseClient, ref: { userId: string; workspaceId: string; accountId: string; threadId: string }): Promise<string | null> {
  const { data } = await admin
    .from('email_thread_index')
    .select('id')
    .eq('user_id', ref.userId)
    .eq('workspace_id', ref.workspaceId)
    .eq('account_id', ref.accountId)
    .eq('provider_thread_id', ref.threadId)
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

export async function materializeSearchHit(
  ref: { userId: string; workspaceId: string; accountId: string; threadId: string },
  deps: MaterializeDeps = {},
): Promise<MaterializeResult> {
  const admin = deps.admin ?? getServiceClient()
  const readable = await (deps.readable ?? readableWorkspaceEmailAccounts)(ref.userId, ref.workspaceId, admin)
  if (!readable.some((a) => a.id === ref.accountId)) return { ok: false, reason: 'not_readable' }

  const existing = await indexRowId(admin, ref)
  if (existing) return { ok: true, id: existing, created: false }

  const mailbox = await (deps.mailbox ?? ownedMailbox)(ref.userId, ref.accountId)
  if (!mailbox) return { ok: false, reason: 'no_mailbox' }
  const target = {
    accessToken: mailbox.token,
    userEmail: mailbox.email,
    userId: ref.userId,
    workspaceId: ref.workspaceId,
    threadId: ref.threadId,
    accountId: ref.accountId,
  }
  let outcome: ThreadIndexOutcome
  try {
    outcome = mailbox.provider === 'google'
      ? await (deps.indexGmail ?? indexGmailThread)(admin, target, { logWriteErrors: true })
      : await (deps.indexOutlook ?? indexOutlookThread)(admin, target, { logWriteErrors: true })
  } catch (err) {
    console.warn('[email-materialize] thread not indexed:', err instanceof Error ? err.message : 'unknown error')
    return { ok: false, reason: 'unreadable' }
  }
  if (outcome !== 'indexed') return { ok: false, reason: outcome }
  const id = await indexRowId(admin, ref)
  return id ? { ok: true, id, created: true } : { ok: false, reason: 'unreadable' }
}
