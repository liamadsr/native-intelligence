/**
 * Canon freshness (canon documents D3; documents-as-ground-truth.md §3.5):
 * each `##` section of a canon document carries when it was last edited or
 * confirmed still true, and by whom (document_section_check, migration 377),
 * and the claims drawn from a canon document stay in step with its text.
 *
 *   stamp     a canon section edit stamps its section at once (canon-edit.ts);
 *             a person's edit in the editor is seen by the nightly pass (the
 *             section's hash changed: checked as of the document's last change,
 *             by its last editor).
 *   stale     a section nobody has touched or confirmed for 90 days shows a
 *             quiet "not checked since <date>" marker in the document view
 *             (staleSections), hidden while it is fresh. No card asks about
 *             it (decision 16: no queues for reversible things): editing the
 *             section, or its "Mark checked" in the marker, stamps it.
 *   claims    applying a canon section edit sends that section through the
 *             existing extraction (claim/extract-from-source on the utility
 *             agent), and retires the claims whose quote the edit took away:
 *             in the section before, not after, nowhere else in the document
 *             (markdown and quote styles aside). Their source row and edge to
 *             it go, and a claim left with no source is archived (never
 *             deleted).
 *
 * Service-role only. Every write is best effort: freshness never fails an edit.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { findSection, levelTwoSectionOf, parseOutline } from './markdown-structure'
import { sectionBody } from './section-diff'

/** A section untouched and unconfirmed this long shows its "not checked since" marker. */
export const STALE_SECTION_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export interface CanonSectionState {
  section: string
  heading: string
  hash: string
  text: string
}

/** The text a hash reads: whitespace runs collapsed. Pure. */
function normalized(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The document's `##` sections, each with the hash of its text. Pure. */
export function canonSections(content: string): CanonSectionState[] {
  const out: CanonSectionState[] = []
  const seen = new Set<string>()
  for (const e of parseOutline(content).filter((x) => x.level === 2)) {
    const section = e.heading.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200)
    if (!section || seen.has(section)) continue
    seen.add(section)
    const text = sectionBody(content, e)
    out.push({ section, heading: e.heading.slice(0, 200), text, hash: createHash('sha256').update(normalized(text)).digest('hex').slice(0, 32) })
  }
  return out
}

export interface CheckRow {
  section: string
  heading: string
  content_hash: string
  last_verified_at: string
  verified_by: string | null
  verified_kind: string
}

/**
 * What the nightly pass writes for one document (pure): a row for each
 * section not tracked yet or whose text changed (checked as of `changedAt`,
 * by `editor`), and the sections that are gone.
 */
export function planCheckSync(
  sections: readonly CanonSectionState[],
  rows: readonly CheckRow[],
  changedAt: string,
  editor: string | null,
): { upserts: CheckRow[]; removed: string[] } {
  const bySection = new Map(rows.map((r) => [r.section, r]))
  const upserts: CheckRow[] = []
  for (const s of sections) {
    const row = bySection.get(s.section)
    if (row && row.content_hash === s.hash) continue
    upserts.push({ section: s.section, heading: s.heading, content_hash: s.hash, last_verified_at: changedAt, verified_by: editor, verified_kind: 'edit' })
  }
  const present = new Set(sections.map((s) => s.section))
  return { upserts, removed: rows.filter((r) => !present.has(r.section)).map((r) => r.section) }
}

/** One section past STALE_SECTION_DAYS, as the document view's marker shows it. */
export interface StaleSection {
  heading: string
  lastVerifiedAt: string
}

/**
 * The sections unchecked for STALE_SECTION_DAYS, oldest first, that are still
 * in the document (pure): what the "not checked since" marker lists. Empty
 * when every section is fresh (the marker hides).
 */
export function staleSections(rows: ReadonlyArray<Pick<CheckRow, 'section' | 'heading' | 'last_verified_at'>>, content: string, nowMs: number): StaleSection[] {
  const present = new Set(canonSections(content).map((s) => s.section))
  return rows
    .filter((r) => present.has(r.section) && nowMs - Date.parse(r.last_verified_at) >= STALE_SECTION_DAYS * DAY_MS)
    .sort((a, b) => Date.parse(a.last_verified_at) - Date.parse(b.last_verified_at))
    .map((r) => ({ heading: r.heading, lastVerifiedAt: r.last_verified_at }))
}

/** A canon document's stale sections for its view (staleSections). Never throws: a failed read shows none. */
export async function loadStaleSections(
  supabase: SupabaseClient,
  args: { workspaceId: string; documentId: string; content: string; nowMs?: number },
): Promise<StaleSection[]> {
  try {
    const { data, error } = await supabase
      .from('document_section_check')
      .select('section, heading, last_verified_at')
      .eq('workspace_id', args.workspaceId)
      .eq('document_id', args.documentId)
    if (error) return []
    return staleSections((data ?? []) as Array<Pick<CheckRow, 'section' | 'heading' | 'last_verified_at'>>, args.content, args.nowMs ?? Date.now())
  } catch {
    return []
  }
}

