/**
 * Starting, stopping and deleting a site audit: the one core behind the SEO
 * page's routes and the agent's tools, so both follow the same rules.
 *
 *   - Any member of the workspace may audit a site. It costs nothing but our
 *     own polite requests to a public website.
 *   - No site named means the workspace's own (src/lib/seo/site.ts).
 *   - One audit at a time per workspace: a second start while one is queued
 *     or running is refused with the live one's id, not queued behind it.
 *     The check and the insert are one database function under a lock per
 *     workspace (seo_audit_start, migration 590), so two starts at once
 *     can't both get in.
 *   - At most AUDIT_STARTS_PER_DAY starts per workspace in any 24 hours.
 *   - The start only writes the row and sends the event. The crawl runs in
 *     the background lane (src/lib/inngest/seo-audit-functions.ts).
 */
import {
  inngest,
  SEO_AUDIT_CANCEL,
  SEO_AUDIT_REQUESTED,
} from '@/lib/inngest/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { workspaceSiteUrl } from '../site'
import { AUDIT_STARTS_PER_DAY, clampAuditPages } from './limits'
import { getSiteAudit } from './queries'
import { normalizeStartUrl, StartUrlError } from './start-url'
import { createAuditStore } from './store'
import { isLiveAudit, type SiteAuditView } from './view'

export type StartAuditFailure =
  | { ok: false; code: 'NO_SITE'; message: string }
  | { ok: false; code: 'INVALID_URL' | 'NOT_PUBLIC'; message: string }
  | {
      ok: false
      code: 'AUDIT_ALREADY_RUNNING'
      message: string
      audit: SiteAuditView
    }
  | { ok: false; code: 'AUDIT_LIMIT_REACHED'; message: string }
  | { ok: false; code: 'START_FAILED'; message: string }

export type StartAuditResult =
  | { ok: true; audit: SiteAuditView }
  | StartAuditFailure

export interface StartAuditDeps {
  /** Sends the lane's event (tests). */
  send?: (event: {
    name: string
    data: Record<string, unknown>
  }) => Promise<unknown>
}

export async function startSiteAudit(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string },
  input: { url?: string | null; maxPages?: unknown },
  deps: StartAuditDeps = {},
): Promise<StartAuditResult> {
  const typed =
    typeof input.url === 'string' && input.url.trim() ? input.url.trim() : null
  const address = typed ?? (await workspaceSiteUrl(svc, who.workspaceId))
  if (!address) {
    return {
      ok: false,
      code: 'NO_SITE',
      message: 'Which website? Give its address (for example example.com).',
    }
  }

  let startUrl: string
  try {
    startUrl = normalizeStartUrl(address)
  } catch (err) {
    if (err instanceof StartUrlError)
      return { ok: false, code: err.code, message: err.message }
    throw err
  }

  const startFailed: StartAuditFailure = {
    ok: false,
    code: 'START_FAILED',
    message: 'Could not start the audit just now. Try again in a moment.',
  }
  const { data, error } = await svc.rpc('seo_audit_start', {
    p_workspace: who.workspaceId,
    p_started_by: who.userId,
    p_start_url: startUrl,
    p_origin: new URL(startUrl).origin,
    p_max_pages: clampAuditPages(input.maxPages),
    p_daily_limit: AUDIT_STARTS_PER_DAY,
  })
  const started = (Array.isArray(data) ? data[0] : data) as
    | { outcome: 'started' | 'live' | 'limit'; audit_id: string | null }
    | null
    | undefined
  if (error || !started) {
    console.error('[seo-audit] start: insert failed', error?.message)
    return startFailed
  }
  if (started.outcome === 'limit') {
    return {
      ok: false,
      code: 'AUDIT_LIMIT_REACHED',
      message: `This workspace has started ${AUDIT_STARTS_PER_DAY} audits in the last 24 hours, the most it can. Try again tomorrow.`,
    }
  }
  const row = started.audit_id
    ? await getSiteAudit(svc, who.workspaceId, started.audit_id)
    : null
  if (started.outcome === 'live' && row) {
    return {
      ok: false,
      code: 'AUDIT_ALREADY_RUNNING',
      message: `An audit of ${row.host} is still running. It has to finish, or be stopped, before another starts.`,
      audit: row,
    }
  }
  if (started.outcome !== 'started' || !row) {
    console.error('[seo-audit] start: no audit row', started)
    return startFailed
  }
  const audit = row

  try {
    const send = deps.send ?? ((event) => inngest.send(event))
    await send({
      name: SEO_AUDIT_REQUESTED,
      data: { auditId: audit.id, workspaceId: who.workspaceId },
    })
  } catch (err) {
    // The row exists but nothing will ever run it: say so on the row, so it never sits at "queued".
    console.error('[seo-audit] start: event send failed', err)
    await svc
      .from('seo_audit')
      .update({
        status: 'failed',
        error_code: 'START_FAILED',
        error_detail: 'The audit could not be started. Run it again.',
        completed_at: new Date().toISOString(),
      })
      .eq('id', audit.id)
      .eq('workspace_id', who.workspaceId)
    return startFailed
  }
  return { ok: true, audit }
}

