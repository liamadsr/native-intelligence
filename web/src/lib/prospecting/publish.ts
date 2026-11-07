/**
 * Publish — the list becomes a group in the CRM (migration 259).
 *
 * Liam, 2026-09-06: "every list that you create becomes a group of contacts…
 * once you finalize it and you create it, it gets created as a group in the
 * CRM, and they all get saved… I come back in a month and I add five more,
 * then there should be 17, and when I save those changes, those five new
 * contacts will be added to that group."
 *
 * So Publish is the ONE thing that writes to the CRM, and it is incremental:
 * it promotes every saved entry the group does not hold yet (`stage = 'saved'
 * AND published_at IS NULL`, people only under a saved company), stamps
 * `published_at` on what landed, records the list id on each CRM row through
 * `prospect_list_mark_published`, and stamps the list. A second publish with
 * nothing new writes nothing.
 *
 * Promotion itself is unchanged and reused — `promoteEntries` still runs the
 * dedup (find-or-create by domain / email / LinkedIn), the research merge, and
 * the namesake gate: a `needs_review` person is held back from a list publish
 * exactly as bulk Save held them back, and the per-row confirm publishes that
 * ONE person with `includeUnverified` through {@link publishEntries}.
 *
 * Two entry points, one write path:
 *   - {@link publishList}    — everything pending on a list (the header button,
 *                              Scout's publish_prospect_list);
 *   - {@link publishEntries} — specific entries (the needs-review confirm,
 *                              Add-to-sequence, which needs contact ids NOW).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { readAll } from './exclusions'
import {
  isListMember,
  promoteEntries,
  type ProspectingError,
  type PromoteResult,
  type Result,
} from './lists'

function fail(code: ProspectingError['code'], error: string): ProspectingError {
  return { ok: false, code, error }
}

export interface PublishResult extends PromoteResult {
  /** Every list the publish touched, in first-seen order. */
  list_ids: string[]
  /** The stamp written on what landed, or null when nothing did. */
  published_at: string | null
}

/** One PostgREST `.in()` per chunk keeps the URL sane for a 200-row publish. */
const STAMP_CHUNK = 100
/** `promoteEntries` is a handful of upserts per entry; a list publish walks
 *  its pending set in batches of this many so one press cannot run long. */
export const PUBLISH_BATCH = 100

/**
 * Publish specific entries: promote, then mark. The per-entry outcomes are
 * `promoteEntries`' own — Add-to-sequence reconciles its selection against
 * `saved` + `skipped` exactly as it did against Save's.
 */
export async function publishEntries(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    entryIds: string[]
    /** Per-row override for `needs_review` people. Never a bulk default. */
    includeUnverified?: boolean
  },
): Promise<Result<PublishResult>> {
  const promoted = await promoteEntries(supabase, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    entryIds: args.entryIds,
    includeUnverified: args.includeUnverified === true,
  })
  if (!promoted.ok) return promoted

  const listIds: string[] = []
  for (const outcome of [...promoted.saved, ...promoted.skipped]) {
    if (outcome.list_id && !listIds.includes(outcome.list_id)) listIds.push(outcome.list_id)
  }
  if (promoted.saved.length === 0) {
    return { ...promoted, list_ids: listIds, published_at: null }
  }

  const now = new Date().toISOString()

  // ── The entries: published_at ────────────────────────────────────────
  const savedIds = promoted.saved.map((s) => s.entry_id)
  for (let i = 0; i < savedIds.length; i += STAMP_CHUNK) {
    const { error } = await supabase
      .from('prospect_list_entry')
      .update({ published_at: now })
      .eq('workspace_id', args.workspaceId)
      .in('id', savedIds.slice(i, i + STAMP_CHUNK))
    if (error) {
      console.error('[prospecting] publish stamp failed:', error.message)
      return fail('DB_ERROR', 'The CRM rows were written but the list could not be stamped')
    }
  }

  // ── The CRM rows: the list id, per list ──────────────────────────────
  for (const listId of listIds) {
    const mine = promoted.saved.filter((s) => s.list_id === listId)
    const companyIds = mine.map((s) => s.company_id).filter((id): id is string => !!id)
    const contactIds = mine.map((s) => s.contact_id).filter((id): id is string => !!id)
    if (companyIds.length === 0 && contactIds.length === 0) continue

    const { error: markError } = await supabase.rpc('prospect_list_mark_published', {
      p_workspace: args.workspaceId,
      p_list: listId,
      p_company_ids: companyIds,
      p_contact_ids: contactIds,
    })
    if (markError) {
      console.error('[prospecting] CRM group mark failed:', markError.message)
      return fail('DB_ERROR', 'The CRM rows were written but could not be grouped under the list')
    }

    const { error: listError } = await supabase
      .from('prospect_list')
      .update({ published_at: now, published_by: args.userId })
      .eq('id', listId)
      .eq('workspace_id', args.workspaceId)
    if (listError) {
      console.error('[prospecting] list publish stamp failed:', listError.message)
      return fail('DB_ERROR', 'The CRM rows were written but the list could not be stamped')
    }
  }

  return { ...promoted, list_ids: listIds, published_at: now }
}

