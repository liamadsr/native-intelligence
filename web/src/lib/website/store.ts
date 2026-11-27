/**
 * website_site and website_change (migration 463), on the service client.
 * Every read and write names its workspace. Reads throw on a failed query
 * (the caller decides what the owner hears); a lost compare-and-swap is a
 * null, never a throw.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CHANGE_KINDS,
  CHANGE_STATES,
  FRAMEWORKS,
  OPEN_CHANGE_STATES,
  SITE_STATES,
  type ChangeKind,
  type ChangeState,
  type CheckResult,
  type SiteInspection,
  type SiteWiring,
  type WebsiteChange,
  type WebsiteSite,
  type WiringIntake,
} from './types'
import { isSiteProvider, type BuilderProvider, type StagedWrite } from './providers/types'

type Svc = SupabaseClient

const SITE_FIELDS_463 = 'id, workspace_id, connected_by, repo_full_name, default_branch, project_id, environment_id, site_url, framework, inspection, state, wired_at, created_at'
const CHANGE_FIELDS_463 =
  'id, workspace_id, site_id, kind, request, requested_by, state, agent_run_id, action_id, reverts_change_id, form_path, form_kind, replace_current, pr_number, pr_url, head_sha, preview_url, summary, approval_id, merge_sha, intake_key_hash, intake_key_prefix, intake_origins, check_nonce_hash, check_result, error, created_at, updated_at, merged_at, live_at'
// 724's columns (a site's builder, a builder change's write). Never the credentials: siteCredentials reads those alone.
const SITE_FIELDS = `${SITE_FIELDS_463}, provider, provider_site_id`
const CHANGE_FIELDS = `${CHANGE_FIELDS_463}, staged`

/** A database without migration 724 answers that one of its columns is missing. Pure. */
export function missing724(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  const msg = error.message ?? ''
  return /\b(provider|provider_site_id|staged|credentials_encrypted)\b/.test(msg) && (error.code === '42703' || error.code === 'PGRST204' || /column/i.test(msg))
}

type Answer = { data: unknown; error: { code?: string; message?: string } | null }

/**
 * A read with 724's columns, again with 463's alone when the database has no
 * 724 yet (migration 724's PROD ORDER: either order works).
 */
async function withFields(v2: string, v1: string, run: (fields: string) => PromiseLike<Answer>): Promise<Answer> {
  const first = await run(v2)
  return missing724(first.error) ? run(v1) : first
}
const siteRead = (run: (fields: string) => PromiseLike<Answer>) => withFields(SITE_FIELDS, SITE_FIELDS_463, run)
const changeRead = (run: (fields: string) => PromiseLike<Answer>) => withFields(CHANGE_FIELDS, CHANGE_FIELDS_463, run)

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
    wirings: wiringsOf(r.wirings),
    ...(r.builder && typeof r.builder === 'object' ? { builder: { name: String(r.builder.name ?? '').slice(0, 200), user: String(r.builder.user ?? '').slice(0, 100) } } : {}),
  }
}

/** The most wirings a site keeps (one per intake: the quote intake, and a form each). */
const WIRINGS_MAX = 6

function wiringsOf(v: unknown): SiteWiring[] {
  if (!Array.isArray(v)) return []
  const out: SiteWiring[] = []
  for (const w of v.slice(0, WIRINGS_MAX)) {
    if (!w || typeof w !== 'object') continue
    const r = w as Record<string, unknown>
    if ((r.intake !== 'quote' && r.intake !== 'form') || typeof r.keyHash !== 'string' || typeof r.changeId !== 'string') continue
    if (r.intake === 'form' && typeof r.formId !== 'string') continue
    out.push({ intake: r.intake, ...(r.intake === 'form' ? { formId: r.formId as string } : {}), keyHash: r.keyHash, changeId: r.changeId, formPath: typeof r.formPath === 'string' ? r.formPath : null })
  }
  return out
}

