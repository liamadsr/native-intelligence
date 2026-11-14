/**
 * Sharing an email thread into team chat, read live (migration 646): the
 * server half. See ./types.ts for the decision and the fences.
 *
 * Who may do what, checked here on every call:
 *   share      the mail's OWNER only (the thread's index row is theirs, in
 *              this workspace; or a mailbox of theirs this workspace may
 *              read), into a channel or DM of this workspace they may POST in
 *              (474's team_chat_can_post, asked as them, under RLS).
 *   un-share   the owner only. Sets revoked_at: access ends at once.
 *   read       anyone in this workspace who may READ the share's channel
 *              (474's team_chat_can_read, asked as them), while the share is
 *              not revoked, its owner is still in the workspace, and the
 *              owner's mailbox still reads in this workspace. Only the frozen
 *              message ids are read, from the owner's mailbox with the
 *              owner's token, each time; an attachment only of one of those
 *              messages, by the key the mailbox lists for it now.
 * Anyone else gets "not found": a share is never confirmed to exist to
 * someone who can't read its channel.
 *
 * Nothing of the mail is stored, cached beyond a few seconds in this process
 * (the card's subject and first line, CARD_CACHE_MS), logged or put in an
 * error: logs carry ids and counts only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { randomBytes } from 'node:crypto'
import { getServiceClient } from '@/lib/admin'
import { appUrl } from '@/lib/app-url'
import { emailShareLinkPath, isEmailShareLinkToken } from './links'
import { ownedMailbox } from '@/lib/email/thread-mailbox'
import { readableWorkspaceEmailAccounts } from '@/lib/email/account-scope'
import { TEAM_CHAT_MESSAGE_COLUMNS, dmOtherMember, isUuid, type TeamChatMessage } from '@/lib/team-chat/types'
import {
  liveSharedAttachment,
  liveSharedMessage,
  liveSharedSummary,
  liveThreadMessageIds,
  type SharedAttachmentFile,
  type ShareMailbox,
} from './provider'
import {
  EMAIL_SHARE_NOT_OWNER_TEXT,
  EMAIL_SHARE_REVOKED_TEXT,
  EMAIL_SHARE_UNAVAILABLE_TEXT,
  emailShareBody,
  type EmailShareCardView,
  type EmailShareChip,
  type EmailShareMessage,
  type EmailShareTarget,
  type EmailShareThreadView,
} from './types'

// ── Dependencies (the tests pass their own) ─────────────────────────────────

export interface EmailShareDeps {
  /** The service-role client: email_share has no client grants. */
  svc: SupabaseClient
  /**
   * The owner's own enabled email account's token, when that account is one
   * this workspace may read; null otherwise (disconnected, unlinked, a token
   * that fails).
   */
  mailbox: (ownerUserId: string, accountId: string, workspaceId: string) => Promise<ShareMailbox | null>
  provider: {
    threadIds: (mailbox: ShareMailbox, threadId: string) => Promise<string[] | null>
    message: (mailbox: ShareMailbox, messageId: string, threadId: string, opts?: { images?: boolean }) => Promise<EmailShareMessage | null>
    summary: (mailbox: ShareMailbox, messageId: string, threadId: string) => Promise<{ subject: string; from: string; firstLine: string } | null>
    attachment: (mailbox: ShareMailbox, messageId: string, threadId: string, key: string) => Promise<SharedAttachmentFile | null>
  }
}

export function defaultEmailShareDeps(): EmailShareDeps {
  return {
    svc: getServiceClient(),
    mailbox: async (ownerUserId, accountId, workspaceId) => {
      const readable = await readableWorkspaceEmailAccounts(ownerUserId, workspaceId)
      if (!readable.some((a) => a.id === accountId)) return null
      const live = await ownedMailbox(ownerUserId, accountId)
      return live ? { provider: live.provider, token: live.token } : null
    },
    provider: {
      threadIds: (m, t) => liveThreadMessageIds(m, t),
      message: (m, id, t, opts) => liveSharedMessage(m, id, t, fetch, opts),
      summary: (m, id, t) => liveSharedSummary(m, id, t),
      attachment: (m, id, t, key) => liveSharedAttachment(m, id, t, key),
    },
  }
}

