/**
 * Pasted share links become shares (migration 646): the message post route
 * (src/app/api/account/team-chat/channels/[id]/messages) hands each new
 * message here. For each share link in its words (./links.ts) whose OWNER is
 * the message's author, a share is made in that channel or DM, bound to the
 * message, with the link's message ids (frozen when it was copied); the
 * message then carries the first (team_chat_message.email_share_id) and draws
 * the email card, as a share from the picker does. A link pasted by anyone
 * else, a revoked or unknown one, one from another workspace, or one whose
 * owner's mailbox no longer reads here, makes nothing: it stays plain text.
 *
 * The post rule is already met: the message was inserted as its author,
 * under 474's insert policy (team_chat_can_post). Only a channel or DM takes
 * a share, never a meeting chat. Only on post, never on an edit: a link added
 * by editing stays plain text (paste it in a new message). Safe to run twice
 * (a retried send): a share already made for the message and link is reused.
 *
 * This reads link and share rows and checks the owner's mailbox is readable;
 * it never reads mail (no provider call).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { ownedMailbox } from '@/lib/email/thread-mailbox'
import { readableWorkspaceEmailAccounts } from '@/lib/email/account-scope'
import { emailShareLinkTokens } from './links'

export interface BindDeps {
  svc: SupabaseClient
  /** The owner's mailbox still reads in this workspace (enabled, linked, a token that works). */
  mailboxReadable: (ownerUserId: string, accountId: string, workspaceId: string) => Promise<boolean>
}

export function defaultBindDeps(): BindDeps {
  return {
    svc: getServiceClient(),
    mailboxReadable: async (ownerUserId, accountId, workspaceId) => {
      const readable = await readableWorkspaceEmailAccounts(ownerUserId, workspaceId)
      if (!readable.some((a) => a.id === accountId)) return false
      return !!(await ownedMailbox(ownerUserId, accountId))
    },
  }
}

interface LinkRow {
  id: string
  workspace_id: string
  owner_user_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
  thread_index_id: string | null
  message_ids: string[]
  revoked_at: string | null
}

export interface BindInput {
  workspaceId: string
  /** The message's author: only their own links bind. */
  authorUserId: string
  authorMemberId: string
  channel: { id: string; kind: string; workspace_id: string }
  message: { id: string; body: string; email_share_id?: string | null }
}

/**
 * Turn the author's own share links in a new message into shares there.
 * Returns the shares made (or found, on a retry), in the words' order, and
 * the share the message now carries. Never throws: a link that can't bind
 * stays plain text (logged by ids).
 */
export async function bindEmailShareLinks(deps: BindDeps, input: BindInput): Promise<{ shareIds: string[]; emailShareId: string | null }> {
  const current = input.message.email_share_id ?? null
  const tokens = emailShareLinkTokens(input.message.body)
  if (tokens.length === 0) return { shareIds: [], emailShareId: current }
  if (input.channel.workspace_id !== input.workspaceId || (input.channel.kind !== 'channel' && input.channel.kind !== 'dm')) {
    return { shareIds: [], emailShareId: current }
  }
  const shareIds: string[] = []
  for (const token of tokens) {
    try {
      const { data: link } = await deps.svc
        .from('email_share_link')
        .select('id, workspace_id, owner_user_id, account_id, provider, provider_thread_id, thread_index_id, message_ids, revoked_at')
        .eq('token', token)
        .maybeSingle<LinkRow>()
      if (!link || link.revoked_at || link.workspace_id !== input.workspaceId || link.owner_user_id !== input.authorUserId || !link.account_id) continue
      const { data: made } = await deps.svc
        .from('email_share')
        .select('id')
        .eq('team_chat_message_id', input.message.id)
        .eq('link_id', link.id)
        .maybeSingle<{ id: string }>()
      if (made) {
        shareIds.push(made.id)
        continue
      }
      if (!(await deps.mailboxReadable(link.owner_user_id, link.account_id, link.workspace_id))) continue
      const { data: share, error } = await deps.svc
        .from('email_share')
        .insert({
          workspace_id: link.workspace_id,
          owner_user_id: link.owner_user_id,
          account_id: link.account_id,
          provider: link.provider,
          provider_thread_id: link.provider_thread_id,
          thread_index_id: link.thread_index_id,
          message_ids: link.message_ids,
          channel_id: input.channel.id,
          team_chat_message_id: input.message.id,
          shared_by_member_id: input.authorMemberId,
          link_id: link.id,
        })
        .select('id')
        .single<{ id: string }>()
      if (error || !share) continue
      shareIds.push(share.id)
      console.info(`[email-share] link=${link.id} bound share=${share.id} message=${input.message.id}`)
    } catch (err) {
      console.warn(`[email-share] link bind on message=${input.message.id} failed:`, err instanceof Error ? err.name : 'unknown')
    }
  }
  let emailShareId = current
  if (!emailShareId && shareIds.length > 0) {
    // The message carries its first share: its card draws, live, for everyone (a Realtime update).
    const { error } = await deps.svc.from('team_chat_message').update({ email_share_id: shareIds[0] }).eq('id', input.message.id).is('email_share_id', null)
    if (!error) emailShareId = shareIds[0]
  }
  return { shareIds, emailShareId }
}