/** A wiring change's intake, from check_result's `intake` (see WebsiteChange.wiringIntake). Pure. */
function wiringIntakeOf(kind: ChangeKind, checkResult: unknown): WiringIntake | null {
  if (kind !== 'wire_form') return null
  const intake = checkResult && typeof checkResult === 'object' ? (checkResult as { intake?: { kind?: unknown; formId?: unknown } }).intake : null
  return intake?.kind === 'form' && typeof intake.formId === 'string' && intake.formId ? { kind: 'form', formId: intake.formId } : { kind: 'quote' }
}

/**
 * What a change's check_result is written as: the check, plus a form
 * wiring's intake (it lives in the same JSON, so every write of a check
 * keeps it). Pure.
 */
export function checkResultOf(change: Pick<WebsiteChange, 'wiringIntake'>, result: CheckResult | null): (CheckResult & { intake?: WiringIntake }) | null {
  const intake = change.wiringIntake?.kind === 'form' ? { intake: change.wiringIntake } : {}
  if (!result) return 'intake' in intake ? ({ ...intake } as CheckResult & { intake: WiringIntake }) : null
  return { ...result, ...intake }
}

/** Whether a site wiring is this intake's. Pure. */
export function sameIntake(w: Pick<SiteWiring, 'intake' | 'formId'>, intake: WiringIntake): boolean {
  return intake.kind === 'quote' ? w.intake === 'quote' : w.intake === 'form' && w.formId === intake.formId
}

/** The wirings live on a site: those recorded, else (a site wired before they were kept) its quote wiring. Pure. */
export function liveWirings(site: Pick<WebsiteSite, 'state' | 'inspection'>): SiteWiring[] {
  const kept = site.inspection?.wirings ?? []
  if (kept.length) return kept
  return site.state === 'wired' ? [{ intake: 'quote', keyHash: '', changeId: '', formPath: null }] : []
}

/** website_change.staged (724), when it has the shape a builder change writes. Pure. */
function stagedOf(v: unknown): StagedWrite | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Partial<StagedWrite>
  if (!isSiteProvider(r.provider) || r.provider === 'github' || !r.ref || typeof r.ref.id !== 'string') return null
  if (!r.before || !r.after || typeof r.before.body !== 'string' || typeof r.after.body !== 'string') return null
  if (typeof r.beforeHash !== 'string' || typeof r.afterHash !== 'string') return null
  return {
    provider: r.provider,
    ref: r.ref,
    before: { title: String(r.before.title ?? ''), body: r.before.body },
    after: { title: String(r.after.title ?? ''), body: r.after.body },
    beforeHash: r.beforeHash,
    afterHash: r.afterHash,
    edits: Array.isArray(r.edits) ? r.edits.filter((e) => e && typeof e.find === 'string' && typeof e.replace === 'string').slice(0, 10) : [],
    ...(r.written && typeof r.written === 'object' ? { written: r.written } : {}),
  }
}

export function toSite(r: Row): WebsiteSite {
  const state = (SITE_STATES as readonly string[]).includes(String(r.state)) ? (r.state as WebsiteSite['state']) : 'connected'
  const framework = (FRAMEWORKS as readonly string[]).includes(String(r.framework)) ? (r.framework as WebsiteSite['framework']) : null
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    connectedBy: String(r.connected_by),
    // A builder's site has no repo (724): '' never equals a repo's name.
    provider: isSiteProvider(r.provider) ? r.provider : 'github',
    providerSiteId: s(r.provider_site_id),
    repoFullName: s(r.repo_full_name) ?? '',
    defaultBranch: s(r.default_branch) ?? '',
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
  const kind: ChangeKind = (CHANGE_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as ChangeKind) : 'edit'
  const check = r.check_result && typeof r.check_result === 'object' && !Array.isArray(r.check_result) ? (r.check_result as Record<string, unknown>) : null
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    siteId: String(r.site_id),
    kind,
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
    wiringIntake: wiringIntakeOf(kind, check),
    checkNonceHash: s(r.check_nonce_hash),
    // A check_result holding only a form wiring's intake is no check yet.
    checkResult: check && typeof check.outcome === 'string' ? (check as unknown as CheckResult) : null,
    staged: stagedOf(r.staged),
    error: s(r.error),
    createdAt: String(r.created_at),
    updatedAt: s(r.updated_at),
    mergedAt: s(r.merged_at),
    liveAt: s(r.live_at),
  }
}

