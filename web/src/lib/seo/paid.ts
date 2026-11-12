/**
 * The one door to a paid search-data call for an SEO service: the access
 * check (./access.ts) first, then the workspace's metered client
 * (./data-client.ts). A service calls paidSeoClient right before it would
 * buy (after its stored-snapshot check, ./lookup-cache.ts: reading what was
 * already bought is free and needs no check), and returns the refusal as it
 * is when there is one. Routes turn a refusal into seoRefusalResponse, tools
 * into { success: false, code, error }.
 *
 * `deps` lets a test hand in a client over a recording meter and a stubbed
 * access check; production passes nothing.
 */
import { apiError } from '@/lib/api-errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  checkSeoDataAccess,
  type SeoDataAccess,
  type SeoDataRefusal,
} from './access'
import { seoDataClient } from './data-client'
import type { DataforseoClient } from './dataforseo'
import { seoErrorResponse, seoToolError } from './http'
import { isSeoInputError } from './input-error'

/** Who is asking: the workspace, the person (null for a schedule), and whether anyone is watching. */
export interface SeoWho {
  workspaceId: string
  userId: string | null
  /** A turn nobody is in (a loop, a scheduled skill run): refused before any paid call. */
  unattended?: boolean
}

export interface SeoPaidDeps {
  client?: DataforseoClient
  checkAccess?: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<SeoDataAccess>
  now?: () => Date
}

export function isSeoRefusal(value: unknown): value is SeoDataRefusal {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { code?: unknown }).code === 'string'
  )
}

/** The metered client for this workspace, or the reason search data may not be bought now. */
export async function paidSeoClient(
  svc: SupabaseClient,
  who: SeoWho,
  deps: SeoPaidDeps = {},
): Promise<{ ok: true; client: DataforseoClient } | SeoDataRefusal> {
  const access = await (deps.checkAccess ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: who.unattended,
  })
  if (!access.ok) return access
  return {
    ok: true,
    client:
      deps.client ??
      seoDataClient(svc, { workspaceId: who.workspaceId, userId: who.userId }),
  }
}

/**
 * A route's answer to a failed SEO lookup: our own refusals of a request
 * (SeoInputError, ./input-error.ts) keep their words as a 400
 * VALIDATION_ERROR; everything else goes through seoErrorResponse.
 */
export function seoFailureResponse(error: unknown, where: string) {
  if (isSeoInputError(error))
    return apiError(error.message, { status: 400, code: 'VALIDATION_ERROR' })
  return seoErrorResponse(error, where)
}

/** A tool's answer to a failed SEO lookup, keeping our own refusals' words (see seoFailureResponse). */
export function seoFailureForTool(
  error: unknown,
  where: string,
): { success: false; code: string; error: string } {
  if (isSeoInputError(error))
    return { success: false, code: 'VALIDATION_ERROR', error: error.message }
  return seoToolError(error, where)
}
