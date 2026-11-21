/**
 * Sharing an email thread with a PERSON by an @-mention (migration 673,
 * decision 1 in docs/plans/mentions-everywhere.md): the server half.
 *
 * It is the SAME live share 646 built, widened from a team-chat channel to a
 * workspace member. Native Intelligence stores NOTHING of the mail: a share
 * (email_thread_share) holds ids only, and the thread is read live from the
 * OWNER's mailbox with the OWNER's token on each open, limited to the message
 * ids frozen at share time.
 *
 * Who may do what, checked here on every call (never trusted from the caller):
 *   share   the mail's OWNER only. The thread's index row must be theirs, in
 *           this workspace; each grantee must be a member of the SAME workspace
 *           and not the owner. The thread's current message ids are frozen.
 *   read    a non-revoked share whose grantee_member_id is the caller's member
 *           row in the share's workspace (or the caller is the owner). Then the
 *           frozen messages are read live from the owner's mailbox; a
 *           disconnected mailbox or a gone thread reads as "not available",
 *           never a partial leak.
 *   revoke  the owner's alone; access ends at once.
 * Anyone else gets "not found": a share is never confirmed to someone who may
 * not read it.
 *
 * FAIL-SOFT: sharing returns what it shared and never throws (a share is never
 * worth failing the comment that rode it). Reading throws nothing of the mail;
 * a busy mailbox surfaces as ShareProviderBusyError from the provider, which
 * the route turns into a retry.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid } from '@/lib/team-chat/types'
import { defaultEmailShareDeps, type EmailShareDeps } from './service'
import type { ShareMailbox } from './provider'
import type { EmailShareMessage } from './types'

/** The live reads a member share needs: the owner's mailbox, and the two provider reads. */
export interface MemberShareDeps {
  mailbox: EmailShareDeps['mailbox']
  provider: Pick<EmailShareDeps['provider'], 'threadIds' | 'message'>
}

export function defaultMemberShareDeps(): MemberShareDeps {
  const d = defaultEmailShareDeps()
  return { mailbox: d.mailbox, provider: { threadIds: d.provider.threadIds, message: d.provider.message } }
}

/** The most grantees one mention shares a thread with. */
export const MAX_THREAD_SHARE_GRANTEES = 10

/** At most this many of a share's messages are read from the mailbox at once (as 646's READ_CONCURRENCY). */
const READ_CONCURRENCY = 4

interface IndexRow {
  id: string
  user_id: string
  workspace_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
}

/** What a share records about what mentioned the thread (provenance only). */
export interface MemberShareSource {
  type: string
  id?: string | null
}

export interface ShareEmailThreadInput {
  workspaceId: string
  ownerUserId: string
  /** The thread's email_thread_index row id (the mention stores this). */
  threadIndexId: string
  /** The workspace members to share with (the teammates @-mentioned beside it). */
  memberIds: readonly string[]
  /** What carried the mention (e.g. a comment), for provenance. Optional. */
  source?: MemberShareSource | null
}

export interface ThreadShareMade {
  id: string
  granteeMemberId: string
}

export interface ShareEmailThreadResult {
  /** The shares made or refreshed (one per grantee that passed every check). */
  shared: ThreadShareMade[]
}

/**
 * Share the owner's OWN thread, view only, with each grantee that is a member
 * of the same workspace and not the owner. Verifies ownership and membership
 * with explicit service-role reads (never the caller's word), freezes the
 * thread's current message ids, and writes one live row per grantee (a
 * re-mention refreshes the frozen ids in place). Returns what it shared; never
 * throws.
 */