/** The workspace's live (not disconnected) site, or null. */
export async function getLiveSite(svc: Svc, workspaceId: string): Promise<WebsiteSite | null> {
  const { data, error } = await siteRead((f) => svc.from('website_site').select(f).eq('workspace_id', workspaceId).neq('state', 'disconnected').maybeSingle())
  if (error) throw new Error(`website_site read failed: ${error.message}`)
  return data ? toSite(data as Row) : null
}

export async function getSite(svc: Svc, workspaceId: string, siteId: string): Promise<WebsiteSite | null> {
  const { data, error } = await siteRead((f) => svc.from('website_site').select(f).eq('workspace_id', workspaceId).eq('id', siteId).maybeSingle())
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
    // The wirings are what reached the site, not what the repo says: a re-read keeps them.
    const kept = live.inspection?.wirings ?? []
    const { data, error } = await siteRead((f) => svc.from('website_site').update({ ...fields, inspection: { ...site.inspection, wirings: kept } }).eq('id', live.id).eq('workspace_id', site.workspaceId).select(f).single())
    if (error || !data) throw new Error(`website_site update failed: ${error?.message ?? 'no row'}`)
    return toSite(data as Row)
  }
  if (live) {
    const { error } = await svc.from('website_site').update({ state: 'disconnected', updated_at: new Date().toISOString() }).eq('id', live.id).eq('workspace_id', site.workspaceId)
    if (error) throw new Error(`website_site disconnect failed: ${error.message}`)
  }
  const { data, error } = await siteRead((f) =>
    svc
      .from('website_site')
      .insert({ workspace_id: site.workspaceId, repo_full_name: site.repoFullName, connected_by: site.connectedBy, state: 'connected', ...fields })
      .select(f)
      .single(),
  )
  if (error || !data) throw new Error(`website_site insert failed: ${error?.message ?? 'no row'}`)
  return toSite(data as Row)
}

export async function updateSite(
  svc: Svc,
  workspaceId: string,
  siteId: string,
  patch: Partial<{ project_id: string | null; environment_id: string | null; state: WebsiteSite['state']; wired_at: string | null; site_url: string | null; inspection: SiteInspection }>,
): Promise<void> {
  const { error } = await svc.from('website_site').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', siteId).eq('workspace_id', workspaceId)
  if (error) throw new Error(`website_site update failed: ${error.message}`)
}

/**
 * Whether the business's website posts to the live QUOTE intake key: a quote
 * wiring reached the site (a site wired before wirings were kept counts as
 * one), or the live key is one a merged wiring of its made live (its check
 * may not have passed, or may still be running). A site wired only to a
 * form doesn't. Throws on a failed read.
 */
export async function websiteUsesLiveKey(svc: Svc, workspaceId: string): Promise<boolean> {
  const site = await getLiveSite(svc, workspaceId)
  if (!site) return false
  if (liveWirings(site).some((w) => w.intake === 'quote')) return true
  const { data: key, error } = await svc.from('quote_intake_key').select('key_hash').eq('workspace_id', workspaceId).is('revoked_at', null).maybeSingle()
  if (error) throw new Error(`quote_intake_key read failed: ${error.message}`)
  const hash = (key as { key_hash?: string } | null)?.key_hash
  if (!hash) return false
  const { data, error: changeError } = await svc.from('website_change').select('id').eq('workspace_id', workspaceId).eq('intake_key_hash', hash).not('merged_at', 'is', null).limit(1)
  if (changeError) throw new Error(`website_change read failed: ${changeError.message}`)
  return ((data ?? []) as unknown[]).length > 0
}

/** Whether the business's website posts to this form (a form wiring reached it). Throws on a failed read. */
export async function websiteUsesForm(svc: Svc, workspaceId: string, formId: string): Promise<boolean> {
  const site = await getLiveSite(svc, workspaceId)
  return !!site && liveWirings(site).some((w) => sameIntake(w, { kind: 'form', formId }))
}

