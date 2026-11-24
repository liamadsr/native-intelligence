/**
 * Support chat's reads and writes (migration 715). Our staff's calls run as
 * THEM (their own Supabase client, under RLS and 715's functions, which
 * check support_staff for auth.uid()): the inbox, a post, a read mark, taking
 * down their own message. Starting a conversation and the settings are the
 * service role's (the sign-up trigger does the same start in the database).
 *
 * Each function throws a TeamChatError on a failed call, as team chat's do.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError, teamChatErrorOf } from '@/lib/team-chat/store'
import type { TeamChatChannel } from '@/lib/team-chat/types'
import type { SupportChatSettings, SupportStaffRow } from './welcome'

export { SUPPORT_WELCOME_MAX, tidyWelcomeTemplate, welcomeWords, type SupportChatSettings, type SupportStaffRow } from './welcome'

/** One row of 715's support_chat_inbox. */
export interface SupportInboxRow {
  channel_id: string
  workspace_id: string
  workspace_name: string | null
  name: string
  customer_user_id: string
  customer_member_id: string | null
  customer_name: string | null
  customer_email: string | null
  created_at: string
  last_message_at: string | null
  unread: number
  /** The staff member muted its notifications (715's support_chat_mute). */
  muted?: boolean | null
}

/** An inbox row as a conversation in team chat's list (our side of it). Pure. */
export function supportInboxChannel(row: SupportInboxRow): TeamChatChannel {
  const customer = row.customer_name?.trim() || row.customer_email?.split('@')[0] || 'Customer'
  return {
    id: row.channel_id,
    kind: 'support',
    name: row.name,
    topic: null,
    team_id: null,
    dm_member_id: null,
    last_message_at: row.last_message_at ?? row.created_at,
    archived_at: null,
    // Every message from a customer is for us: counted, never "mentions only"; muted, as a muted channel, no count.
    unread: row.muted ? 0 : Number(row.unread) || 0,
    mentions: 0,
    thread_unread: 0,
    thread_mentions: 0,
    notify: row.muted ? 'muted' : 'all',
    muted_until: null,
    support: {
      workspace_id: row.workspace_id,
      workspace_name: row.workspace_name,
      customer_user_id: row.customer_user_id,
      customer_member_id: row.customer_member_id,
      customer_name: customer,
      customer_email: row.customer_email,
    },
  }
}

/** Every support conversation, newest first, as our side's list shows them (as the staff member). */
export async function listSupportInbox(supabase: SupabaseClient): Promise<TeamChatChannel[]> {
  const { data, error } = await supabase.rpc('support_chat_inbox')
  if (error) throw teamChatErrorOf(error, 'support inbox read')
  return ((data ?? []) as SupportInboxRow[]).map(supportInboxChannel)
}

/** Post as the staff member (715's support_chat_post). A retried send with the same clientId returns the first try's id. */
export async function postSupportMessage(supabase: SupabaseClient, input: { channelId: string; body: string; clientId?: string | null }): Promise<string> {
  const { data, error } = await supabase.rpc('support_chat_post', { ch: input.channelId, words: input.body, client: input.clientId ?? null })
  if (error) throw teamChatErrorOf(error, 'support post')
  if (typeof data !== 'string') throw new TeamChatError('failed', 'support post returned no id')
  return data
}

/** Mark a support conversation read for the staff member, and their notifications about it. */
export async function markSupportRead(supabase: SupabaseClient, channelId: string): Promise<void> {
  const { error } = await supabase.rpc('support_chat_mark_read', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'support mark read')
}

/** Take down the staff member's own message. True when it did. */
export async function deleteSupportMessage(supabase: SupabaseClient, messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('support_chat_delete', { msg: messageId })
  if (error) throw teamChatErrorOf(error, 'support delete')
  return data === true
}

/** Mute (or unmute) a support conversation's notifications for the staff member (715's support_chat_mute). */
export async function setSupportMuted(supabase: SupabaseClient, channelId: string, muted: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('support_chat_mute', { ch: channelId, turn_on: muted })
  if (error) throw teamChatErrorOf(error, 'support mute')
  return data === true
}

