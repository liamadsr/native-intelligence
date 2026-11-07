/**
 * Reports and preps archive themselves (decision 18, eve-alignment.md §6;
 * documents-as-ground-truth.md §3.6): a skill or loop report or a meeting prep
 * (document.kind 'report' / 'prep', migration 367) that nobody changed or
 * opened in 30 days and nothing links to is archived by the nightly
 * maintenance pass.
 *
 *   opened   a person opened it in the app (document_open, migration 378:
 *            stamped by GET /api/account/documents/[id], at most once a day)
 *            within the last 30 days.
 *   kept     another entity links to it (an inbound entity_link, but not a
 *            claim citing the document it was drawn from), an action has it
 *            attached (action_document), a knowledge package holds it, a card
 *            is about it, or it is in a project or pinned.
 *   archive  status 'archived': it leaves the lists and search (phase 1 keeps
 *            archived documents out of both), and is never deleted. Its id still
 *            opens it, so a flow run's history and a work item's deliverable
 *            still reach it.
 *
 * Never a system document (a canon key or the product doc pointer: one
 * refused row would fail the whole batch, migration 366). Service role only.
 * Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { productDocIdOf } from '@/lib/workspace/product-doc'

export const REPORT_ARCHIVE_DAYS = 30
/** The most documents one pass archives per workspace (the rest wait for the next night). */
export const REPORT_ARCHIVE_BATCH = 200
const DAY_MS = 24 * 60 * 60 * 1000

/** The kinds that archive themselves. */
export const SELF_ARCHIVING_KINDS = ['report', 'prep'] as const

/** Stamp that a person opened a report or prep (decision 18). Best effort, never throws. */
export async function noteDocumentOpened(supabase: SupabaseClient, args: { documentId: string; workspaceId: string; kind: unknown }): Promise<void> {
  if (!(SELF_ARCHIVING_KINDS as readonly unknown[]).includes(args.kind)) return
  try {
    const { error } = await supabase.rpc('note_document_open', { p_document_id: args.documentId, p_workspace_id: args.workspaceId })
    if (error) console.warn('[report-archive] open not noted:', error.message)
  } catch (err) {
    console.warn('[report-archive] open not noted:', err instanceof Error ? err.message : err)
  }
}

/** Which candidates stay: opened lately or linked. Pure. */
export function documentsToArchive(
  candidates: readonly string[],
  keep: { openedSince: ReadonlySet<string>; linked: ReadonlySet<string>; system: ReadonlySet<string> },
): string[] {
  return candidates.filter((id) => !keep.openedSince.has(id) && !keep.linked.has(id) && !keep.system.has(id))
}

/** How many pages of candidates one pass reads per workspace (oldest first). */
export const REPORT_ARCHIVE_PAGES = 5

interface CandidateRow {
  id: string
  project_id: string | null
  is_pinned: boolean | null
}

/**
 * Which of a page of candidates stay (the keep signals), from four reads.
 * Linked means a real link: an inbound entity link other than a claim citing
 * the document it was drawn from (extraction writes those itself), an action
 * it is attached to, a knowledge package holding it, or a card about it. In a
 * project or pinned: kept too. A failed read keeps the whole page.
 */
