/**
 * website_site and website_change (migration 463), on the service client.
 * Every read and write names its workspace. Reads throw on a failed query
 * (the caller decides what the owner hears); a lost compare-and-swap is a
 * null, never a throw.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CHANGE_KINDS, CHANGE_STATES, FRAMEWORKS, OPEN_CHANGE_STATES, SITE_STATES, type ChangeKind, type ChangeState, type CheckResult, type SiteInspection, type WebsiteChange, type WebsiteSite } from './types'

type Svc = SupabaseClient

const SITE_FIELDS = 'id, workspace_id, connected_by, repo_full_name, default_branch, project_id, environment_id, site_url, framework, inspection, state, wired_at, created_at'
const CHANGE_FIELDS =
  'id, workspace_id, site_id, kind, request, requested_by, state, agent_run_id, action_id, reverts_change_id, form_path, form_kind, replace_current, pr_number, pr_url, head_sha, preview_url, summary, approval_id, merge_sha, intake_key_hash, intake_key_prefix, intake_origins, check_nonce_hash, check_result, error, created_at, updated_at, merged_at, live_at'

type Row = Record<string, unknown>

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function inspectionOf(v: unknown): SiteInspection | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Partial<SiteInspection>
  if (!r.framework || !(FRAMEWORKS as readonly string[]).includes(r.framework)) return null
  // The other origins the site answers at: https origins only (they become the form's allowed origins).
  const alsoUrls = Array.isArray(r.alsoUrls) ? r.alsoUrls.filter((u): u is string => typeof u === 'string' && /^https:\/\/[^/\s]+$/.test(u)).slice(0, 6) : []
  return {
    framework: r.framework,
    host: r.host ?? 'unknown',
    siteUrl: r.siteUrl ?? null,
    forms: Array.isArray(r.forms) ? r.forms : [],
    truncated: r.truncated === true,
    buildScript: typeof r.buildScript === 'string' ? r.buildScript.slice(0, 600) : null,
    alsoUrls,
  }
}

export function toSite(r: Row): WebsiteSite {
  const state = (SITE_STATES as readonly string[]).includes(String(r.state)) ? (r.state as WebsiteSite['state']) : 'connected'
  const framework = (FRAMEWORKS as readonly string[]).includes(String(r.framework)) ? (r.framework as WebsiteSite['framework']) : null
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    connectedBy: String(r.connected_by),
    repoFullName: String(r.repo_full_name),
    defaultBranch: String(r.default_branch),
    projectId: s(r.project_id),
    environmentId: s(r.environment_id),
    siteUrl: s(r.site_url),
    framework,
    inspection: inspectionOf(r.inspection),
    state,
    wiredAt: s(r.wired_at),
    createdAt: String(r.created_at),
  }
}

export function toChange(r: Row): WebsiteChange {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    siteId: String(r.site_id),
    kind: (CHANGE_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as ChangeKind) : 'edit',
    request: String(r.request ?? ''),
    requestedBy: String(r.requested_by),
    state: (CHANGE_STATES as readonly string[]).includes(String(r.state)) ? (r.state as ChangeState) : 'failed',
    agentRunId: s(r.agent_run_id),
    actionId: s(r.action_id),
    revertsChangeId: s(r.reverts_change_id),
    formPath: s(r.form_path),
    formKind: ['quote', 'booking', 'contact', 'other'].includes(String(r.form_kind)) ? (r.form_kind as WebsiteChange['formKind']) : null,
    replaceCurrent: r.replace_current === true,
    prNumber: typeof r.pr_number === 'number' ? r.pr_number : null,
    prUrl: s(r.pr_url),
    headSha: s(r.head_sha),
    previewUrl: s(r.preview_url),
    summary: s(r.summary),
    approvalId: s(r.approval_id),
    mergeSha: s(r.merge_sha),
    intakeKeyHash: s(r.intake_key_hash),
    intakeKeyPrefix: s(r.intake_key_prefix),
    intakeOrigins: Array.isArray(r.intake_origins) ? (r.intake_origins as unknown[]).filter((o): o is string => typeof o === 'string') : [],
    checkNonceHash: s(r.check_nonce_hash),
    checkResult: r.check_result && typeof r.check_result === 'object' ? (r.check_result as CheckResult) : null,
    error: s(r.error),
    createdAt: String(r.created_at),
    updatedAt: s(r.updated_at),
    mergedAt: s(r.merged_at),
    liveAt: s(r.live_at),
  }
}

/** The workspace's live (not disconnected) site, or null. */
export async function getLiveSite(svc: Svc, workspaceId: string): Promise<WebsiteSite | null> {
  const { data, error } = await svc.from('website_site').select(SITE_FIELDS).eq('workspace_id', workspaceId).neq('state', 'disconnected').maybeSingle()
  if (error) throw new Error(`website_site read failed: ${error.message}`)
  return data ? toSite(data as Row) : null
}

