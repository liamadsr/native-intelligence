/**
 * The read behind GET /api/account/email/agent-drafts (./agent-drafts.ts):
 * server-only, on the caller's RLS client. And the same drafts for the main
 * agent's list_bot_work (readAgentDraftsIn: Mail draft items, GEN-1165), on a
 * service client, fenced explicitly.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { OPEN_DRAFT_STATUSES } from '@/lib/crm/email-drafts'
import type { AgentDraft } from './agent-drafts'

/** The most drafts the column reads at once (newest first). */
export const AGENT_DRAFTS_READ = 50

const SELECT = 'id, workspace_id, subject, to_emails, provider_thread_id, provider_draft_id, created_at, email_thread:email_thread_id(folder)'

type Row = {
  id: string
  workspace_id: string
  subject: string | null
  to_emails: string[] | null
  provider_thread_id: string | null
  provider_draft_id: string | null
  created_at: string
  email_thread: { folder?: string | null } | Array<{ folder?: string | null }> | null
}

/** The caller's open automatic drafts, across their workspaces, newest first. Throws on a failed read. */
export async function readAgentDrafts(supabase: SupabaseClient, userId: string): Promise<AgentDraft[]> {
  const { data, error } = await openAgentDrafts(supabase, userId).order('created_at', { ascending: false }).limit(AGENT_DRAFTS_READ)
  if (error) throw new Error(`agent drafts read failed: ${error.message}`)
  return ((data ?? []) as unknown as Row[]).map(toAgentDraft)
}

/**
 * The same drafts in `workspaceIds` only (the caller's own workspaces, on any
 * client: every filter is explicit), at most `limit`, and how many there are
 * in all. Throws on a failed read.
 */
export async function readAgentDraftsIn(
  supabase: SupabaseClient,
  userId: string,
  workspaceIds: readonly string[],
  limit: number = AGENT_DRAFTS_READ,
): Promise<{ drafts: AgentDraft[]; total: number }> {
  if (!workspaceIds.length) return { drafts: [], total: 0 }
  const { data, error, count } = await openAgentDrafts(supabase, userId, { count: true })
    .in('workspace_id', [...workspaceIds])
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`agent drafts read failed: ${error.message}`)
  const drafts = ((data ?? []) as unknown as Row[]).map(toAgentDraft)
  return { drafts, total: Math.max(count ?? 0, drafts.length) }
}

/** The open automatic drafts of `userId` (the caller orders and caps them). */
function openAgentDrafts(supabase: SupabaseClient, userId: string, opts: { count?: boolean } = {}) {
  return supabase
    .from('email_draft')
    .select(SELECT, opts.count ? { count: 'exact' } : undefined)
    .eq('user_id', userId)
    .in('status', [...OPEN_DRAFT_STATUSES])
    .eq('metadata->>origin', 'automatic')
}

function toAgentDraft(r: Row): AgentDraft {
  const thread = Array.isArray(r.email_thread) ? r.email_thread[0] : r.email_thread
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    subject: r.subject?.trim() || null,
    to: Array.isArray(r.to_emails) && r.to_emails[0] ? r.to_emails[0] : null,
    provider_thread_id: r.provider_thread_id ?? null,
    provider_draft_id: r.provider_draft_id ?? null,
    folder: thread?.folder ?? null,
    created_at: r.created_at,
  }
}

