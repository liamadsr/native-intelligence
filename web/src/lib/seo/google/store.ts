/**
 * The workspace's choice of Search Console site and Google Analytics
 * property (seo_google_source, migration 595): read and written here only.
 *
 * One row per workspace is kept by this code, not by an index (a workspace
 * merge re-stamps workspace_id and must never meet a uniqueness it cannot
 * resolve): a read folds every row into one, newest first, each product
 * taken from the newest row that has it; a write updates the newest row
 * with that fold and deletes the rest. Every query is scoped by
 * workspace_id: the client is the service role's, so the filter is the fence.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'

export const SOURCE_FIELDS =
  'id, workspace_id, sc_site_url, sc_account_id, sc_chosen_by, sc_chosen_at, ga4_property_id, ga4_property_name, ga4_time_zone, ga4_currency_code, ga4_account_id, ga4_chosen_by, ga4_chosen_at, updated_at'

export interface SourceRow {
  id: string
  workspace_id: string
  sc_site_url: string | null
  sc_account_id: string | null
  sc_chosen_by: string | null
  sc_chosen_at: string | null
  ga4_property_id: string | null
  ga4_property_name: string | null
  ga4_time_zone: string | null
  ga4_currency_code: string | null
  ga4_account_id: string | null
  ga4_chosen_by: string | null
  ga4_chosen_at: string | null
  updated_at: string
}

const SC_FIELDS = [
  'sc_site_url',
  'sc_account_id',
  'sc_chosen_by',
  'sc_chosen_at',
] as const
const GA4_FIELDS = [
  'ga4_property_id',
  'ga4_property_name',
  'ga4_time_zone',
  'ga4_currency_code',
  'ga4_account_id',
  'ga4_chosen_by',
  'ga4_chosen_at',
] as const

export type SourcePatch = Partial<
  Pick<SourceRow, (typeof SC_FIELDS)[number] | (typeof GA4_FIELDS)[number]>
>

/** Rows newest first, folded into one: each product from the newest row that has it. Pure. */
export function foldSourceRows(rows: readonly SourceRow[]): SourceRow | null {
  if (!rows.length) return null
  const sorted = [...rows].sort((a, b) =>
    a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
  )
  const out: SourceRow = { ...sorted[0] }
  const sc = sorted.find((r) => r.sc_site_url)
  const ga4 = sorted.find((r) => r.ga4_property_id)
  for (const f of SC_FIELDS)
    (out as unknown as Record<string, unknown>)[f] = sc ? sc[f] : null
  for (const f of GA4_FIELDS)
    (out as unknown as Record<string, unknown>)[f] = ga4 ? ga4[f] : null
  return out
}

async function workspaceRows(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<SourceRow[]> {
  const { data, error } = await svc
    .from('seo_google_source')
    .select(SOURCE_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(20)
  if (error) throw new Error(`seo_google_source read: ${error.message}`)
  return (data ?? []) as unknown as SourceRow[]
}

/** The workspace's choice (null: nothing chosen yet). */
export async function readSource(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<SourceRow | null> {
  return foldSourceRows(await workspaceRows(svc, workspaceId))
}

/** Apply `patch` to the workspace's one row (creating it), and delete any others. Returns the row as written. */
export async function writeSource(
  svc: SupabaseClient,
  workspaceId: string,
  patch: SourcePatch,
  now: Date = new Date(),
): Promise<SourceRow> {
  const rows = await workspaceRows(svc, workspaceId)
  const folded = foldSourceRows(rows)
  const at = now.toISOString()
  if (!folded) {
    const { data, error } = await svc
      .from('seo_google_source')
      .insert({
        workspace_id: workspaceId,
        ...patch,
        created_at: at,
        updated_at: at,
      })
      .select(SOURCE_FIELDS)
      .single()
    if (error || !data)
      throw new Error(`seo_google_source insert: ${error?.message ?? 'no row'}`)
    return data as unknown as SourceRow
  }
  const next: Record<string, unknown> = {}
  for (const f of [...SC_FIELDS, ...GA4_FIELDS])
    next[f] = f in patch ? patch[f as keyof SourcePatch] : folded[f]
  const { data, error } = await svc
    .from('seo_google_source')
    .update({ ...next, updated_at: at })
    .eq('id', folded.id)
    .eq('workspace_id', workspaceId)
    .select(SOURCE_FIELDS)
    .single()
  if (error || !data)
    throw new Error(`seo_google_source update: ${error?.message ?? 'no row'}`)
  const extras = rows.map((r) => r.id).filter((id) => id !== folded.id)
  if (extras.length) {
    const { error: deleteError } = await svc
      .from('seo_google_source')
      .delete()
      .eq('workspace_id', workspaceId)
      .in('id', extras)
    if (deleteError)
      console.warn(
        '[seo-google] could not remove extra source rows',
        deleteError.message,
      )
  }
  return data as unknown as SourceRow
}

export const CLEAR_SEARCH_CONSOLE: SourcePatch = {
  sc_site_url: null,
  sc_account_id: null,
  sc_chosen_by: null,
  sc_chosen_at: null,
}
export const CLEAR_ANALYTICS: SourcePatch = {
  ga4_property_id: null,
  ga4_property_name: null,
  ga4_time_zone: null,
  ga4_currency_code: null,
  ga4_account_id: null,
  ga4_chosen_by: null,
  ga4_chosen_at: null,
}
