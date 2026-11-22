/**
 * SHARING MAIL FROM A MENTION, by the same rule as comments
 * (docs/plans/mentions-everywhere.md, decision 1): when the AUTHOR of a save
 * @-mentions their OWN mail thread in a text, the thread is shared, view only,
 * with the teammates @-mentioned in that SAME text. The one helper both the
 * comment path and the document / description paths call, so the rule lives in
 * one place.
 *
 * A teammate is a mention of a `contact` chip whose contact row has `member_id`
 * set (documents and descriptions), or a member id already resolved (comments).
 * The share itself is the live `email_thread_share` (673): ids only, read live
 * from the OWNER's mailbox on each open. `shareEmailThreadWithMembers` verifies
 * the thread is the author's own and that each grantee is a member of the
 * workspace and not the author, so `authorUserId` MUST be the saving user; a
 * mail chip that is not the author's shares nothing.
 *
 * Only NEW (thread, teammate) pairs are shared: a re-save of unchanged text, or
 * one that adds nothing new to a thread, makes no provider freeze call. With no
 * previous text (a comment), every pair is new. A save that has a mail chip but
 * no teammate chip (or the other way round) shares nothing.
 *
 * REVOKING IS DELIBERATELY NOT DONE HERE: removing the mail mention (or the
 * teammate) from the text does NOT revoke the share. Access a person was given
 * is ended only by its owner's explicit revoke (DELETE
 * /api/account/email/thread-shares/[id]), never as a side effect of an edit —
 * the same way a comment edited later does not revoke what it shared.
 *
 * FAIL-SOFT: never throws, never fails the save it rides.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import type { MentionRef } from '@/lib/entity-links/mentionable'
import { MAX_THREAD_SHARE_GRANTEES, shareEmailThreadWithMembers, type MemberShareDeps, type MemberShareSource } from './member-share'

/** At most this many mail threads one save shares (each with up to MAX_THREAD_SHARE_GRANTEES teammates). */
export const MAX_MAIL_SHARE_THREADS = 10

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ShareMentionedMailInput {
  workspaceId: string
  /** The saving user: the thread's OWNER. Null (unknown) shares nothing. */
  authorUserId: string | null
  /** The author's member row, excluded from the teammates (one never shares with oneself). */
  authorMemberId?: string | null
  /** The CURRENT text's mention chips (its `email_thread` chips and `contact` chips). */
  mentions: readonly MentionRef[]
  /**
   * The PREVIOUS text's chips, so only (thread, teammate) pairs new to this
   * save are shared. Absent/null: every pair is new (a comment, a first save).
   * Ignored when `resolvedMemberIds` is given.
   */
  previousMentions?: readonly MentionRef[] | null
  /**
   * Comments carry teammate member ids directly: given, the contact chips are
   * not resolved and every pair is treated as new (a comment has no previous
   * text). The author's own id is filtered out here as a safety net.
   */
  resolvedMemberIds?: readonly string[]
  /** What carried the mention (its kind and id), for provenance. */
  source: MemberShareSource
}

/** The member ids a set of contact chips resolve to, workspace-scoped, only contacts with `member_id`. */
async function membersOfContacts(supabase: SupabaseClient, workspaceId: string, contactIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(contactIds.filter((id) => UUID.test(id)))]
  if (ids.length === 0) return new Map()
  const { data } = await supabase.from('contact').select('id, member_id').eq('workspace_id', workspaceId).in('id', ids)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ id?: string; member_id?: string | null }>) {
    if (typeof row.id === 'string' && typeof row.member_id === 'string' && row.member_id) map.set(row.id, row.member_id)
  }
  return map
}

const threadIdsOf = (refs: readonly MentionRef[]) => [...new Set(refs.filter((r) => r.type === 'email_thread').map((r) => r.id))]
const contactIdsOf = (refs: readonly MentionRef[]) => refs.filter((r) => r.type === 'contact').map((r) => r.id)

/**
 * Share each of the author's OWN mail threads the CURRENT text mentions with
 * the teammates mentioned beside it, for the pairs that are new to this save.
 * Never throws.
 */
export async function shareMentionedMail(
  supabase: SupabaseClient,
  input: ShareMentionedMailInput,
  deps?: MemberShareDeps,
): Promise<void> {
  try {
    if (!input.authorUserId || !UUID.test(input.authorUserId)) return
    const threadIds = threadIdsOf(input.mentions)
    if (threadIds.length === 0) return

    const exclude = (ids: readonly string[]) => ids.filter((id) => id !== input.authorMemberId)

    let currentMembers: string[]
    let previousMembers: string[]
    let previousThreadIds: string[]
    if (input.resolvedMemberIds) {
      // Comments: member ids already resolved; a comment has no previous text, so every pair is new.
      currentMembers = exclude([...new Set(input.resolvedMemberIds.filter((id) => UUID.test(id)))])
      previousMembers = []
      previousThreadIds = []
    } else {
      // Documents / descriptions: resolve contact chips to member ids (one read over current + previous).
      const currentContacts = contactIdsOf(input.mentions)
      const previousContacts = input.previousMentions ? contactIdsOf(input.previousMentions) : []
      const map = await membersOfContacts(supabase, input.workspaceId, [...currentContacts, ...previousContacts])
      const resolve = (contactIds: readonly string[]) => exclude([...new Set(contactIds.map((id) => map.get(id)).filter((m): m is string => !!m))])
      currentMembers = resolve(currentContacts)
      previousMembers = resolve(previousContacts)
      previousThreadIds = input.previousMentions ? threadIdsOf(input.previousMentions) : []
    }
    if (currentMembers.length === 0) return

    const svc = getServiceClient()
    let shared = 0
    for (const threadIndexId of threadIds) {
      if (shared >= MAX_MAIL_SHARE_THREADS) break
      // A pair (thread, teammate) is new unless the PREVIOUS text already had
      // both: so a thread new to this text shares with everyone, a thread
      // already there shares only the teammates it did not have before.
      const already = previousThreadIds.includes(threadIndexId) ? previousMembers : []
      const newMembers = currentMembers.filter((m) => !already.includes(m)).slice(0, MAX_THREAD_SHARE_GRANTEES)
      if (newMembers.length === 0) continue
      shared++
      await shareEmailThreadWithMembers(
        svc,
        { workspaceId: input.workspaceId, ownerUserId: input.authorUserId, threadIndexId, memberIds: newMembers, source: input.source },
        deps,
      )
    }
  } catch (err) {
    console.warn('[share-on-mention] threw:', err instanceof Error ? err.message : 'unknown')
  }
}