export async function shareEmailThreadWithMembers(
  svc: SupabaseClient,
  input: ShareEmailThreadInput,
  deps: MemberShareDeps = defaultMemberShareDeps(),
): Promise<ShareEmailThreadResult> {
  const made: ThreadShareMade[] = []
  try {
    if (!isUuid(input.threadIndexId) || !input.memberIds.length) return { shared: made }

    // 1. The index row is the owner's own, in this workspace. Never trust the caller.
    const { data: index } = await svc
      .from('email_thread_index')
      .select('id, user_id, workspace_id, account_id, provider, provider_thread_id')
      .eq('id', input.threadIndexId)
      .maybeSingle<IndexRow>()
    if (!index) return { shared: made }
    if (index.user_id !== input.ownerUserId || index.workspace_id !== input.workspaceId) return { shared: made }
    if (!index.account_id) return { shared: made } // no mailbox to freeze from

    // 2. Each grantee is a member of THIS workspace, and not the owner.
    const asked = [...new Set(input.memberIds.filter((id): id is string => isUuid(id)))].slice(0, MAX_THREAD_SHARE_GRANTEES)
    if (!asked.length) return { shared: made }
    const { data: members } = await svc
      .from('member')
      .select('id, user_id, workspace_id')
      .eq('workspace_id', input.workspaceId)
      .in('id', asked)
    const grantees = ((members ?? []) as Array<{ id: string; user_id: string; workspace_id: string }>)
      .filter((m) => m.workspace_id === input.workspaceId && m.user_id !== input.ownerUserId)
      .map((m) => m.id)
    if (!grantees.length) return { shared: made }

    // 3. Freeze the thread's current message ids, from the owner's mailbox.
    const mailbox = await deps.mailbox(input.ownerUserId, index.account_id, input.workspaceId)
    if (!mailbox || mailbox.provider !== index.provider) return { shared: made }
    const messageIds = await deps.provider.threadIds(mailbox, index.provider_thread_id)
    if (!messageIds || messageIds.length === 0) return { shared: made }

    // 4. One live row per grantee (refresh an existing live share in place).
    const base = {
      workspace_id: input.workspaceId,
      owner_user_id: input.ownerUserId,
      account_id: index.account_id,
      provider: index.provider,
      provider_thread_id: index.provider_thread_id,
      thread_index_id: index.id,
      message_ids: messageIds,
      source: 'mention' as const,
      source_type: input.source?.type ?? null,
      source_id: input.source?.id ?? null,
    }
    for (const granteeMemberId of grantees) {
      const { data: existing } = await svc
        .from('email_thread_share')
        .select('id')
        .eq('owner_user_id', input.ownerUserId)
        .eq('provider_thread_id', index.provider_thread_id)
        .eq('grantee_member_id', granteeMemberId)
        .is('revoked_at', null)
        .maybeSingle<{ id: string }>()
      if (existing) {
        await svc.from('email_thread_share').update({ ...base }).eq('id', existing.id)
        made.push({ id: existing.id, granteeMemberId })
        continue
      }
      const { data: row, error } = await svc
        .from('email_thread_share')
        .insert({ ...base, grantee_member_id: granteeMemberId })
        .select('id')
        .single<{ id: string }>()
      if (!error && row) made.push({ id: row.id, granteeMemberId })
    }
    return { shared: made }
  } catch (err) {
    console.warn('[email-thread-share] share threw:', err instanceof Error ? err.message : 'unknown')
    return { shared: made }
  }
}

interface ShareRow {
  id: string
  workspace_id: string
  owner_user_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
  thread_index_id: string | null
  message_ids: string[]
  grantee_member_id: string
  revoked_at: string | null
}
const SHARE_COLUMNS =
  'id, workspace_id, owner_user_id, account_id, provider, provider_thread_id, thread_index_id, message_ids, grantee_member_id, revoked_at'

/** The shape the channel share's reader returns, minus the share's own id/mine. */
export interface SharedThreadView {
  subject: string
  messages: EmailShareMessage[]
  missing: number
  blockedImages: number
}

export type MemberShareRead =
  | { state: 'available'; shareId: string; threadIndexId: string | null; mine: boolean; thread: SharedThreadView }
  | { state: 'not_found' }
  | { state: 'unavailable' }

interface ReadInput {
  shareId?: string | null
  threadIndexId?: string | null
  callerUserId: string
  workspaceId: string
  images?: boolean
}