export async function getSite(svc: Svc, workspaceId: string, siteId: string): Promise<WebsiteSite | null> {
  const { data, error } = await svc.from('website_site').select(SITE_FIELDS).eq('workspace_id', workspaceId).eq('id', siteId).maybeSingle()
  if (error) throw new Error(`website_site read failed: ${error.message}`)
  return data ? toSite(data as Row) : null
}

export interface NewSite {
  workspaceId: string
  connectedBy: string
  repoFullName: string
  defaultBranch: string
  siteUrl: string | null
  inspection: SiteInspection
}

/**
 * Connect a site: the workspace's live one is replaced (disconnected first,
 * so the one-live-site index holds), unless it is the same repo, which is
 * re-inspected in place. Throws on a failed write.
 */
export async function connectSite(svc: Svc, site: NewSite): Promise<WebsiteSite> {
  const live = await getLiveSite(svc, site.workspaceId)
  const fields = {
    default_branch: site.defaultBranch,
    site_url: site.siteUrl,
    framework: site.inspection.framework,
    inspection: site.inspection,
    updated_at: new Date().toISOString(),
  }
  if (live && live.repoFullName.toLowerCase() === site.repoFullName.toLowerCase()) {
    // Re-read in place: whoever connected it still does (an admin's edit never takes it over; its pull requests stay theirs).
    const { data, error } = await svc.from('website_site').update(fields).eq('id', live.id).eq('workspace_id', site.workspaceId).select(SITE_FIELDS).single()
    if (error || !data) throw new Error(`website_site update failed: ${error?.message ?? 'no row'}`)
    return toSite(data as Row)
  }
  if (live) {
    const { error } = await svc.from('website_site').update({ state: 'disconnected', updated_at: new Date().toISOString() }).eq('id', live.id).eq('workspace_id', site.workspaceId)
    if (error) throw new Error(`website_site disconnect failed: ${error.message}`)
  }
  const { data, error } = await svc
    .from('website_site')
    .insert({ workspace_id: site.workspaceId, repo_full_name: site.repoFullName, connected_by: site.connectedBy, state: 'connected', ...fields })
    .select(SITE_FIELDS)
    .single()
  if (error || !data) throw new Error(`website_site insert failed: ${error?.message ?? 'no row'}`)
  return toSite(data as Row)
}

export async function updateSite(svc: Svc, workspaceId: string, siteId: string, patch: Partial<{ project_id: string | null; environment_id: string | null; state: WebsiteSite['state']; wired_at: string | null; site_url: string | null }>): Promise<void> {
  const { error } = await svc.from('website_site').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', siteId).eq('workspace_id', workspaceId)
  if (error) throw new Error(`website_site update failed: ${error.message}`)
}

/**
 * Whether the business's website posts to the live intake key: the site is
 * wired, or the live key is one a merged wiring of its made live (its check
 * may not have passed, or may still be running). Throws on a failed read.
 */