/** The `##` section a name or a "Parent > Child" path belongs to, as its check row is keyed. Pure. */
export function topSectionKey(section: string, content?: string): string {
  // Resolved against the document when there is one: a document that opens
  // with a `#` title starts every path with it, so the first segment is not
  // the section.
  if (content !== undefined) {
    const outline = parseOutline(content)
    const found = findSection(outline, section)
    const top = found.ok ? levelTwoSectionOf(outline, found.entry) : null
    if (top) return top.heading.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200)
  }
  return section.split(/\s*(?:>|▸|›)\s*/)[0].replace(/\s+/g, ' ').trim().toLowerCase()
}

/** Stamp one section checked now (an edit just landed, or someone marked it checked). Never throws. */
export async function stampSectionChecked(
  supabase: SupabaseClient,
  args: { workspaceId: string; documentId: string; content: string; section: string; memberId: string | null; kind: 'agent' | 'confirmed' },
): Promise<void> {
  try {
    const top = topSectionKey(args.section, args.content)
    const state = canonSections(args.content).find((s) => s.section === top)
    if (!state) return
    await supabase.from('document_section_check').upsert(
      {
        document_id: args.documentId,
        workspace_id: args.workspaceId,
        section: state.section,
        heading: state.heading,
        content_hash: state.hash,
        last_verified_at: new Date().toISOString(),
        verified_by: args.memberId,
        verified_kind: args.kind,
      },
      { onConflict: 'document_id,section' },
    )
  } catch (err) {
    console.warn('[canon-freshness] stamp skipped:', err instanceof Error ? err.message : err)
  }
}

// ── Claims in step with the text ──────────────────────────────────────────────

/** The most claim sources one sync reads for a document. */
const CLAIM_SOURCES_MAX = 200

/**
 * Text as a quote is compared (pure): markdown emphasis, code ticks, list
 * markers and link targets stripped, curly quotes straightened, ellipses
 * dropped, whitespace collapsed, lower-cased. So "**Cheaper** than Gong…"
 * still matches a claim that quotes "cheaper than Gong".
 */
export function quoteText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\u2026|\.{3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Whether a claim's quoted excerpt is in a text (markdown aside). Pure. */
export function excerptIn(excerpt: string | null, text: string): boolean {
  if (!excerpt || !quoteText(excerpt)) return true
  return quoteText(text).includes(quoteText(excerpt))
}

/**
 * Whether an edit took a claim's quoted text away (pure): the excerpt was in
 * the edited section before, is not in it after, and is nowhere else in the
 * document either. A claim quoting another section, or text the edit kept or
 * only reformatted, is left alone.
 */
export function editRemovedExcerpt(excerpt: string | null, edit: { before: string; after: string; content: string }): boolean {
  if (!excerpt || !quoteText(excerpt)) return false
  return excerptIn(excerpt, edit.before) && !excerptIn(excerpt, edit.after) && !excerptIn(excerpt, edit.content)
}

/**
 * Keep the claims drawn from a canon document in step with its text (see the
 * header): extract claims from the edited section, and retire the claims whose
 * quoted text left the document. Never throws.
 */
export async function syncCanonClaims(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    memberId: string | null
    documentId: string
    title: string | null
    content: string
    section: string
    /** The section's text after the edit (null: cleared or removed, nothing to extract). */
    sectionText: string | null
    /** The section's text before the edit: only quotes it held can be retired. */
    sectionBefore: string
  },
): Promise<{ retired: number; archived: number }> {
  const out = { retired: 0, archived: 0 }
  // 1. Extract from the section (the existing path, on the utility agent).
  if (args.sectionText && args.sectionText.trim().length >= 40) {
    try {
      await inngest.send({
        name: 'claim/extract-from-source',
        data: {
          workspaceId: args.workspaceId,
          userId: args.userId,
          memberId: args.memberId,
          sourceType: 'document',
          sourceId: args.documentId,
          sourceText: `## ${args.section}\n\n${args.sectionText}`,
          sourceLabel: `${args.title ?? 'Document'} ▸ ${args.section}`,
        },
      })
    } catch (err) {
      console.warn('[canon-freshness] claim extraction not queued:', err instanceof Error ? err.message : err)
    }
  }
  // 2. Retire what left the text.
  try {
    const { data } = await supabase
      .from('claim_source')
      .select('id, claim_id, excerpt, claim:claim_id!inner(workspace_id)')
      .eq('source_type', 'document')
      .eq('source_id', args.documentId)
      .eq('claim.workspace_id', args.workspaceId)
      .limit(CLAIM_SOURCES_MAX)
    const edit = { before: args.sectionBefore, after: args.sectionText ?? '', content: args.content }
    const gone = ((data ?? []) as Array<{ id: string; claim_id: string; excerpt: string | null }>).filter((r) => editRemovedExcerpt(r.excerpt, edit))
    if (gone.length === 0) return out
    await supabase.from('claim_source').delete().in('id', gone.map((r) => r.id))
    const claimIds = [...new Set(gone.map((r) => r.claim_id))]
    await supabase
      .from('entity_link')
      .delete()
      .eq('workspace_id', args.workspaceId)
      .eq('source_type', 'claim')
      .in('source_id', claimIds)
      .eq('target_type', 'document')
      .eq('target_id', args.documentId)
    out.retired = gone.length
    // A claim with no source left is archived (never deleted).
    const { data: still } = await supabase.from('claim_source').select('claim_id').in('claim_id', claimIds)
    const sourced = new Set(((still ?? []) as Array<{ claim_id: string }>).map((r) => r.claim_id))
    const orphans = claimIds.filter((id) => !sourced.has(id))
    if (orphans.length) {
      await supabase.from('claim').update({ status: 'archived' }).eq('workspace_id', args.workspaceId).in('id', orphans).eq('status', 'active')
      out.archived = orphans.length
    }
  } catch (err) {
    console.warn('[canon-freshness] claim retire skipped:', err instanceof Error ? err.message : err)
  }
  return out
}

