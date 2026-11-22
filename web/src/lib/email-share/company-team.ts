/**
 * A company's email, shared with the team (migration 680): the server half.
 *
 * Which threads a reader may see is the DATABASE's rule, asked of
 * company_team_email_threads with the reader named (the switch is on, the
 * thread's owner agreed for this company and is still a member, the thread
 * is not private, the reader can see the company, and the thread is with
 * someone at it). Nothing here widens it: every list, open and attachment
 * read asks that function first, with the caller's own user id, and reads
 * only what it answered.
 *
 * Mail is not stored. A thread's subject and messages are read live from the
 * OWNER's mailbox with the owner's token (the same mailbox check and provider
 * reads the mail shares use, ./service.ts), view only. A disconnected
 * mailbox or a gone thread reads as unavailable, never a partial leak.
 *
 * People only: the routes refuse device tokens (./http.ts refuseBearer). The
 * agent's company overview reads the same function for metadata (when, who,
 * how many), never a subject or a body (src/lib/crm/company-context.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { withLiveHeaders, type ThreadHeader } from '@/lib/email/thread-headers'
import { isUuid } from '@/lib/team-chat/types'
import { defaultEmailShareDeps, type EmailShareDeps } from './service'
import type { ShareMailbox, SharedAttachmentFile } from './provider'
import type { EmailShareMessage } from './types'

export interface CompanyTeamDeps {
  mailbox: EmailShareDeps['mailbox']
  provider: Pick<EmailShareDeps['provider'], 'threadIds' | 'message' | 'attachment'>
  /** The live headers of one owner's rows (subject, preview). Tests pass their own. */
  headers: (svc: SupabaseClient, args: { userId: string; workspaceId: string; rows: TeamThreadRow[] }) => Promise<Array<TeamThreadRow & ThreadHeader>>
}

export function defaultCompanyTeamDeps(): CompanyTeamDeps {
  const d = defaultEmailShareDeps()
  return {
    mailbox: d.mailbox,
    provider: { threadIds: d.provider.threadIds, message: d.provider.message, attachment: d.provider.attachment },
    headers: (svc, args) => withLiveHeaders(svc, args),
  }
}

/** What the database answers for one thread: ids, flags and the team on it. */
export interface TeamThreadRow {
  id: string
  owner_user_id: string
  owner_member_id: string
  account_id: string | null
  provider: 'google' | 'microsoft'
  provider_thread_id: string
  provider_message_id: string | null
  folder: string | null
  last_message_at: string | null
  from_email: string | null
  message_count: number | null
  has_attachments: boolean
  team_member_ids: string[]
}

interface RpcRow extends Omit<TeamThreadRow, 'id'> {
  thread_index_id: string
}

export interface TeamCaller {
  userId: string
  workspaceId: string
  /** false on a turn that may not use grants (a guest's, a linked agent's). */
  grants?: boolean
}

/** The fenced rows, newest first (the database decides which). */
export async function fencedTeamThreads(
  svc: SupabaseClient,
  companyId: string,
  caller: TeamCaller,
  opts: { limit?: number; threadIndexId?: string | null } = {},
): Promise<TeamThreadRow[]> {
  if (!isUuid(companyId) || !isUuid(caller.userId)) return []
  const { data, error } = await svc.rpc('company_team_email_threads', {
    p_company_id: companyId,
    p_user_id: caller.userId,
    p_grants: caller.grants !== false,
    p_limit: opts.limit ?? 50,
    p_thread_index_id: opts.threadIndexId ?? null,
  })
  if (error) {
    console.warn('[company-team-email] fence read failed:', error.message)
    return []
  }
  return ((data ?? []) as RpcRow[]).map(({ thread_index_id, ...r }) => ({ ...r, id: thread_index_id, team_member_ids: r.team_member_ids ?? [] }))
}