export async function websiteUsesLiveKey(svc: Svc, workspaceId: string): Promise<boolean> {
  const site = await getLiveSite(svc, workspaceId)
  if (!site) return false
  if (site.state === 'wired') return true
  const { data: key, error } = await svc.from('quote_intake_key').select('key_hash').eq('workspace_id', workspaceId).is('revoked_at', null).maybeSingle()
  if (error) throw new Error(`quote_intake_key read failed: ${error.message}`)
  const hash = (key as { key_hash?: string } | null)?.key_hash
  if (!hash) return false
  const { data, error: changeError } = await svc.from('website_change').select('id').eq('workspace_id', workspaceId).eq('intake_key_hash', hash).not('merged_at', 'is', null).limit(1)
  if (changeError) throw new Error(`website_change read failed: ${changeError.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

/** The website's form no longer reaches the business (its key was replaced elsewhere): back to connected. */
export async function markSiteUnwired(svc: Svc, workspaceId: string): Promise<void> {
  const { error } = await svc.from('website_site').update({ state: 'connected', wired_at: null, updated_at: new Date().toISOString() }).eq('workspace_id', workspaceId).neq('state', 'disconnected')
  if (error) throw new Error(`website_site update failed: ${error.message}`)
}

/** The site's open change (at most one), or null. */
export async function getOpenChange(svc: Svc, workspaceId: string, siteId: string): Promise<WebsiteChange | null> {
  const { data, error } = await svc.from('website_change').select(CHANGE_FIELDS).eq('workspace_id', workspaceId).eq('site_id', siteId).in('state', [...OPEN_CHANGE_STATES]).maybeSingle()
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

export async function getChange(svc: Svc, workspaceId: string, changeId: string): Promise<WebsiteChange | null> {
  const { data, error } = await svc.from('website_change').select(CHANGE_FIELDS).eq('workspace_id', workspaceId).eq('id', changeId).maybeSingle()
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

/** A change by its coding run (the outcome route's hook), or null. Any workspace: the run token names it. */
export async function getChangeByRun(svc: Svc, workspaceId: string, agentRunId: string): Promise<WebsiteChange | null> {
  const { data, error } = await svc.from('website_change').select(CHANGE_FIELDS).eq('workspace_id', workspaceId).eq('agent_run_id', agentRunId).maybeSingle()
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

/** The site's newest changes, newest first. */
export async function recentChanges(svc: Svc, workspaceId: string, siteId: string, limit = 5): Promise<WebsiteChange[]> {
  const { data, error } = await svc.from('website_change').select(CHANGE_FIELDS).eq('workspace_id', workspaceId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return ((data ?? []) as Row[]).map(toChange)
}

export interface NewChange {
  workspaceId: string
  siteId: string
  kind: ChangeKind
  request: string
  requestedBy: string
  state?: ChangeState
  revertsChangeId?: string | null
  formPath?: string | null
  formKind?: WebsiteChange['formKind']
  replaceCurrent?: boolean
  intakeKeyHash?: string | null
  intakeKeyPrefix?: string | null
  intakeOrigins?: string[]
  prNumber?: number | null
  prUrl?: string | null
}

export type InsertChangeResult = { ok: true; change: WebsiteChange } | { ok: false; code: 'OPEN_CHANGE'; open: WebsiteChange | null }

/** A new change; another one still open is a refusal (463's one-open index), never a throw. */
export async function insertChange(svc: Svc, change: NewChange): Promise<InsertChangeResult> {
  const { data, error } = await svc
    .from('website_change')
    .insert({
      workspace_id: change.workspaceId,
      site_id: change.siteId,
      kind: change.kind,
      request: change.request.slice(0, 16_000),
      requested_by: change.requestedBy,
      state: change.state ?? 'preparing',
      reverts_change_id: change.revertsChangeId ?? null,
      form_path: change.formPath ?? null,
      form_kind: change.formKind ?? null,
      replace_current: change.replaceCurrent === true,
      intake_key_hash: change.intakeKeyHash ?? null,
      intake_key_prefix: change.intakeKeyPrefix ?? null,
      intake_origins: change.intakeOrigins ?? [],
      pr_number: change.prNumber ?? null,
      pr_url: change.prUrl ?? null,
    })
    .select(CHANGE_FIELDS)
    .single()
  if (error) {
    if (error.code === '23505') return { ok: false, code: 'OPEN_CHANGE', open: await getOpenChange(svc, change.workspaceId, change.siteId).catch(() => null) }
    throw new Error(`website_change insert failed: ${error.message}`)
  }
  return { ok: true, change: toChange(data as Row) }
}

export type ChangePatch = Partial<{
  state: ChangeState
  agent_run_id: string | null
  action_id: string | null
  pr_number: number | null
  pr_url: string | null
  head_sha: string | null
  preview_url: string | null
  summary: string | null
  approval_id: string | null
  merge_sha: string | null
  check_nonce_hash: string | null
  check_result: CheckResult | null
  error: string | null
  merged_at: string | null
  live_at: string | null
}>

/**
 * Update a change; with `from`, only while it is in one of those states (a
 * compare-and-swap): null when another writer moved it first.
 */
export async function updateChange(svc: Svc, workspaceId: string, changeId: string, patch: ChangePatch, from?: readonly ChangeState[]): Promise<WebsiteChange | null> {
  let query = svc
    .from('website_change')
    .update({ ...patch, ...(patch.error ? { error: patch.error.slice(0, 1000) } : {}), ...(patch.summary ? { summary: patch.summary.slice(0, 1000) } : {}), updated_at: new Date().toISOString() })
    .eq('id', changeId)
    .eq('workspace_id', workspaceId)
  if (from?.length) query = query.in('state', [...from])
  const { data, error } = await query.select(CHANGE_FIELDS)
  if (error) throw new Error(`website_change update failed: ${error.message}`)
  const row = ((data ?? []) as Row[])[0]
  return row ? toChange(row) : null
}

/** The change whose live check carries this nonce hash (the intake's test post), or null. */
export async function getChangeByNonce(svc: Svc, workspaceId: string, nonceHash: string): Promise<WebsiteChange | null> {
  const { data, error } = await svc.from('website_change').select(CHANGE_FIELDS).eq('workspace_id', workspaceId).eq('check_nonce_hash', nonceHash).maybeSingle()
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}