/** The person acting: their own RLS client (team chat's read and post rules are asked through it). */
export interface ShareCaller {
  supabase: SupabaseClient
  userId: string
  workspaceId: string
  memberId: string
}

export type ShareFailure = { ok: false; status: number; code: string; error: string }
const fail = (status: number, code: string, error: string): ShareFailure => ({ ok: false, status, code, error })
const NOT_FOUND = fail(404, 'not_found', 'Not found')
const UNAVAILABLE = fail(410, 'unavailable', EMAIL_SHARE_UNAVAILABLE_TEXT)
const REVOKED = fail(410, 'revoked', EMAIL_SHARE_REVOKED_TEXT)
const NOT_OWNER = fail(403, 'not_owner', EMAIL_SHARE_NOT_OWNER_TEXT)

interface ShareRow {
  id: string
  workspace_id: string
  owner_user_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
  thread_index_id: string | null
  message_ids: string[]
  channel_id: string
  team_chat_message_id: string | null
  created_at: string
  revoked_at: string | null
}
const SHARE_COLUMNS =
  'id, workspace_id, owner_user_id, account_id, provider, provider_thread_id, thread_index_id, message_ids, channel_id, team_chat_message_id, created_at, revoked_at'

interface ChannelRow {
  id: string
  workspace_id: string
  kind: 'channel' | 'dm' | 'meeting'
  name: string | null
  team_id: string | null
  dm_key: string | null
  archived_at: string | null
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** How a channel or DM is named to the person: "#sales", a DM's other member, "Note to self". */
export function channelLabel(channel: Pick<ChannelRow, 'kind' | 'name' | 'dm_key'>, memberId: string, names: ReadonlyMap<string, string>): string {
  if (channel.kind === 'channel') return `#${channel.name ?? 'channel'}`
  const other = dmOtherMember(channel.dm_key, memberId)
  if (!other) return 'a direct message'
  if (other === memberId) return 'Note to self'
  return names.get(other) ?? 'a teammate'
}

async function memberNames(svc: SupabaseClient, workspaceId: string): Promise<Map<string, { name: string; role: string | null }>> {
  const { data } = await svc.from('member').select('id, display_name, role').eq('workspace_id', workspaceId)
  return new Map(
    ((data ?? []) as Array<{ id: string; display_name: string | null; role: string | null }>).map((m) => [
      m.id,
      { name: m.display_name?.trim() || 'A teammate', role: m.role ?? null },
    ]),
  )
}

// ── Share ───────────────────────────────────────────────────────────────────

export interface ShareInput {
  /** The thread's email_thread_index row (the entity menu's id). */
  indexId?: string | null
  /** The provider's thread id (the thread view's). */
  threadId?: string | null
  /** The mailbox it is in, for a thread the index doesn't hold. */
  accountId?: string | null
  channelId: string
  note?: unknown
}

interface ThreadRef {
  accountId: string | null
  provider: 'google' | 'microsoft'
  providerThreadId: string
  indexId: string | null
}

/**
 * The caller's OWN thread, in this workspace: never another person's. A
 * thread index row of another member here (the entity menu names one by its
 * id) is 'not_owner', so the menu can say only its owner shares it; anything
 * else that isn't theirs is null ("not found").
 */
async function ownThread(deps: EmailShareDeps, caller: ShareCaller, input: Pick<ShareInput, 'indexId' | 'threadId' | 'accountId'>): Promise<ThreadRef | 'not_owner' | null> {
  const columns = 'id, user_id, workspace_id, account_id, provider, provider_thread_id'
  type IndexRow = { id: string; user_id: string; workspace_id: string; account_id: string | null; provider: 'google' | 'microsoft'; provider_thread_id: string }
  let row: IndexRow | null = null
  if (input.indexId) {
    if (!isUuid(input.indexId)) return null
    const { data } = await deps.svc.from('email_thread_index').select(columns).eq('id', input.indexId).maybeSingle<IndexRow>()
    row = data ?? null
  } else if (typeof input.threadId === 'string' && input.threadId.trim()) {
    let query = deps.svc
      .from('email_thread_index')
      .select(columns)
      .eq('user_id', caller.userId)
      .eq('workspace_id', caller.workspaceId)
      .eq('provider_thread_id', input.threadId.trim())
    if (input.accountId) query = query.eq('account_id', input.accountId)
    const { data } = await query.limit(1)
    row = ((data ?? []) as IndexRow[])[0] ?? null
  }
  if (row) {
    if (row.workspace_id !== caller.workspaceId) return null
    if (row.user_id !== caller.userId) return 'not_owner'
    return { accountId: row.account_id, provider: row.provider, providerThreadId: row.provider_thread_id, indexId: row.id }
  }
  // A thread the index doesn't hold (an older search result): only in a mailbox of theirs this workspace may read.
  if (!input.indexId && input.accountId && isUuid(input.accountId) && typeof input.threadId === 'string' && input.threadId.trim()) {
    const { data: account } = await deps.svc
      .from('connected_account')
      .select('id, provider, user_id, capability')
      .eq('id', input.accountId)
      .eq('user_id', caller.userId)
      .eq('capability', 'email')
      .maybeSingle<{ id: string; provider: 'google' | 'microsoft' }>()
    if (!account) return null
    return { accountId: account.id, provider: account.provider, providerThreadId: input.threadId.trim(), indexId: null }
  }
  return null
}

export type ShareResult =
  | { ok: true; shareId: string; label: string; message: TeamChatMessage; messageCount: number }
  | ShareFailure

/**
 * Share the caller's own thread into a channel or DM they may post in: its
 * message ids are read live and frozen, the share is stored, and a message
 * authored by them carries it (their note, or EMAIL_SHARE_DEFAULT_BODY).
 */
export async function createEmailShare(deps: EmailShareDeps, caller: ShareCaller, input: ShareInput): Promise<ShareResult> {
  if (!isUuid(input.channelId)) return fail(400, 'bad_request', 'Pick a channel or a direct message')
  const { data: channel } = await deps.svc
    .from('team_chat_channel')
    .select('id, workspace_id, kind, name, team_id, dm_key, archived_at')
    .eq('id', input.channelId)
    .maybeSingle<ChannelRow>()
  if (!channel || channel.workspace_id !== caller.workspaceId) return fail(404, 'not_found', 'Channel not found')
  if (channel.kind !== 'channel' && channel.kind !== 'dm') return fail(400, 'bad_request', 'Share into a channel or a direct message')
  // The person's own post rule (474), asked as them: a channel they can't read or post in, or an archived one, is refused.
  const { data: canPost, error: postError } = await caller.supabase.rpc('team_chat_can_post', { ch: channel.id })
  if (postError || canPost !== true) return fail(403, 'forbidden', "You can't post there")

  const thread = await ownThread(deps, caller, input)
  if (thread === 'not_owner') return NOT_OWNER
  if (!thread) return fail(404, 'not_found', 'Email not found')
  if (!thread.accountId) return fail(409, 'no_mailbox', 'Reconnect this mailbox to share from it')
  const mailbox = await deps.mailbox(caller.userId, thread.accountId, caller.workspaceId)
  if (!mailbox) return fail(409, 'no_mailbox', 'This mailbox is disconnected. Reconnect it to share from it.')
  if (mailbox.provider !== thread.provider) return fail(409, 'no_mailbox', 'This mailbox is disconnected. Reconnect it to share from it.')
  const messageIds = await deps.provider.threadIds(mailbox, thread.providerThreadId)
  if (!messageIds || messageIds.length === 0) return UNAVAILABLE

  const { data: share, error: shareError } = await deps.svc
    .from('email_share')
    .insert({
      workspace_id: caller.workspaceId,
      owner_user_id: caller.userId,
      account_id: thread.accountId,
      provider: thread.provider,
      provider_thread_id: thread.providerThreadId,
      thread_index_id: thread.indexId,
      message_ids: messageIds,
      channel_id: channel.id,
      shared_by_member_id: caller.memberId,
    })
    .select('id')
    .single<{ id: string }>()
  if (shareError || !share) return fail(500, 'failed', "Couldn't share it")

  // Posted by the server (the share column is the service role's), as the sharer.
  const { data: message, error: messageError } = await deps.svc
    .from('team_chat_message')
    .insert({
      channel_id: channel.id,
      workspace_id: caller.workspaceId,
      author_kind: 'member',
      author_member_id: caller.memberId,
      body: emailShareBody(input.note),
      mentions: [],
      mentions_agent: false,
      email_share_id: share.id,
    })
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .single<TeamChatMessage>()
  if (messageError || !message) {
    await deps.svc.from('email_share').delete().eq('id', share.id)
    return fail(500, 'failed', "Couldn't share it")
  }
  await deps.svc.from('email_share').update({ team_chat_message_id: message.id }).eq('id', share.id)

  const names = channel.kind === 'dm' ? await memberNames(deps.svc, caller.workspaceId) : new Map()
  const label = channelLabel(channel, caller.memberId, new Map([...names].map(([id, m]) => [id, m.name])))
  return { ok: true, shareId: share.id, label, message, messageCount: messageIds.length }
}

/** Un-share: the owner's alone. Access ends at once; the chat message stays (its card says "No longer shared"). */
export async function revokeEmailShare(deps: EmailShareDeps, caller: ShareCaller, shareId: string): Promise<{ ok: true } | ShareFailure> {
  if (!isUuid(shareId)) return NOT_FOUND
  const { data: share } = await deps.svc.from('email_share').select('id, owner_user_id, workspace_id, revoked_at').eq('id', shareId).maybeSingle<Pick<ShareRow, 'id' | 'owner_user_id' | 'workspace_id' | 'revoked_at'>>()
  if (!share || share.workspace_id !== caller.workspaceId || share.owner_user_id !== caller.userId) return NOT_FOUND
  if (share.revoked_at) return { ok: true }
  const { error } = await deps.svc.from('email_share').update({ revoked_at: new Date().toISOString() }).eq('id', shareId).is('revoked_at', null)
  if (error) return fail(500, 'failed', "Couldn't un-share it")
  return { ok: true }
}

// ── Read ────────────────────────────────────────────────────────────────────

export type ShareAccess =
  | { kind: 'live'; share: ShareRow; mailbox: ShareMailbox; mine: boolean }
  | { kind: 'revoked' | 'unavailable'; share: ShareRow; mine: boolean }
  | ShareFailure

/**
 * May the caller read this share, and can it be read now? "Not found" unless
 * they may read its channel (asked as them); then revoked, unavailable (the
 * owner left the workspace, or their mailbox no longer reads here), or live.
 */
export async function shareAccess(deps: EmailShareDeps, caller: ShareCaller, shareId: string): Promise<ShareAccess> {
  if (!isUuid(shareId)) return NOT_FOUND
  const { data: share } = await deps.svc.from('email_share').select(SHARE_COLUMNS).eq('id', shareId).maybeSingle<ShareRow>()
  if (!share || share.workspace_id !== caller.workspaceId) return NOT_FOUND
  const { data: canRead, error } = await caller.supabase.rpc('team_chat_can_read', { ch: share.channel_id })
  if (error || canRead !== true) return NOT_FOUND
  const mine = share.owner_user_id === caller.userId
  if (share.revoked_at) return { kind: 'revoked', share, mine }
  const { data: owner } = await deps.svc
    .from('member')
    .select('id')
    .eq('workspace_id', share.workspace_id)
    .eq('user_id', share.owner_user_id)
    .maybeSingle<{ id: string }>()
  if (!owner || !share.account_id) return { kind: 'unavailable', share, mine }
  const mailbox = await deps.mailbox(share.owner_user_id, share.account_id, share.workspace_id)
  if (!mailbox || mailbox.provider !== share.provider) return { kind: 'unavailable', share, mine }
  return { kind: 'live', share, mailbox, mine }
}

/** The card's subject and first line, a few seconds in this process only (never stored). */
export const CARD_CACHE_MS = 5_000
const CARD_CACHE_MAX = 200
const cardCache = new Map<string, { at: number; value: { subject: string; firstLine: string; from: string } }>()

/** For tests. */
export function clearShareCardCache(): void {
  cardCache.clear()
}

/**
 * The newest FROZEN message the mailbox still has (a few tried, newest first):
 * its subject, sender and first line. Never the thread index's sender, which
 * is the whole thread's newest (a later, private reply's). Only a summary
 * that was read is cached; a gone one or a provider failure (which throws
 * ShareProviderBusyError) is asked again next time.
 */
async function cardSummary(deps: EmailShareDeps, share: ShareRow, mailbox: ShareMailbox, now: number) {
  const hit = cardCache.get(share.id)
  if (hit && now - hit.at < CARD_CACHE_MS) return hit.value
  let value: { subject: string; firstLine: string; from: string } | null = null
  for (const id of [...share.message_ids].reverse().slice(0, 3)) {
    value = await deps.provider.summary(mailbox, id, share.provider_thread_id)
    if (value) break
  }
  if (!value) return null
  if (cardCache.size >= CARD_CACHE_MAX) cardCache.delete(cardCache.keys().next().value as string)
  cardCache.set(share.id, { at: now, value })
  return value
}

export async function readShareCard(deps: EmailShareDeps, caller: ShareCaller, shareId: string, now = Date.now()): Promise<EmailShareCardView | ShareFailure> {
  const access = await shareAccess(deps, caller, shareId)
  if ('ok' in access) return access
  const base = { id: access.share.id, mine: access.mine, messageCount: access.share.message_ids.length }
  const closed = (state: 'revoked' | 'unavailable'): EmailShareCardView => ({ ...base, state, sender: null, subject: null, firstLine: null })
  if (access.kind !== 'live') return closed(access.kind)
  const summary = await cardSummary(deps, access.share, access.mailbox, now)
  if (!summary) return closed('unavailable')
  return { ...base, state: 'live', sender: summary.from || null, subject: summary.subject || '(no subject)', firstLine: summary.firstLine || null }
}

/** At most this many of a share's messages are read from the mailbox at once. */
const READ_CONCURRENCY = 4

/**
 * The shared thread, read-only: only its frozen messages, read live. Remote
 * images stay out unless the reader asks (`images`).
 */
export async function readSharedThread(
  deps: EmailShareDeps,
  caller: ShareCaller,
  shareId: string,
  opts: { images?: boolean } = {},
): Promise<EmailShareThreadView | ShareFailure> {
  const access = await shareAccess(deps, caller, shareId)
  if ('ok' in access) return access
  if (access.kind !== 'live') return access.kind === 'revoked' ? REVOKED : UNAVAILABLE
  const { share, mailbox } = access
  const view = await readFrozen(deps, mailbox, share.provider_thread_id, share.message_ids, opts)
  return view ? { id: share.id, mine: access.mine, ...view } : UNAVAILABLE
}

/** Only these frozen messages, read live from the owner's mailbox; null when none of them is there any more. */
async function readFrozen(
  deps: EmailShareDeps,
  mailbox: ShareMailbox,
  threadId: string,
  ids: readonly string[],
  opts: { images?: boolean },
): Promise<Omit<EmailShareThreadView, 'id' | 'mine'> | null> {
  const read: Array<EmailShareMessage | null> = new Array(ids.length).fill(null)
  for (let i = 0; i < ids.length; i += READ_CONCURRENCY) {
    const batch = ids.slice(i, i + READ_CONCURRENCY)
    const got = await Promise.all(batch.map((id) => deps.provider.message(mailbox, id, threadId, { images: opts.images === true })))
    got.forEach((m, j) => (read[i + j] = m))
  }
  const messages = read.filter((m): m is EmailShareMessage => !!m)
  if (messages.length === 0) return null
  const blockedImages = messages.reduce((n, m) => n + (m.blockedImages ?? 0), 0)
  return { subject: messages[0].subject || '(no subject)', messages, missing: ids.length - messages.length, blockedImages }
}

/** One attachment of one of the share's frozen messages, by the key its read listed. */
export async function readSharedAttachment(
  deps: EmailShareDeps,
  caller: ShareCaller,
  shareId: string,
  messageId: string,
  key: string,
): Promise<SharedAttachmentFile | ShareFailure> {
  const access = await shareAccess(deps, caller, shareId)
  if ('ok' in access) return access
  if (access.kind !== 'live') return access.kind === 'revoked' ? REVOKED : UNAVAILABLE
  // Only a message the share froze, and a key of reasonable shape.
  if (!access.share.message_ids.includes(messageId)) return NOT_FOUND
  if (!key || key.length > 512) return NOT_FOUND
  const file = await deps.provider.attachment(access.mailbox, messageId, access.share.provider_thread_id, key)
  return file ?? fail(404, 'not_found', 'That file is no longer available')
}

// ── For the owner ───────────────────────────────────────────────────────────

/** Where the caller's own thread is shared now (live shares), oldest first. */
export async function listThreadShares(
  deps: EmailShareDeps,
  caller: ShareCaller,
  input: Pick<ShareInput, 'indexId' | 'threadId' | 'accountId'>,
): Promise<EmailShareChip[]> {
  const thread = await ownThread(deps, caller, input)
  if (!thread || thread === 'not_owner') return []
  const { data } = await deps.svc
    .from('email_share')
    .select('id, channel_id, created_at')
    .eq('owner_user_id', caller.userId)
    .eq('workspace_id', caller.workspaceId)
    .eq('provider_thread_id', thread.providerThreadId)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
    .limit(50)
  const rows = (data ?? []) as Array<{ id: string; channel_id: string; created_at: string }>
  const { data: linkRows } = await deps.svc
    .from('email_share_link')
    .select('id, created_at')
    .eq('owner_user_id', caller.userId)
    .eq('workspace_id', caller.workspaceId)
    .eq('provider_thread_id', thread.providerThreadId)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
    .limit(20)
  const links: EmailShareChip[] = ((linkRows ?? []) as Array<{ id: string; created_at: string }>).map((l) => ({
    id: l.id,
    kind: 'link',
    channelId: null,
    label: 'Link',
    createdAt: l.created_at,
  }))
  if (rows.length === 0) return links
  const { data: channels } = await deps.svc
    .from('team_chat_channel')
    .select('id, kind, name, dm_key')
    .in('id', [...new Set(rows.map((r) => r.channel_id))])
  const byId = new Map(((channels ?? []) as Array<Pick<ChannelRow, 'id' | 'kind' | 'name' | 'dm_key'>>).map((c) => [c.id, c]))
  const needNames = [...byId.values()].some((c) => c.kind === 'dm')
  const names = needNames ? await memberNames(deps.svc, caller.workspaceId) : new Map()
  const nameOf = new Map([...names].map(([id, m]) => [id, m.name]))
  const shares = rows.map((r): EmailShareChip => {
    const c = byId.get(r.channel_id)
    return { id: r.id, kind: 'share', channelId: r.channel_id, label: c ? channelLabel(c, caller.memberId, nameOf) : 'a conversation', createdAt: r.created_at }
  })
  return [...shares, ...links]
}

/**
 * The channels and DMs the caller may post in here (not archived, read as
 * them), each with whether guests can read it: channels first, then DMs, by
 * name.
 */
export async function listShareTargets(deps: EmailShareDeps, caller: ShareCaller): Promise<EmailShareTarget[]> {
  const { data, error } = await caller.supabase
    .from('team_chat_channel')
    .select('id, workspace_id, kind, name, team_id, dm_key, archived_at')
    .eq('workspace_id', caller.workspaceId)
    .is('archived_at', null)
    .in('kind', ['channel', 'dm'])
    .limit(500)
  if (error) return []
  const channels = (data ?? []) as ChannelRow[]
  const members = await memberNames(deps.svc, caller.workspaceId)
  const guests = new Set([...members].filter(([, m]) => m.role === 'guest').map(([id]) => id))
  const teamIds = [...new Set(channels.map((c) => c.team_id).filter((t): t is string => !!t))]
  const teamGuests = new Set<string>()
  if (teamIds.length > 0 && guests.size > 0) {
    const { data: rows } = await deps.svc.from('team_member').select('team_id, member_id').in('team_id', teamIds)
    for (const r of (rows ?? []) as Array<{ team_id: string; member_id: string }>) if (guests.has(r.member_id)) teamGuests.add(r.team_id)
  }
  const nameOf = new Map([...members].map(([id, m]) => [id, m.name]))
  const targets = channels.map((c): EmailShareTarget => {
    let outside = false
    if (c.kind === 'channel') outside = c.team_id ? teamGuests.has(c.team_id) : guests.size > 0
    else {
      const other = dmOtherMember(c.dm_key, caller.memberId)
      outside = !!other && guests.has(other)
    }
    return { id: c.id, kind: c.kind as 'channel' | 'dm', label: channelLabel(c, caller.memberId, nameOf), outside }
  })
  return targets.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'channel' ? -1 : 1))
}