/** The caller's member id in a workspace, or null. */
async function memberIdOf(svc: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await svc
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/**
 * The share the caller may read: by its id, or by the thread index row they
 * are a grantee of. Access is a non-revoked row whose grantee is the caller's
 * member row in the share's workspace, OR the caller is the share's owner.
 * Null when there is none (the reader answers "not found").
 */
async function readableShare(svc: SupabaseClient, input: ReadInput): Promise<ShareRow | null> {
  const callerMemberId = await memberIdOf(svc, input.workspaceId, input.callerUserId)
  if (input.shareId) {
    if (!isUuid(input.shareId)) return null
    const { data: share } = await svc.from('email_thread_share').select(SHARE_COLUMNS).eq('id', input.shareId).maybeSingle<ShareRow>()
    if (!share || share.workspace_id !== input.workspaceId || share.revoked_at) return null
    const allowed = share.owner_user_id === input.callerUserId || (!!callerMemberId && share.grantee_member_id === callerMemberId)
    return allowed ? share : null
  }
  if (input.threadIndexId && isUuid(input.threadIndexId) && callerMemberId) {
    const { data } = await svc
      .from('email_thread_share')
      .select(SHARE_COLUMNS)
      .eq('thread_index_id', input.threadIndexId)
      .eq('grantee_member_id', callerMemberId)
      .eq('workspace_id', input.workspaceId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
    return ((data ?? []) as ShareRow[])[0] ?? null
  }
  return null
}

/** Only these frozen messages, read live from the owner's mailbox; null when none of them is there. */
async function readFrozen(
  deps: MemberShareDeps,
  mailbox: ShareMailbox,
  threadId: string,
  ids: readonly string[],
  images: boolean,
): Promise<SharedThreadView | null> {
  const read: Array<EmailShareMessage | null> = new Array(ids.length).fill(null)
  for (let i = 0; i < ids.length; i += READ_CONCURRENCY) {
    const batch = ids.slice(i, i + READ_CONCURRENCY)
    const got = await Promise.all(batch.map((id) => deps.provider.message(mailbox, id, threadId, { images })))
    got.forEach((m, j) => (read[i + j] = m))
  }
  const messages = read.filter((m): m is EmailShareMessage => !!m)
  if (messages.length === 0) return null
  const blockedImages = messages.reduce((n, m) => n + (m.blockedImages ?? 0), 0)
  return { subject: messages[0].subject || '(no subject)', messages, missing: ids.length - messages.length, blockedImages }
}

/**
 * Read a thread shared with the caller (or owned by them), read-only, live.
 * "not_found" when no share reaches them; "unavailable" when the owner left
 * the workspace, their mailbox is disconnected, or the thread is gone (never a
 * partial leak). The provider's busy error propagates to the route, which
 * offers a retry.
 */
export async function readSharedEmailThreadForMember(
  svc: SupabaseClient,
  input: ReadInput,
  deps: MemberShareDeps = defaultMemberShareDeps(),
): Promise<MemberShareRead> {
  const share = await readableShare(svc, input)
  if (!share) return { state: 'not_found' }
  // The owner must still be in the workspace, and have a mailbox that reads here.
  const ownerMemberId = await memberIdOf(svc, share.workspace_id, share.owner_user_id)
  if (!ownerMemberId || !share.account_id) return { state: 'unavailable' }
  const mailbox = await deps.mailbox(share.owner_user_id, share.account_id, share.workspace_id)
  if (!mailbox || mailbox.provider !== share.provider) return { state: 'unavailable' }
  const thread = await readFrozen(deps, mailbox, share.provider_thread_id, share.message_ids, input.images === true)
  if (!thread) return { state: 'unavailable' }
  return {
    state: 'available',
    shareId: share.id,
    threadIndexId: share.thread_index_id,
    mine: share.owner_user_id === input.callerUserId,
    thread,
  }
}

/**
 * The caller's own active share id for a thread index row, IF they are a
 * grantee (so a chip that only knows the mention's email_thread id can find
 * its share). Null otherwise.
 */
export async function findMemberShareId(
  svc: SupabaseClient,
  input: { threadIndexId: string; callerUserId: string; workspaceId: string },
): Promise<string | null> {
  if (!isUuid(input.threadIndexId)) return null
  const callerMemberId = await memberIdOf(svc, input.workspaceId, input.callerUserId)
  if (!callerMemberId) return null
  const { data } = await svc
    .from('email_thread_share')
    .select('id')
    .eq('thread_index_id', input.threadIndexId)
    .eq('grantee_member_id', callerMemberId)
    .eq('workspace_id', input.workspaceId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null
}

export type RevokeThreadShareResult = { ok: true } | { ok: false; status: number }

/** Un-share: the owner's alone. Access ends at once. A non-owner (or unknown id) gets "not found". */
export async function revokeEmailThreadShare(
  svc: SupabaseClient,
  input: { shareId: string; ownerUserId: string; workspaceId: string },
): Promise<RevokeThreadShareResult> {
  if (!isUuid(input.shareId)) return { ok: false, status: 404 }
  const { data: share } = await svc
    .from('email_thread_share')
    .select('id, owner_user_id, workspace_id, revoked_at')
    .eq('id', input.shareId)
    .maybeSingle<Pick<ShareRow, 'id' | 'owner_user_id' | 'workspace_id' | 'revoked_at'>>()
  if (!share || share.workspace_id !== input.workspaceId || share.owner_user_id !== input.ownerUserId) return { ok: false, status: 404 }
  if (share.revoked_at) return { ok: true }
  const { error } = await svc
    .from('email_thread_share')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', input.shareId)
    .is('revoked_at', null)
  if (error) return { ok: false, status: 500 }
  return { ok: true }
}