/**
 * What Publish would write for this list, companies first: saved and never
 * (or no longer) published — see {@link isListMember} for the people rule.
 */
export async function pendingPublishEntryIds(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string },
): Promise<Result<{ entryIds: string[] }>> {
  let rows: Array<{
    id: string
    kind: string
    stage: string
    parent_entry_id: string | null
    published_at: string | null
  }>
  try {
    rows = await readAll('pending publish', (from, to) =>
      supabase
        .from('prospect_list_entry')
        .select('id, kind, stage, parent_entry_id, published_at')
        .eq('workspace_id', args.workspaceId)
        .eq('list_id', args.listId)
        .eq('stage', 'saved')
        .order('id')
        .range(from, to),
    )
  } catch (err) {
    console.error(
      '[prospecting] pending publish read failed:',
      err instanceof Error ? err.message : String(err),
    )
    return fail('DB_ERROR', 'Failed to load the list')
  }
  const savedCompanyIds = new Set(rows.filter((r) => r.kind === 'company').map((r) => r.id))
  const pending = rows.filter((r) => r.published_at === null && isListMember(r, savedCompanyIds))
  // Companies first, so a person's parent is already in the batch's cache by
  // the time the person runs — `promoteEntries` sorts too, but batching by
  // PUBLISH_BATCH below would otherwise split a person from its parent.
  const ordered = [
    ...pending.filter((r) => r.kind === 'company'),
    ...pending.filter((r) => r.kind !== 'company'),
  ]
  return { ok: true, entryIds: ordered.map((r) => r.id) }
}

/**
 * Publish everything pending on one list. A list with nothing pending is a
 * successful no-op — the caller reads `saved.length` and says "nothing new".
 */
export async function publishList(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; listId: string },
): Promise<Result<PublishResult & { list_name: string | null }>> {
  const { data: list, error: listError } = await supabase
    .from('prospect_list')
    .select('id, name, status')
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (listError) {
    console.error('[prospecting] publish list load failed:', listError.message)
    return fail('DB_ERROR', 'Failed to load list')
  }
  if (!list) return fail('NOT_FOUND', 'List not found')
  const listRow = list as { id: string; name: string | null; status: string }
  if (listRow.status === 'archived') {
    return fail('INVALID_INPUT', 'This list is archived; restore it before publishing')
  }

  const pending = await pendingPublishEntryIds(supabase, args)
  if (!pending.ok) return pending

  const saved: PublishResult['saved'] = []
  const skipped: PublishResult['skipped'] = []
  let publishedAt: string | null = null
  for (let i = 0; i < pending.entryIds.length; i += PUBLISH_BATCH) {
    const batch = await publishEntries(supabase, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      entryIds: pending.entryIds.slice(i, i + PUBLISH_BATCH),
    })
    if (!batch.ok) return batch
    saved.push(...batch.saved)
    skipped.push(...batch.skipped)
    if (batch.published_at) publishedAt = batch.published_at
  }

  return {
    ok: true,
    saved,
    skipped,
    list_ids: [args.listId],
    published_at: publishedAt,
    list_name: listRow.name,
  }
}