// ── A message's shares (several pasted links) ───────────────────────────────

/**
 * The live shares a team chat message carries, oldest first, for a reader of
 * its channel (asked as them): a message with several pasted links draws a
 * card for each. Anyone else: none.
 */
export async function listMessageShares(deps: EmailShareDeps, caller: ShareCaller, messageId: string): Promise<string[]> {
  if (!isUuid(messageId)) return []
  const { data: message } = await deps.svc.from('team_chat_message').select('id, channel_id, workspace_id').eq('id', messageId).maybeSingle<{ id: string; channel_id: string; workspace_id: string }>()
  if (!message || message.workspace_id !== caller.workspaceId) return []
  const { data: canRead, error } = await caller.supabase.rpc('team_chat_can_read', { ch: message.channel_id })
  if (error || canRead !== true) return []
  const { data } = await deps.svc
    .from('email_share')
    .select('id, created_at')
    .eq('team_chat_message_id', messageId)
    .order('created_at', { ascending: true })
    .limit(10)
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
}

// ── Share links (copied, pasted into a chat by hand) ────────────────────────

/** A new link token: 32 bytes from the CSPRNG, base64url (43 characters, 256 bits). */
export function newShareLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

export type ShareLinkResult = { ok: true; linkId: string; token: string; url: string; reused: boolean } | ShareFailure

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * Copy link: the caller's own thread's link, its message ids read live and
 * frozen now. An open link for the same thread and the same messages is
 * handed back again (one link per message set); a new reply since makes a
 * new link. It grants nothing until its owner pastes it in a chat.
 */