async function keptOf(supabase: SupabaseClient, workspaceId: string, rows: readonly CandidateRow[], cutoff: string): Promise<Set<string> | null> {
  const ids = rows.map((r) => r.id)
  const [opened, links, attached, packaged, cards] = await Promise.all([
    supabase.from('document_open').select('document_id').eq('workspace_id', workspaceId).in('document_id', ids).gte('last_opened_at', cutoff),
    supabase.from('entity_link').select('target_id, source_type, source_id, relation').eq('workspace_id', workspaceId).eq('target_type', 'document').in('target_id', ids),
    supabase.from('action_document').select('document_id').in('document_id', ids),
    supabase.from('knowledge_package_item').select('entity_id').eq('workspace_id', workspaceId).eq('entity_type', 'document').in('entity_id', ids),
    supabase.from('attention_item').select('entity_id').eq('workspace_id', workspaceId).eq('entity_type', 'document').in('entity_id', ids),
  ])
  if (opened.error || links.error || attached.error || packaged.error || cards.error) return null
  const kept = new Set<string>()
  for (const r of rows) if (r.project_id || r.is_pinned) kept.add(r.id)
  for (const r of (opened.data ?? []) as Array<{ document_id: string }>) kept.add(r.document_id)
  for (const r of (attached.data ?? []) as Array<{ document_id: string }>) kept.add(r.document_id)
  for (const r of (packaged.data ?? []) as Array<{ entity_id: string }>) kept.add(r.entity_id)
  for (const r of (cards.data ?? []) as Array<{ entity_id: string }>) kept.add(r.entity_id)

  // A claim citing the very document it was extracted from is not a link
  // anyone made: only a claim citing it from another source keeps it.
  const linkRows = (links.data ?? []) as Array<{ target_id: string; source_type: string; source_id: string; relation: string | null }>
  const citing = linkRows.filter((l) => l.source_type === 'claim' && (l.relation ?? 'cites') === 'cites')
  let selfDrawn = new Set<string>()
  if (citing.length) {
    const { data, error } = await supabase
      .from('claim_source')
      .select('claim_id, source_id')
      .eq('source_type', 'document')
      .in('claim_id', [...new Set(citing.map((l) => l.source_id))])
      .in('source_id', ids)
    if (error) return null
    selfDrawn = new Set(((data ?? []) as Array<{ claim_id: string; source_id: string }>).map((r) => `${r.claim_id}|${r.source_id}`))
  }
  for (const l of linkRows) {
    const drawnFromIt = l.source_type === 'claim' && (l.relation ?? 'cites') === 'cites' && selfDrawn.has(`${l.source_id}|${l.target_id}`)
    if (!drawnFromIt) kept.add(l.target_id)
  }
  return kept
}

/**
 * One workspace's pass: how many reports and preps it archived. Candidates
 * are read oldest first, a page at a time, past the ones that stay, so a page
 * of kept documents never holds the rest back.
 */
export async function archiveStaleReports(supabase: SupabaseClient, workspaceId: string, nowMs = Date.now()): Promise<number> {
  try {
    const cutoff = new Date(nowMs - REPORT_ARCHIVE_DAYS * DAY_MS).toISOString()
    const productDoc = await productDocIdOf(supabase, workspaceId)
    let archived = 0
    let offset = 0
    for (let page = 0; page < REPORT_ARCHIVE_PAGES; page++) {
      const { data, error } = await supabase
        .from('document')
        .select('id, project_id, is_pinned')
        .eq('workspace_id', workspaceId)
        .in('kind', [...SELF_ARCHIVING_KINDS])
        .eq('status', 'active')
        .is('canon_key', null)
        .lt('updated_at', cutoff)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + REPORT_ARCHIVE_BATCH - 1)
      if (error) break
      const rows = (data ?? []) as CandidateRow[]
      if (rows.length === 0) break
      const kept = await keptOf(supabase, workspaceId, rows, cutoff)
      if (!kept) break
      const archive = documentsToArchive(
        rows.map((r) => r.id),
        { openedSince: kept, linked: new Set(), system: new Set(productDoc ? [productDoc] : []) },
      )
      if (archive.length) {
        const { data: done, error: updError } = await supabase
          .from('document')
          .update({ status: 'archived' })
          .eq('workspace_id', workspaceId)
          .eq('status', 'active')
          .in('id', archive)
          .select('id')
        if (updError) {
          console.warn('[report-archive] archive skipped:', updError.message)
          break
        }
        archived += Array.isArray(done) ? done.length : 0
      }
      // The archived rows leave the candidate list; the kept ones stay in it, so step past them.
      offset += rows.length - archive.length
      if (rows.length < REPORT_ARCHIVE_BATCH) break
    }
    return archived
  } catch (err) {
    console.warn('[report-archive] pass skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}
