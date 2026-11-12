/**
 * Which domain (or page, or folder) a domain lookup is about. With none
 * named it is the workspace's own website (src/lib/seo/site.ts); with no
 * website on file either, the lookup is refused with a plain sentence before
 * anything is bought.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { SeoInputError } from '@/lib/seo/input-error'
import {
  parseResearchTarget,
  type ResearchScope,
  type ResearchTarget,
} from '@/lib/seo/shared/researchScope'
import { workspaceSiteUrl } from '@/lib/seo/site'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'

export const NO_SITE_MESSAGE =
  'Name a domain to look up: this workspace has no website on file yet.'

/** A typed target, parsed (throws VALIDATION_ERROR with the reason when it is not a domain or URL). */
export function parseTarget(
  input: string,
  scope?: ResearchScope,
): ResearchTarget {
  const parsed = parseResearchTarget(input.slice(0, 2048), scope)
  if (!parsed.ok) throw new SeoInputError(parsed.message)
  return parsed.target
}

/** The named target, or the workspace's own site (whole domain) when none is named. */
export async function resolveTarget(
  svc: SupabaseClient,
  workspaceId: string,
  input: { domain?: string | null; scope?: ResearchScope },
): Promise<{ target: ResearchTarget; isOwnSite: boolean }> {
  const named = input.domain?.trim()
  if (named)
    return { target: parseTarget(named, input.scope), isOwnSite: false }
  const site = await workspaceSiteUrl(svc, workspaceId)
  if (!site) throw new SeoInputError(NO_SITE_MESSAGE)
  return {
    target: parseTarget(site, input.scope ?? 'subdomains'),
    isOwnSite: true,
  }
}

/** The workspace's own site's hostname, or null. Never throws. */
export async function ownSiteHost(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<string | null> {
  try {
    const site = await workspaceSiteUrl(svc, workspaceId)
    if (!site) return null
    const parsed = parseResearchTarget(site)
    return parsed.ok ? parsed.target.hostname : null
  } catch {
    return null
  }
}