export async function createShareLink(
  deps: EmailShareDeps,
  caller: ShareCaller,
  input: Pick<ShareInput, 'indexId' | 'threadId' | 'accountId'>,
  newToken: () => string = newShareLinkToken,
): Promise<ShareLinkResult> {
  const thread = await ownThread(deps, caller, input)
  if (thread === 'not_owner') return NOT_OWNER
  if (!thread) return fail(404, 'not_found', 'Email not found')
  if (!thread.accountId) return fail(409, 'no_mailbox', 'Reconnect this mailbox to share from it')
  const mailbox = await deps.mailbox(caller.userId, thread.accountId, caller.workspaceId)
  if (!mailbox || mailbox.provider !== thread.provider) return fail(409, 'no_mailbox', 'This mailbox is disconnected. Reconnect it to share from it.')
  const messageIds = await deps.provider.threadIds(mailbox, thread.providerThreadId)
  if (!messageIds || messageIds.length === 0) return UNAVAILABLE
  const url = (token: string) => `${appUrl()}${emailShareLinkPath(token)}`

  const { data: open } = await deps.svc
    .from('email_share_link')
    .select('id, token, account_id, message_ids')
    .eq('owner_user_id', caller.userId)
    .eq('workspace_id', caller.workspaceId)
    .eq('provider_thread_id', thread.providerThreadId)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })
    .limit(20)
  const same = ((open ?? []) as Array<{ id: string; token: string; account_id: string | null; message_ids: string[] }>).find(
    (l) => l.account_id === thread.accountId && sameIds(l.message_ids, messageIds),
  )
  if (same) return { ok: true, linkId: same.id, token: same.token, url: url(same.token), reused: true }

  const token = newToken()
  const { data: link, error } = await deps.svc
    .from('email_share_link')
    .insert({
      token,
      workspace_id: caller.workspaceId,
      owner_user_id: caller.userId,
      account_id: thread.accountId,
      provider: thread.provider,
      provider_thread_id: thread.providerThreadId,
      thread_index_id: thread.indexId,
      message_ids: messageIds,
    })
    .select('id')
    .single<{ id: string }>()
  if (error || !link) return fail(500, 'failed', "Couldn't make a link")
  return { ok: true, linkId: link.id, token, url: url(token), reused: false }
}

