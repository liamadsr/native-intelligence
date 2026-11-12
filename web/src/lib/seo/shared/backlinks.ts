/**
 * Backlinks research scope and spam-filter defaults.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  RESEARCH_SCOPE_PARAM_DESCRIPTION,
  RESEARCH_SCOPES,
  type ResearchScope,
} from '@/lib/seo/shared/researchScope'
import { z } from 'zod'

/**
 * Backlinks uses the shared research scopes. DataForSEO has no prefix
 * targeting, so subfolder rides on url_to/url prefix filters: backlink rows
 * and top pages are provider-filtered, summary counts come from filtered
 * backlink totals, and rank/trends/referring-domains stay unavailable.
 */
export type BacklinksTargetScope = ResearchScope

/**
 * Scope as it arrives from persisted or external state (URLs, tool inputs).
 * "page" is the pre-research-scope name for exact_url and is still accepted.
 */
export const backlinksScopeWithLegacySchema = z.enum([
  ...RESEARCH_SCOPES,
  'page',
])

export type BacklinksScopeWithLegacy = z.infer<
  typeof backlinksScopeWithLegacySchema
>

export function resolveBacklinksScope(
  scope: BacklinksScopeWithLegacy,
): ResearchScope {
  return scope === 'page' ? 'exact_url' : scope
}

export const backlinksScopeParamSchema =
  backlinksScopeWithLegacySchema.transform(resolveBacklinksScope)

/** Shared wording for the tools that take a backlinks scope. */
export const BACKLINKS_SCOPE_DESCRIPTION = `${RESEARCH_SCOPE_PARAM_DESCRIPTION} 'page' is a deprecated alias of 'exact_url'. Subfolder counts are computed from filtered backlink totals; rank, trends, and the referring-domains breakdown are unavailable for subfolders.`

export const DEFAULT_BACKLINKS_SPAM_THRESHOLD = 40

export type BacklinksSpamFilterOptions = {
  hideSpam?: boolean
}

/**
 * DataForSEO result grouping for the backlinks list: `one_per_domain` returns
 * each referring domain's strongest link (the default, denoised view);
 * `as_is` returns every individual backlink.
 */
export const backlinksRowsModeSchema = z.enum(['one_per_domain', 'as_is'])