export type SettleAuditResult =
  | { ok: true; audit: SiteAuditView }
  | {
      ok: false
      code: 'NOT_FOUND' | 'NOT_RUNNING' | 'STILL_RUNNING'
      message: string
    }

/** Stop a queued or running audit. What it already found stays readable. */
export async function cancelSiteAudit(
  svc: SupabaseClient,
  who: { workspaceId: string },
  auditId: string,
  deps: StartAuditDeps = {},
): Promise<SettleAuditResult> {
  const audit = await getSiteAudit(svc, who.workspaceId, auditId)
  if (!audit)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That audit doesn’t exist.',
    }
  if (!isLiveAudit(audit.status))
    return {
      ok: false,
      code: 'NOT_RUNNING',
      message: 'That audit already ended.',
    }

  // The status first: it is what a chunk in flight reads when it ends, and
  // what stops the next one from starting.
  const { error } = await svc
    .from('seo_audit')
    .update({
      status: 'canceled',
      // Only the crawl read it: the site's own text is not kept past the audit.
      robots_txt: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', auditId)
    .eq('workspace_id', who.workspaceId)
    .in('status', ['queued', 'running'])
  if (error) throw new Error(`seo audit cancel failed: ${error.message}`)

  try {
    const send = deps.send ?? ((event) => inngest.send(event))
    await send({ name: SEO_AUDIT_CANCEL, data: { auditId } })
  } catch (err) {
    // The status alone already stops the crawl at its next chunk.
    console.error('[seo-audit] cancel: event send failed', err)
  }
  await createAuditStore(svc)
    .clearCrawlTables(auditId)
    .catch((err) => console.error('[seo-audit] cancel: cleanup failed', err))

  const settled = await getSiteAudit(svc, who.workspaceId, auditId)
  return { ok: true, audit: settled ?? { ...audit, status: 'canceled' } }
}

/** Delete an audit that has ended, with its pages and findings. */
export async function deleteSiteAudit(
  svc: SupabaseClient,
  who: { workspaceId: string },
  auditId: string,
): Promise<SettleAuditResult> {
  const audit = await getSiteAudit(svc, who.workspaceId, auditId)
  if (!audit)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That audit doesn’t exist.',
    }
  if (isLiveAudit(audit.status))
    return {
      ok: false,
      code: 'STILL_RUNNING',
      message: 'Stop the audit before deleting it.',
    }
  const { error } = await svc
    .from('seo_audit')
    .delete()
    .eq('id', auditId)
    .eq('workspace_id', who.workspaceId)
  if (error) throw new Error(`seo audit delete failed: ${error.message}`)
  return { ok: true, audit }
}