/** Revoke a link (the owner's alone): it binds nothing from now on, and every share made from it ends at once. */
export async function revokeShareLink(deps: EmailShareDeps, caller: ShareCaller, linkId: string): Promise<{ ok: true; revokedShares: number } | ShareFailure> {
  if (!isUuid(linkId)) return NOT_FOUND
  const { data: link } = await deps.svc
    .from('email_share_link')
    .select('id, owner_user_id, workspace_id, revoked_at')
    .eq('id', linkId)
    .maybeSingle<{ id: string; owner_user_id: string; workspace_id: string; revoked_at: string | null }>()
  if (!link || link.workspace_id !== caller.workspaceId || link.owner_user_id !== caller.userId) return NOT_FOUND
  const at = new Date().toISOString()
  if (!link.revoked_at) {
    const { error } = await deps.svc.from('email_share_link').update({ revoked_at: at }).eq('id', linkId).is('revoked_at', null)
    if (error) return fail(500, 'failed', "Couldn't revoke the link")
  }
  const { data: ended, error } = await deps.svc.from('email_share').update({ revoked_at: at }).eq('link_id', linkId).is('revoked_at', null).select('id')
  if (error) return fail(500, 'failed', "Couldn't revoke the link")
  return { ok: true, revokedShares: (ended ?? []).length }
}