export interface SharingStatus {
  enabled: boolean
  changed_by_member_id: string | null
  changed_at: string | null
  my_consent: boolean
  sharers: Array<{ member_id: string; display_name: string | null; since: string }>
}

/** The switch, my consent and who shares; null when the caller can't see the company. */
export async function companySharingStatus(svc: SupabaseClient, companyId: string, caller: TeamCaller): Promise<SharingStatus | null> {
  if (!isUuid(companyId)) return null
  const { data, error } = await svc.rpc('company_email_sharing_status', {
    p_company_id: companyId,
    p_user_id: caller.userId,
    p_grants: caller.grants !== false,
  })
  if (error || !data) return null
  return data as SharingStatus
}

export interface TeamThreadListItem {
  id: string
  subject: string | null
  snippet: string | null
  from_name: string | null
  from_email: string | null
  last_message_at: string | null
  message_count: number | null
  has_attachments: boolean
  shared_by: { member_id: string; name: string }
  team: Array<{ member_id: string; name: string }>
  mine: boolean
}

/** Members' names, for "who shared" and "who was on it". */
async function memberNames(svc: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const { data } = await svc.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', ids)
  return new Map(((data ?? []) as Array<{ id: string; display_name: string | null }>).map((m) => [m.id, m.display_name?.trim() || 'A teammate']))
}

/**
 * The company page's list: the fenced threads, each with its subject read
 * live from its owner's mailbox (a row whose mailbox no longer reads here is
 * left out), who shared it and who on the team was on it.
 */
export async function listCompanyTeamThreads(
  svc: SupabaseClient,
  companyId: string,
  caller: TeamCaller,
  deps: CompanyTeamDeps = defaultCompanyTeamDeps(),
  opts: { limit?: number } = {},
): Promise<TeamThreadListItem[]> {
  const rows = await fencedTeamThreads(svc, companyId, caller, { limit: opts.limit ?? 30 })
  if (!rows.length) return []

  // Only mailboxes that still read in this workspace, checked once per account.
  const readable = new Map<string, boolean>()
  for (const r of rows) {
    const key = `${r.owner_user_id}:${r.account_id}`
    if (readable.has(key) || !r.account_id) continue
    const mailbox = await deps.mailbox(r.owner_user_id, r.account_id, caller.workspaceId).catch(() => null)
    readable.set(key, !!mailbox && mailbox.provider === r.provider)
  }
  const live = rows.filter((r) => r.account_id && readable.get(`${r.owner_user_id}:${r.account_id}`))

  // Subjects, one batch per owner.
  const byOwner = new Map<string, TeamThreadRow[]>()
  for (const r of live) byOwner.set(r.owner_user_id, [...(byOwner.get(r.owner_user_id) ?? []), r])
  const headers = new Map<string, ThreadHeader>()
  for (const [owner, list] of byOwner) {
    try {
      const got = await deps.headers(svc, { userId: owner, workspaceId: caller.workspaceId, rows: list })
      for (const g of got) headers.set(g.id, { subject: g.subject, snippet: g.snippet, from_name: g.from_name })
    } catch {
      // No headers for this owner: the rows show without a subject.
    }
  }

  const names = await memberNames(svc, caller.workspaceId, [...new Set(live.flatMap((r) => [r.owner_member_id, ...r.team_member_ids]))])
  const nameOf = (id: string) => names.get(id) ?? 'A teammate'
  return live.map((r) => {
    const h = headers.get(r.id)
    return {
      id: r.id,
      subject: h?.subject ?? null,
      snippet: h?.snippet ?? null,
      from_name: h?.from_name ?? null,
      from_email: r.from_email,
      last_message_at: r.last_message_at,
      message_count: r.message_count,
      has_attachments: r.has_attachments,
      shared_by: { member_id: r.owner_member_id, name: nameOf(r.owner_member_id) },
      team: r.team_member_ids.map((id) => ({ member_id: id, name: nameOf(id) })),
      mine: r.owner_user_id === caller.userId,
    }
  })
}