/**
 * The website's form no longer reaches this intake (its key or link was
 * replaced elsewhere; default the quote intake): that wiring is dropped, and
 * the site is back to connected once none is left. Throws on a failed write.
 */
export async function markSiteUnwired(svc: Svc, workspaceId: string, intake: WiringIntake = { kind: 'quote' }): Promise<void> {
  const site = await getLiveSite(svc, workspaceId)
  if (!site) return
  const kept = site.inspection?.wirings ?? []
  const left = kept.filter((w) => !sameIntake(w, intake))
  // A site wired before wirings were kept: its wiring was the quote intake's.
  const unwired = kept.length ? left.length === 0 : intake.kind === 'quote'
  if (left.length === kept.length && !unwired) return
  const { error } = await svc
    .from('website_site')
    .update({
      ...(unwired ? { state: 'connected', wired_at: null } : {}),
      ...(site.inspection && left.length !== kept.length ? { inspection: { ...site.inspection, wirings: left } } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', site.id)
    .eq('workspace_id', workspaceId)
  if (error) throw new Error(`website_site update failed: ${error.message}`)
}

/** A wiring change reached the site: its wiring recorded, replacing an older one of the same intake. Safe to repeat. Throws on a failed write. */
export async function recordSiteWiring(svc: Svc, change: Pick<WebsiteChange, 'id' | 'workspaceId' | 'siteId' | 'wiringIntake' | 'intakeKeyHash' | 'formPath'>): Promise<void> {
  if (!change.wiringIntake || !change.intakeKeyHash) return
  const site = await getSite(svc, change.workspaceId, change.siteId)
  if (!site?.inspection || site.state === 'disconnected') return
  const intake = change.wiringIntake
  const kept = site.inspection.wirings ?? []
  if (kept.some((w) => w.changeId === change.id && w.keyHash === change.intakeKeyHash)) return
  const wiring: SiteWiring = { intake: intake.kind, ...(intake.kind === 'form' ? { formId: intake.formId } : {}), keyHash: change.intakeKeyHash, changeId: change.id, formPath: change.formPath }
  // A site wired before wirings were kept had its quote wiring: kept as one, unless this one replaces it.
  const legacy: SiteWiring[] = !kept.length && site.state === 'wired' && intake.kind !== 'quote' ? [{ intake: 'quote', keyHash: '', changeId: '', formPath: null }] : []
  const wirings = [...legacy, ...kept.filter((w) => !sameIntake(w, intake)), wiring].slice(-WIRINGS_MAX)
  await updateSite(svc, change.workspaceId, site.id, { inspection: { ...site.inspection, wirings } })
}

/**
 * An undone wiring: its wiring dropped (its old form setup is back), and the
 * site back to connected once none is left. Throws on a failed write.
 */
export async function dropSiteWiring(svc: Svc, workspaceId: string, siteId: string, undone: Pick<WebsiteChange, 'id' | 'wiringIntake'>): Promise<void> {
  const site = await getSite(svc, workspaceId, siteId)
  if (!site) return
  const kept = site.inspection?.wirings ?? []
  // A quote wiring from before wirings were kept is the one with no change named.
  const left = kept.filter((w) => w.changeId !== undone.id && !(w.changeId === '' && w.intake === 'quote' && undone.wiringIntake?.kind !== 'form'))
  if (left.length) {
    if (left.length !== kept.length && site.inspection) await updateSite(svc, workspaceId, siteId, { inspection: { ...site.inspection, wirings: left } })
    return
  }
  await updateSite(svc, workspaceId, siteId, { state: 'connected', wired_at: null, ...(site.inspection && kept.length ? { inspection: { ...site.inspection, wirings: [] } } : {}) })
}

/** The site's open change (at most one), or null. */
export async function getOpenChange(svc: Svc, workspaceId: string, siteId: string): Promise<WebsiteChange | null> {
  const { data, error } = await changeRead((f) => svc.from('website_change').select(f).eq('workspace_id', workspaceId).eq('site_id', siteId).in('state', [...OPEN_CHANGE_STATES]).maybeSingle())
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

export async function getChange(svc: Svc, workspaceId: string, changeId: string): Promise<WebsiteChange | null> {
  const { data, error } = await changeRead((f) => svc.from('website_change').select(f).eq('workspace_id', workspaceId).eq('id', changeId).maybeSingle())
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

/** A change by its coding run (the outcome route's hook), or null. Any workspace: the run token names it. */
export async function getChangeByRun(svc: Svc, workspaceId: string, agentRunId: string): Promise<WebsiteChange | null> {
  const { data, error } = await changeRead((f) => svc.from('website_change').select(f).eq('workspace_id', workspaceId).eq('agent_run_id', agentRunId).maybeSingle())
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

/** The site's newest changes, newest first. */
export async function recentChanges(svc: Svc, workspaceId: string, siteId: string, limit = 5): Promise<WebsiteChange[]> {
  const { data, error } = await changeRead((f) => svc.from('website_change').select(f).eq('workspace_id', workspaceId).eq('site_id', siteId).order('created_at', { ascending: false }).limit(limit))
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
  /** A wiring's intake: a form's is kept in check_result (see WebsiteChange.wiringIntake). */
  wiringIntake?: WiringIntake | null
  prNumber?: number | null
  prUrl?: string | null
  /** A builder change's write (724). */
  staged?: StagedWrite | null
  headSha?: string | null
  summary?: string | null
}

export type InsertChangeResult = { ok: true; change: WebsiteChange } | { ok: false; code: 'OPEN_CHANGE'; open: WebsiteChange | null }

/** A new change; another one still open is a refusal (463's one-open index), never a throw. */
export async function insertChange(svc: Svc, change: NewChange): Promise<InsertChangeResult> {
  const row = {
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
      check_result: change.wiringIntake?.kind === 'form' ? { intake: change.wiringIntake } : null,
      pr_number: change.prNumber ?? null,
      pr_url: change.prUrl ?? null,
      // Only a builder change names 724's column: a GitHub change inserts as it did before 724.
      ...(change.staged ? { staged: change.staged } : {}),
      ...(change.headSha ? { head_sha: change.headSha } : {}),
      ...(change.summary ? { summary: change.summary.slice(0, 1000) } : {}),
  }
  const { data, error } = await changeRead((f) => svc.from('website_change').insert(row).select(f).single())
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
  check_result: (CheckResult & { intake?: WiringIntake }) | null
  error: string | null
  merged_at: string | null
  live_at: string | null
  /** 724: a builder change's write (its `written` once done). */
  staged: StagedWrite
}>

/**
 * Update a change; with `from`, only while it is in one of those states (a
 * compare-and-swap): null when another writer moved it first.
 */
export async function updateChange(svc: Svc, workspaceId: string, changeId: string, patch: ChangePatch, from?: readonly ChangeState[]): Promise<WebsiteChange | null> {
  const values = { ...patch, ...(patch.error ? { error: patch.error.slice(0, 1000) } : {}), ...(patch.summary ? { summary: patch.summary.slice(0, 1000) } : {}), updated_at: new Date().toISOString() }
  // A failed select fails the whole update (nothing is written), so the retry without 724's column is safe.
  const { data, error } = await changeRead((f) => {
    let query = svc.from('website_change').update(values).eq('id', changeId).eq('workspace_id', workspaceId)
    if (from?.length) query = query.in('state', [...from])
    return query.select(f)
  })
  if (error) throw new Error(`website_change update failed: ${error.message}`)
  const row = ((data ?? []) as Row[])[0]
  return row ? toChange(row) : null
}

/** The change whose live check carries this nonce hash (the intake's test post), or null. */
export async function getChangeByNonce(svc: Svc, workspaceId: string, nonceHash: string): Promise<WebsiteChange | null> {
  const { data, error } = await changeRead((f) => svc.from('website_change').select(f).eq('workspace_id', workspaceId).eq('check_nonce_hash', nonceHash).maybeSingle())
  if (error) throw new Error(`website_change read failed: ${error.message}`)
  return data ? toChange(data as Row) : null
}

const FORM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The wired forms that no longer take the site's posts: their link no longer hashes to the wiring's key (replaced since), or they are gone. Throws on a failed read. */
export async function replacedFormLinks(svc: Svc, workspaceId: string, wirings: ReadonlyArray<{ formId?: string; keyHash: string }>): Promise<Set<string>> {
  const wanted = wirings.filter((w): w is { formId: string; keyHash: string } => typeof w.formId === 'string' && FORM_ID_RE.test(w.formId))
  if (!wanted.length) return new Set()
  const { data, error } = await svc.from('data_form').select('id, key_hash').eq('workspace_id', workspaceId).in('id', wanted.map((w) => w.formId))
  if (error) throw new Error(`data_form read failed: ${error.message}`)
  const now = new Map(((data ?? []) as Array<{ id: string; key_hash: string | null }>).map((r) => [r.id, r.key_hash]))
  return new Set(wanted.filter((w) => now.get(w.formId) !== w.keyHash).map((w) => w.formId))
}

export interface NewBuilderSite {
  workspaceId: string
  connectedBy: string
  provider: BuilderProvider
  /** The builder's own name for the site (a WordPress site's REST root). */
  providerSiteId: string
  siteUrl: string
  /** The login, already encrypted (src/lib/crypto/credentials.ts); null for an OAuth builder (its token is in user_oauth_tokens). */
  credentialsEncrypted: string | null
  /** The site's and the login's names, for the owner's words. */
  name: string
  user: string
}

/**
 * Connect a builder site (724): the same builder site reconnected is updated
 * in place (its new login, its wirings kept); any other live site is
 * disconnected first, so the one-live-site index holds. Throws on a failed
 * write.
 */
export async function connectBuilderSite(svc: Svc, site: NewBuilderSite): Promise<WebsiteSite> {
  const live = await getLiveSite(svc, site.workspaceId)
  const now = new Date().toISOString()
  const same = !!live && live.provider === site.provider && live.providerSiteId === site.providerSiteId
  const inspection: SiteInspection = {
    framework: 'unknown',
    host: 'unknown',
    siteUrl: site.siteUrl,
    forms: [],
    truncated: false,
    builder: { name: site.name.slice(0, 200), user: site.user.slice(0, 100) },
    ...(same && live?.inspection?.wirings?.length ? { wirings: live.inspection.wirings } : {}),
  }
  const fields = { site_url: site.siteUrl, framework: null, inspection, credentials_encrypted: site.credentialsEncrypted, updated_at: now }
  if (same && live) {
    // Whoever connected it is who reconnected it only if it is them; otherwise the new login's owner takes it over (they approved on WordPress).
    const { data, error } = await svc.from('website_site').update({ ...fields, connected_by: site.connectedBy }).eq('id', live.id).eq('workspace_id', site.workspaceId).select(SITE_FIELDS).single()
    if (error || !data) throw new Error(`website_site update failed: ${error?.message ?? 'no row'}`)
    return toSite(data as Row)
  }
  if (live) {
    const { error } = await svc.from('website_site').update({ state: 'disconnected', updated_at: now }).eq('id', live.id).eq('workspace_id', site.workspaceId)
    if (error) throw new Error(`website_site disconnect failed: ${error.message}`)
  }
  const { data, error } = await svc
    .from('website_site')
    .insert({
      workspace_id: site.workspaceId,
      connected_by: site.connectedBy,
      provider: site.provider,
      provider_site_id: site.providerSiteId,
      repo_full_name: null,
      default_branch: null,
      state: 'connected',
      ...fields,
    })
    .select(SITE_FIELDS)
    .single()
  if (error || !data) throw new Error(`website_site insert failed: ${error?.message ?? 'no row'}`)
  return toSite(data as Row)
}

/** A builder site's stored login (724), still encrypted, or null. Server only. Throws on a failed read. */
export async function siteCredentials(svc: Svc, workspaceId: string, siteId: string): Promise<string | null> {
  const { data, error } = await svc.from('website_site').select('credentials_encrypted').eq('workspace_id', workspaceId).eq('id', siteId).maybeSingle()
  if (error) throw new Error(`website_site read failed: ${error.message}`)
  const v = (data as { credentials_encrypted?: unknown } | null)?.credentials_encrypted
  return typeof v === 'string' && v ? v : null
}