/** What a link's page shows the person opening it. */
export type ShareLinkPage =
  | { state: 'owner'; revoked: boolean; thread: Omit<EmailShareThreadView, 'id' | 'mine'> | null }
  | { state: 'shared'; thread: EmailShareThreadView }
  | { state: 'unavailable' }
  | { state: 'outside' }

/**
 * The link's page (/mail/s/<token>), for whoever opens it (signed in; their
 * own RLS client asks team chat's read rule). The owner: their thread's
 * frozen messages. A member of the link's workspace who may read a chat
 * where a live share from this link sits: that share, through the share
 * reader and its checks. Anyone else, an unknown token, or a revoked link
 * for anyone but its owner: 'outside', with nothing of the mail and nothing
 * about the link.
 */
export async function resolveShareLink(
  deps: EmailShareDeps,
  viewer: { supabase: SupabaseClient; userId: string },
  token: string,
  opts: { images?: boolean } = {},
): Promise<ShareLinkPage> {
  if (!isEmailShareLinkToken(token)) return { state: 'outside' }
  const { data: link } = await deps.svc
    .from('email_share_link')
    .select('id, workspace_id, owner_user_id, account_id, provider, provider_thread_id, message_ids, revoked_at')
    .eq('token', token)
    .maybeSingle<{ id: string; workspace_id: string; owner_user_id: string; account_id: string | null; provider: 'google' | 'microsoft'; provider_thread_id: string; message_ids: string[]; revoked_at: string | null }>()
  if (!link) return { state: 'outside' }
  const { data: member } = await deps.svc.from('member').select('id').eq('workspace_id', link.workspace_id).eq('user_id', viewer.userId).maybeSingle<{ id: string }>()
  if (!member) return { state: 'outside' }

  if (link.owner_user_id === viewer.userId) {
    const mailbox = link.account_id ? await deps.mailbox(link.owner_user_id, link.account_id, link.workspace_id) : null
    if (!mailbox || mailbox.provider !== link.provider) return { state: 'owner', revoked: !!link.revoked_at, thread: null }
    return { state: 'owner', revoked: !!link.revoked_at, thread: await readFrozen(deps, mailbox, link.provider_thread_id, link.message_ids, opts) }
  }
  if (link.revoked_at) return { state: 'outside' }

  const { data: shares } = await deps.svc
    .from('email_share')
    .select('id, channel_id, created_at')
    .eq('link_id', link.id)
    .eq('workspace_id', link.workspace_id)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })
    .limit(50)
  const caller: ShareCaller = { supabase: viewer.supabase, userId: viewer.userId, workspaceId: link.workspace_id, memberId: member.id }
  for (const share of (shares ?? []) as Array<{ id: string; channel_id: string }>) {
    const view = await readSharedThread(deps, caller, share.id, opts)
    if (!isFailure(view)) return { state: 'shared', thread: view }
    // Not readable by them (404): the next chat it sits in. Readable but gone: say so.
    if (view.status === 410) return { state: 'unavailable' }
  }
  return { state: 'outside' }
}

function isFailure(value: unknown): value is ShareFailure {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false
}