/** The most messages one open reads (the newest). */
export const TEAM_THREAD_MAX_MESSAGES = 50
const READ_CONCURRENCY = 4

export type TeamThreadRead =
  | { state: 'available'; thread: { id: string; subject: string; messages: EmailShareMessage[]; mine: boolean; shared_by: string } }
  | { state: 'not_found' }
  | { state: 'unavailable' }

async function mailboxFor(deps: CompanyTeamDeps, row: TeamThreadRow, workspaceId: string): Promise<ShareMailbox | null> {
  if (!row.account_id) return null
  const mailbox = await deps.mailbox(row.owner_user_id, row.account_id, workspaceId)
  return mailbox && mailbox.provider === row.provider ? mailbox : null
}

/** One fenced thread, read live from its owner's mailbox, view only. */
export async function readCompanyTeamThread(
  svc: SupabaseClient,
  companyId: string,
  threadIndexId: string,
  caller: TeamCaller,
  deps: CompanyTeamDeps = defaultCompanyTeamDeps(),
): Promise<TeamThreadRead> {
  if (!isUuid(threadIndexId)) return { state: 'not_found' }
  const [row] = await fencedTeamThreads(svc, companyId, caller, { threadIndexId, limit: 1 })
  if (!row) return { state: 'not_found' }
  const mailbox = await mailboxFor(deps, row, caller.workspaceId)
  if (!mailbox) return { state: 'unavailable' }
  const ids = await deps.provider.threadIds(mailbox, row.provider_thread_id)
  if (!ids || !ids.length) return { state: 'unavailable' }
  const wanted = ids.slice(-TEAM_THREAD_MAX_MESSAGES)
  const read: Array<EmailShareMessage | null> = []
  for (let i = 0; i < wanted.length; i += READ_CONCURRENCY) {
    read.push(...(await Promise.all(wanted.slice(i, i + READ_CONCURRENCY).map((id) => deps.provider.message(mailbox, id, row.provider_thread_id, { images: false })))))
  }
  const messages = read.filter((m): m is EmailShareMessage => !!m)
  if (!messages.length) return { state: 'unavailable' }
  const names = await memberNames(svc, caller.workspaceId, [row.owner_member_id])
  return {
    state: 'available',
    thread: {
      id: row.id,
      subject: messages[0].subject || '(no subject)',
      messages,
      mine: row.owner_user_id === caller.userId,
      shared_by: names.get(row.owner_member_id) ?? 'A teammate',
    },
  }
}

export type TeamAttachmentRead = { state: 'file'; file: SharedAttachmentFile } | { state: 'not_found' } | { state: 'unavailable' }

/**
 * One attachment of a fenced thread: the thread must still be in the
 * reader's set, the message one the thread holds now (live), and the key one
 * that message lists (the provider checks it, with the size cap).
 */
export async function readCompanyTeamAttachment(
  svc: SupabaseClient,
  input: { companyId: string; threadIndexId: string; messageId: string; key: string },
  caller: TeamCaller,
  deps: CompanyTeamDeps = defaultCompanyTeamDeps(),
): Promise<TeamAttachmentRead> {
  if (!isUuid(input.threadIndexId) || !input.messageId || !input.key || input.key.length > 512 || input.messageId.length > 512) return { state: 'not_found' }
  const [row] = await fencedTeamThreads(svc, input.companyId, caller, { threadIndexId: input.threadIndexId, limit: 1 })
  if (!row) return { state: 'not_found' }
  const mailbox = await mailboxFor(deps, row, caller.workspaceId)
  if (!mailbox) return { state: 'unavailable' }
  const ids = await deps.provider.threadIds(mailbox, row.provider_thread_id)
  if (!ids || !ids.includes(input.messageId)) return { state: 'not_found' }
  const file = await deps.provider.attachment(mailbox, input.messageId, row.provider_thread_id, input.key)
  return file ? { state: 'file', file } : { state: 'not_found' }
}