// ── The nightly pass ──────────────────────────────────────────────────────────

export interface FreshnessPassResult {
  documents: number
  synced: number
}

/** The most canon documents one pass looks at per workspace. */
const DOCS_PER_WORKSPACE = 50

/**
 * The maintenance cron's freshness pass for one workspace: sync every canon
 * document's section checks with its text (see the header). It raises no
 * card. Never throws.
 */
export async function runCanonFreshness(supabase: SupabaseClient, workspaceId: string): Promise<FreshnessPassResult> {
  const result: FreshnessPassResult = { documents: 0, synced: 0 }
  try {
    const { data: docs } = await supabase
      .from('document')
      .select('id, content, last_edited_by, updated_at')
      .eq('workspace_id', workspaceId)
      .not('canon_key', 'is', null)
      .neq('status', 'archived')
      .limit(DOCS_PER_WORKSPACE)
    const list = (docs ?? []) as Array<{ id: string; content: string | null; last_edited_by: string | null; updated_at: string }>
    if (list.length === 0) return result
    result.documents = list.length
    const { data: checkRows } = await supabase
      .from('document_section_check')
      .select('document_id, section, heading, content_hash, last_verified_at, verified_by, verified_kind')
      .eq('workspace_id', workspaceId)
      .in('document_id', list.map((d) => d.id))
    const byDoc = new Map<string, CheckRow[]>()
    for (const r of (checkRows ?? []) as Array<CheckRow & { document_id: string }>) {
      if (!byDoc.has(r.document_id)) byDoc.set(r.document_id, [])
      byDoc.get(r.document_id)!.push(r)
    }

    for (const doc of list) {
      const content = doc.content ?? ''
      const sections = canonSections(content)
      const rows = byDoc.get(doc.id) ?? []
      const plan = planCheckSync(sections, rows, doc.updated_at, doc.last_edited_by)
      // A document has a handful of sections; only the changed ones are written.
      for (const u of plan.upserts) {
        await supabase.from('document_section_check').upsert({ ...u, document_id: doc.id, workspace_id: workspaceId }, { onConflict: 'document_id,section' })
        result.synced++
      }
      if (plan.removed.length) {
        await supabase.from('document_section_check').delete().eq('document_id', doc.id).in('section', plan.removed)
      }
    }
  } catch (err) {
    console.warn('[canon-freshness] pass skipped for a workspace:', err instanceof Error ? err.message : err)
  }
  return result
}

/**
 * Someone who may edit the document marked a section checked (the marker's
 * "Mark checked"): stamp it confirmed, by them. Never throws; false when the
 * document or the section is gone.
 */
export async function markSectionChecked(
  supabase: SupabaseClient,
  args: { workspaceId: string; documentId: string; section: string; memberId: string },
): Promise<boolean> {
  try {
    const { data } = await supabase.from('document').select('content').eq('id', args.documentId).eq('workspace_id', args.workspaceId).maybeSingle()
    const content = (data as { content?: string | null } | null)?.content
    if (typeof content !== 'string') return false
    const top = topSectionKey(args.section, content)
    if (!canonSections(content).some((s) => s.section === top)) return false
    await stampSectionChecked(supabase, { workspaceId: args.workspaceId, documentId: args.documentId, content, section: args.section, memberId: args.memberId, kind: 'confirmed' })
    return true
  } catch {
    return false
  }
}