/**
 * The customer deletes their own support conversation, completely, for both
 * sides (715's support_chat_remove): the files its messages carried, so the
 * caller removes their uploads from storage; null when it isn't theirs.
 */
export async function removeSupportConversation(supabase: SupabaseClient, channelId: string): Promise<string[] | null> {
  const { data, error } = await supabase.rpc('support_chat_remove', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'support delete')
  return Array.isArray(data) ? (data as unknown[]).filter((p): p is string => typeof p === 'string') : null
}

export type SupportStartReason = 'started' | 'exists' | 'deleted' | 'staff' | 'no_workspace' | 'no_staff' | 'no_account' | 'before'

/**
 * Start an account's support conversation (service role; 715's
 * support_chat_start). Once per account; `fresh` (an admin's start) also
 * for one who deleted theirs.
 */
export async function startSupportChat(
  svc: SupabaseClient,
  userId: string,
  opts: { fresh?: boolean } = {},
): Promise<{ started: boolean; channelId: string | null; reason: SupportStartReason }> {
  const { data, error } = await svc.rpc('support_chat_start', { p_user: userId, p_fresh: opts.fresh === true })
  if (error) throw teamChatErrorOf(error, 'support start')
  const out = (data ?? {}) as { started?: boolean; channel_id?: string | null; reason?: SupportStartReason }
  return { started: out.started === true, channelId: out.channel_id ?? null, reason: out.reason ?? 'no_account' }
}

/** How long one person's "start it if it's due" stands before their list asks again. */
const DUE_EVERY_MS = 10 * 60_000
const dueAsked = new Map<string, number>()

/** Tests only. */
export function resetSupportDue(): void {
  dueAsked.clear()
}

/**
 * An account made since support chat began with no conversation (its
 * sign-up came before anyone was on the team, or the start failed) gets it
 * now (715's support_chat_start_if_due). Asked from the person's own team
 * chat list when it has none, at most once per DUE_EVERY_MS per process.
 * True when one was started. Never throws.
 */
export async function startSupportChatIfDue(svc: SupabaseClient, userId: string, now: number = Date.now()): Promise<boolean> {
  const last = dueAsked.get(userId)
  if (last !== undefined && now - last < DUE_EVERY_MS) return false
  dueAsked.set(userId, now)
  try {
    const { data, error } = await svc.rpc('support_chat_start_if_due', { p_user: userId })
    if (error) return false
    return (data as { started?: boolean } | null)?.started === true
  } catch {
    return false
  }
}

/** The settings and the team (service role). */
export async function readSupportSettings(svc: SupabaseClient): Promise<{ settings: SupportChatSettings | null; staff: SupportStaffRow[] }> {
  const [settings, staff] = await Promise.all([
    svc.from('support_chat_settings').select('welcome_template, sender_user_id, updated_at').eq('id', true).maybeSingle<SupportChatSettings>(),
    svc.from('support_staff').select('user_id, display_name, avatar_url, added_at').order('added_at', { ascending: true }),
  ])
  if (settings.error) throw teamChatErrorOf(settings.error, 'support settings read')
  if (staff.error) throw teamChatErrorOf(staff.error, 'support staff read')
  return { settings: settings.data ?? null, staff: (staff.data ?? []) as SupportStaffRow[] }
}

/** Save the welcome and its sender (service role). The sender must be on the team (or null: the longest-standing). */
export async function saveSupportSettings(
  svc: SupabaseClient,
  input: { welcomeTemplate: string; senderUserId: string | null; updatedBy: string },
): Promise<void> {
  const { error } = await svc
    .from('support_chat_settings')
    .upsert(
      { id: true, welcome_template: input.welcomeTemplate, sender_user_id: input.senderUserId, updated_by: input.updatedBy, updated_at: new Date().toISOString() },
      { onConflict: 'id' },
    )
  if (error) throw teamChatErrorOf(error, 'support settings save')
}
