/**
 * The workspace's own website, as the SEO area's default: an audit, a
 * keyword lookup or a rank tracker with no site named means "ours".
 *
 * First match wins:
 *   1. the connected website's live address (the website-by-text feature,
 *      src/lib/website);
 *   2. the workspace's own company's domain (research_my_company).
 */
import { getLiveSite } from '@/lib/website/store'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'

export async function workspaceSiteUrl(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  const site = await getLiveSite(svc, workspaceId).catch(() => null)
  if (site?.siteUrl) return site.siteUrl

  const { data } = await svc
    .from('company')
    .select('domain, website')
    .eq('workspace_id', workspaceId)
    .eq('is_workspace_company', true)
    .limit(1)
  const row = ((data as Array<{
    domain?: unknown
    website?: unknown
  }> | null) ?? [])[0]
  const raw = [row?.website, row?.domain].find(
    (value): value is string => typeof value === 'string' && /\./.test(value),
  )
  if (!raw) return null
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  return host ? `https://${host}` : null
}
