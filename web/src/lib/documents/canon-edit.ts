/**
 * Section edits to canon documents (canon documents D2;
 * docs/plans/documents-as-ground-truth.md §3.2-3.4, eve-alignment.md §6
 * decision 16).
 *
 * Decision 16 (Liam, 2026-10-20: "The agent should just go ahead and do it…
 * Just give me the option to undo it if I don't think it's correct"): an
 * agent's edit to a canon document APPLIES DIRECTLY, because it is
 * reversible, with no approval card ever. Every edit:
 *   - touches one section by name (replace, append or remove; a fixed template
 *     section is cleared, never deleted, so the skeleton holds);
 *   - is compare-and-swap (migration 364): on a conflict it re-reads and
 *     applies the same section change to the new text, once;
 *   - lands in the history with who made it and what it came from
 *     (document_revision.edit_meta, migration 376: section, op, reason,
 *     sources), and as ONE line in the daily digest (agent_log 'doc_updated');
 *   - when it rests on untrusted outside text (canon-sources.ts
 *     canonOutsideLabel), says so on both: edit_meta.outside, and "Native Intelligence
 *     updated Positioning in Product (from a web page)";
 *   - can be undone alone: revertSectionEdit puts that section back as it was
 *     before the edit, leaving every later edit to other sections in place.
 *
 * What is still refused is the agent, never the person asked: the budgets and
 * fixed sections and the grade rules (the `check`), a compare-and-swap
 * conflict, and an edit the caller may not make (a plain member's agent on
 * the admins' product doc gets a plain refusal, #774's write rules).
 *
 * Callers pass a SERVICE-ROLE client: access is checked here
 * (src/lib/documents/access.ts), as the document tools check it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { indexDocument } from '@/lib/ai/embeddings'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { NOW_EDIT_REFUSAL, isNowDocument } from '@/lib/now/now-stamp'
import { documentUpdateRefusal, loadDocumentAccess } from './access'
import { isPersonalCanonKey, templateForKey } from './canon'
import type { CanonSource } from './canon-sources'
import { emailDomain } from '@/lib/safety/outside-label'
import { canonOwnerMemberIds } from './canon-doc'
import { stampSectionChecked, syncCanonClaims } from './canon-freshness'
import {
  appendToSection,
  describeCandidates,
  findSection,
  insertSectionAfter,
  parseOutline,
  removeSection,
  replaceSection,
  splitLines,
  type OutlineEntry,
} from './markdown-structure'
import { parseRevision, writeDocument } from './write'
import { changedSection, putSectionBack, sectionBody } from './section-diff'

export { changedSection, putSectionBack, sectionBody, canonOwnerMemberIds }

export type CanonSectionOp = 'replace' | 'append' | 'remove'

/** What a section edit was, as migration 376 keeps it on the revision. */
export interface CanonEditMeta {
  section: string
  op: CanonSectionOp | 'revert'
  reason?: string
  sources?: CanonSource[]
  /** The revision a revert undid. */
  reverts?: number
  /** The outside text it rests on, in a few words ("a web page on acme.com"): its label in the history and the digest. */
  outside?: string
}

// ── Pure section transforms ───────────────────────────────────────────────────

/** Whether `entry` is one of the template's fixed `##` sections. Pure. */
export function isSkeletonSection(key: string | null, entry: Pick<OutlineEntry, 'heading' | 'level'>): boolean {
  const template = templateForKey(key)
  if (!template || entry.level !== 2) return false
  const want = entry.heading.replace(/\s+/g, ' ').trim().toLowerCase()
  return template.sections.some((s) => s.heading.toLowerCase() === want)
}

export type SectionTransform =
  | { ok: true; content: string; section: string; before: string; after: string; created?: boolean }
  | { ok: false; error: string }

/**
 * Apply one section op to `content`. A fixed template section that is
 * missing (an adopted document) is added at the end for replace/append; a
 * fixed section is cleared, not removed, by `remove`. Pure.
 */
export function applySectionOp(content: string, args: { key: string | null; section: string; op: CanonSectionOp; text: string }): SectionTransform {
  const outline = parseOutline(content)
  const found = findSection(outline, args.section)
  if (!found.ok) {
    const template = templateForKey(args.key)
    const fixed = template?.sections.find((s) => s.heading.toLowerCase() === args.section.replace(/\s+/g, ' ').trim().toLowerCase())
    if (found.reason === 'not_found' && fixed && args.op !== 'remove') {
      const next = insertSectionAfter(content, null, fixed.heading, args.text, 2)
      return { ok: true, content: next, section: fixed.heading, before: '', after: args.text.trim(), created: true }
    }
    return {
      ok: false,
      error:
        found.reason === 'ambiguous'
          ? `More than one heading matches "${args.section}": ${describeCandidates(found.matches)}. Name the path ("Parent > Heading").`
          : `No section "${args.section}".${outline.length ? ` Sections: ${describeCandidates(outline.slice(0, 40))}.` : ''}`,
    }
  }
  const entry = found.entry
  const before = sectionBody(content, entry)
  const section = entry.path.join(' > ')
  let next: string
  if (args.op === 'replace') next = replaceSection(content, entry, args.text)
  else if (args.op === 'append') next = appendToSection(content, entry, args.text)
  else next = isSkeletonSection(args.key, entry) ? replaceSection(content, entry, '') : removeSection(content, entry)
  if (next === content) return { ok: false, error: 'That changes nothing: the section already reads that way.' }
  const after = args.op === 'remove' && !isSkeletonSection(args.key, entry) ? '' : (() => {
    const again = findSection(parseOutline(next), section)
    return again.ok ? sectionBody(next, again.entry) : ''
  })()
  return { ok: true, content: next, section, before, after }
}

/** The one-line history summary of an edit. Pure. */
export function canonEditSummary(op: CanonSectionOp | 'revert', section: string, reverts?: number): string {
  if (op === 'revert') return `Reverted the edit to "${section}"${reverts ? ` (revision ${reverts})` : ''}`
  if (op === 'append') return `Added to "${section}"`
  if (op === 'remove') return `Cleared "${section}"`
  return `Updated "${section}"`
}

/**
 * A source as the history keeps it (every reader of the document sees the
 * history): its kind and the row it names, a web page's address, and for an
 * email only the sender's domain, never their address. No free-text note.
 * Pure.
 */
export function historySource(s: CanonSource): CanonSource & { domain?: string } {
  const out: CanonSource & { domain?: string } = { kind: s.kind }
  if (s.id) out.id = s.id
  if (s.url && s.kind === 'web') out.url = s.url
  if (s.kind === 'email') {
    const domain = emailDomain(s.from)
    if (domain) out.domain = domain
  }
  return out
}

/** The metadata kept on the revision (376): bounded strings only, sources as the history keeps them. Pure. */
export function canonEditMeta(meta: CanonEditMeta): CanonEditMeta {
  return {
    section: meta.section.slice(0, 200),
    op: meta.op,
    ...(meta.reason ? { reason: meta.reason.slice(0, 500) } : {}),
    ...(meta.sources?.length ? { sources: meta.sources.slice(0, 10).map(historySource) } : {}),
    ...(meta.reverts ? { reverts: meta.reverts } : {}),
    ...(meta.outside ? { outside: meta.outside.slice(0, 120) } : {}),
  }
}

// ── Applying an edit ──────────────────────────────────────────────────────────

export type CanonEditResult =
  | { ok: true; documentId: string; revision: number; section: string; before: string; after: string; rebased: boolean; title: string | null }
  | { ok: false; reason: 'refused'; error: string }
  | { ok: false; reason: 'invalid'; error: string }
  | { ok: false; reason: 'conflict'; error: string; currentRevision: number }
  | { ok: false; reason: 'not_found' | 'error'; error: string }

export interface ApplyCanonEditArgs {
  workspaceId: string
  userId: string
  documentId: string
  key: string | null
  section: string
  op: CanonSectionOp
  text: string
  reason?: string
  sources?: CanonSource[]
  /** The revision the agent read, when it named one (reported back). */
  baseRevision?: number | null
  /** The outside text the edit rests on (canon-sources.ts canonOutsideLabel): its label in the history and the digest line. */
  outside?: string | null
  /**
   * false: write no digest line for this edit; the caller writes one for its
   * whole batch (an output connector's doc_proposals: at most one line per
   * document per day, appendCanonBatchDigestLine). Default: one line per edit.
   */
  logLine?: boolean
  /**
   * A check on the document as it would be (item 5's budgets and headings,
   * canon-lint.ts): a string refuses the edit with that message.
   */
  check?: (next: { before: string; after: string; content: string; previous: string }) => string | null
}

/**
 * Apply one section edit (see the header). Edit access first; then read, apply,
 * compare-and-swap, and on a conflict once more against the new text. Never
 * throws.
 */
export async function applyCanonSectionEdit(supabase: SupabaseClient, args: ApplyCanonEditArgs): Promise<CanonEditResult> {
  try {
    const { access, error } = await loadDocumentAccess(supabase, args.workspaceId, args.userId, args.documentId)
    if (error) return { ok: false, reason: 'error', error }
    if (!access) return { ok: false, reason: 'not_found', error: 'Document not found' }
    const refusal = documentUpdateRefusal(access, { content: '' })
    if (refusal) return { ok: false, reason: 'refused', error: refusal }

    // The section as the agent saw it: at the revision it read (its
    // base_revision), else as this edit first reads it. A newer write that
    // changed THIS section since is a conflict, never silently rebased over;
    // a write to another section is merged (only this section is touched).
    let expectedSection: string | null | undefined
    if (args.baseRevision != null) {
      const { data: baseRow } = await supabase
        .from('document_revision')
        .select('revision_number, content')
        .eq('document_id', args.documentId)
        .eq('workspace_id', args.workspaceId)
        .eq('revision_number', args.baseRevision)
        .maybeSingle()
      // Not in the history (a person's autosave folded it): judged on the text read now.
      if (baseRow) expectedSection = sectionTextAt((baseRow as { content: string | null }).content ?? '', args.section)
    }

    let lastRevision = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error: readError } = await supabase
        .from('document')
        .select('id, title, content, revision, project_id, canon_key')
        .eq('id', args.documentId)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      if (readError) return { ok: false, reason: 'error', error: readError.message }
      if (!data) return { ok: false, reason: 'not_found', error: 'Document not found' }
      const row = data as { title: string | null; content: string | null; revision?: unknown; project_id?: string | null; canon_key?: string | null }
      const revision = parseRevision(row.revision) ?? 1
      lastRevision = revision
      const current = row.content ?? ''
      const nowSection = sectionTextAt(current, args.section)
      if (expectedSection !== undefined && nowSection !== expectedSection) {
        return {
          ok: false,
          reason: 'conflict',
          error: `"${args.section}" changed since you read it (you read revision ${args.baseRevision ?? revision}; it is at revision ${revision}). Read it again with read_canon and make the edit against the new text.`,
          currentRevision: revision,
        }
      }
      expectedSection = nowSection
      const t = applySectionOp(current, args)
      if (!t.ok) return { ok: false, reason: 'invalid', error: t.error }
      const refused = args.check?.({ before: t.before, after: t.after, content: t.content, previous: current })
      if (refused) return { ok: false, reason: 'invalid', error: refused }

      const meta = canonEditMeta({ section: t.section, op: args.op, reason: args.reason, sources: args.sources, ...(args.outside ? { outside: args.outside } : {}) })
      const written = await writeDocument<{ title: string | null }>(supabase, {
        documentId: args.documentId,
        workspaceId: args.workspaceId,
        baseRevision: revision,
        patch: { content: t.content, edit_meta: meta },
        source: 'agent',
        memberId: access.memberId,
        summary: canonEditSummary(args.op, t.section),
        select: 'id, title',
      })
      if (written.ok) {
        await afterCanonWrite(supabase, {
          workspaceId: args.workspaceId,
          userId: args.userId,
          documentId: args.documentId,
          projectId: row.project_id ?? null,
          content: t.content,
          revision: written.revision,
          section: t.section,
          title: row.title,
          reverted: false,
          ...(args.logLine === false ? { logLine: false } : {}),
          ...(args.outside ? { outside: args.outside } : {}),
          memberId: access.memberId,
          sectionText: args.op === 'remove' ? null : t.after,
          sectionBefore: t.before,
          canon: { key: row.canon_key ?? args.key ?? (access.isProductDoc ? 'product' : null), createdBy: access.row.created_by },
        })
        const changedSinceRead = args.baseRevision != null && args.baseRevision !== revision
        return { ok: true, documentId: args.documentId, revision: written.revision, section: t.section, before: t.before, after: t.after, rebased: changedSinceRead || attempt > 0, title: row.title }
      }
      if (written.reason === 'refused') return { ok: false, reason: 'refused', error: 'Only the creator or an admin can edit this document.' }
      if (written.reason === 'not_found') return { ok: false, reason: 'not_found', error: 'Document not found' }
      if (written.reason === 'error') return { ok: false, reason: 'error', error: written.error }
      // A write landed between the read and this one: read again, once.
    }
    return { ok: false, reason: 'conflict', error: 'This document changed twice while the edit was being applied. Read it again and retry.', currentRevision: lastRevision + 1 }
  } catch (err) {
    return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * What follows every section write that landed, all best effort (none ever
 * fails the edit): re-index the body for search; and, only for a canon
 * document (a canon key, or the product doc): stamp the section checked now
 * (document_section_check, canon D3), keep the document's claims in step
 * (extract from the section, retire the quotes the edit took away:
 * canon-freshness.ts), and the digest line, for the person whose agent made
 * it and for the document's owners (its creator for personal canon, the
 * owners and admins for workspace canon), so whoever answers for it hears
 * about it.
 */
export async function afterCanonWrite(
  supabase: SupabaseClient,
  w: {
    workspaceId: string
    userId: string
    documentId: string
    projectId: string | null
    content: string
    revision: number
    section: string
    title: string | null
    reverted: boolean
    logLine?: boolean
    /** The outside text the edit rests on: said on its digest line. */
    outside?: string | null
    /** Who the write was for (the section's checker). */
    memberId?: string | null
    /** The section's text after the write; null when it was cleared or removed (nothing to extract). */
    sectionText?: string | null
    /** The section's text before the write (which quotes the edit could have taken away). */
    sectionBefore?: string
    /** The document's canon key (null: not canon, so only the re-index runs) and its creator. */
    canon: { key: string | null; createdBy: string | null }
  },
): Promise<void> {
  try {
    await indexDocument(supabase, w.documentId, w.userId, w.projectId, w.content, w.workspaceId)
  } catch (err) {
    console.error('[canon-edit] re-index failed (non-fatal):', err)
  }
  if (!w.canon.key) return
  await stampSectionChecked(supabase, { workspaceId: w.workspaceId, documentId: w.documentId, content: w.content, section: w.section, memberId: w.memberId ?? null, kind: 'agent' })
  await syncCanonClaims(supabase, {
    workspaceId: w.workspaceId,
    userId: w.userId,
    memberId: w.memberId ?? null,
    documentId: w.documentId,
    title: w.title,
    content: w.content,
    section: w.section,
    sectionText: w.sectionText ?? null,
    sectionBefore: w.sectionBefore ?? '',
  })
  // The digest's line is for Native Intelligence's edits; a person's own revert from the history logs none.
  const line = w.logLine === false ? null : logLineFor({ type: 'doc_updated', section: w.section, title: w.title, reverted: w.reverted, from: w.outside ?? null })
  if (line) {
    const readers = new Set<string>([w.userId, ...(await canonOwnerUserIds(supabase, w.workspaceId, w.canon))])
    for (const userId of readers) {
      await appendLogLine(
        { workspaceId: w.workspaceId, userId, kind: line.kind, line: line.line, refType: 'document', refId: w.documentId, dedupeKey: logDedupeKey.docUpdated(w.documentId, w.revision) },
        supabase,
      )
    }
  }
}

/**
 * One digest line for a batch of section edits to one canon document, at most
 * one per document per day (an output connector's doc_proposals, F3): "Native Intelligence
 * updated Messaging and Positioning in Product", for the person whose run made
 * the edits and the document's owners, deduped on the document and the UTC
 * day, so a second batch the same day adds edits to the history but no second
 * line. A batch that rests on outside text says so ("(from outside text)")
 * on a line of its own that day, so the label is never folded away. Never
 * throws.
 */
export async function appendCanonBatchDigestLine(
  supabase: SupabaseClient,
  w: {
    workspaceId: string
    userId: string
    documentId: string
    title: string | null
    sections: readonly string[]
    canon: { key: string | null; createdBy: string | null }
    day?: string
    /** The outside text the batch rests on, when it does. */
    outside?: string | null
  },
): Promise<void> {
  try {
    const names = [...new Set(w.sections.map((s) => s.trim()).filter(Boolean))]
    if (names.length === 0) return
    const section = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]}, ${names[1]} and ${names.length - 2} more`
    const line = logLineFor({ type: 'doc_updated', section, title: w.title, reverted: false, from: w.outside ?? null })
    if (!line) return
    const day = w.day ?? new Date().toISOString().slice(0, 10)
    const readers = new Set<string>([w.userId, ...(await canonOwnerUserIds(supabase, w.workspaceId, w.canon))])
    for (const userId of readers) {
      await appendLogLine(
        { workspaceId: w.workspaceId, userId, kind: line.kind, line: line.line, refType: 'document', refId: w.documentId, dedupeKey: logDedupeKey.docUpdatedDay(w.documentId, day, !!w.outside) },
        supabase,
      )
    }
  } catch (err) {
    console.warn('[canon-edit] batch digest line not written:', err instanceof Error ? err.message : err)
  }
}

/** The auth users behind a canon document's owners (its creator, or the owners and admins), for the digest line. Never throws. */
async function canonOwnerUserIds(supabase: SupabaseClient, workspaceId: string, canon: { key: string | null; createdBy: string | null }): Promise<string[]> {
  try {
    const memberIds = await canonOwnerMemberIds(supabase, workspaceId, { created_by: canon.createdBy }, isPersonalCanonKey(canon.key))
    if (memberIds.length === 0) return []
    const { data } = await supabase.from('member').select('user_id').eq('workspace_id', workspaceId).in('id', memberIds)
    return ((data ?? []) as Array<{ user_id?: unknown }>).map((r) => r.user_id).filter((u): u is string => typeof u === 'string')
  } catch {
    return []
  }
}

/** A section's whole text (heading included) by name, or null when it isn't there. Pure. */
export function sectionTextAt(content: string, section: string): string | null {
  const found = findSection(parseOutline(content), section)
  return found.ok ? splitLines(content).slice(found.entry.line - 1, found.entry.endLine).join('\n') : null
}

// ── Reverting just one edit ───────────────────────────────────────────────────

export type RevertResult =
  | { ok: true; revision: number; section: string; unchanged?: boolean; laterChangesToSection: boolean }
  | { ok: false; reason: 'not_found' | 'revision_not_found' | 'not_section' | 'refused' | 'conflict' | 'error'; error: string }

/**
 * Undo one edit at section level: the section it touched goes back to its
 * text before that edit, as a new revision; every other section stays as it is
 * now (later edits to them are kept). The section is the one the edit's
 * metadata names (376), else the one section the change touched. Never throws.
 */
export async function revertSectionEdit(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; documentId: string; revision: number; source?: 'agent' | 'human' },
): Promise<RevertResult> {
  const source = args.source ?? 'agent'
  try {
    const { access, error } = await loadDocumentAccess(supabase, args.workspaceId, args.userId, args.documentId)
    if (error) return { ok: false, reason: 'error', error }
    if (!access) return { ok: false, reason: 'not_found', error: 'Document not found' }
    const refusal = documentUpdateRefusal(access, { content: '' })
    if (refusal) return { ok: false, reason: 'refused', error: refusal }
    // The Now file changes only through update_now (migration 440); the person's own revert goes on.
    const nowFile = isNowDocument(access.row.frontmatter)
    if (nowFile && source === 'agent') return { ok: false, reason: 'refused', error: NOW_EDIT_REFUSAL }

    const { data: revs, error: revError } = await supabase
      .from('document_revision')
      .select('revision_number, content, edit_meta')
      .eq('document_id', args.documentId)
      .eq('workspace_id', args.workspaceId)
      .lte('revision_number', args.revision)
      .order('revision_number', { ascending: false })
      .limit(2)
    if (revError) return { ok: false, reason: 'error', error: revError.message }
    const rows = (revs ?? []) as Array<{ revision_number: number; content: string | null; edit_meta: unknown }>
    const edit = rows[0]?.revision_number === args.revision ? rows[0] : null
    const previous = edit ? rows[1] : null
    if (!edit) return { ok: false, reason: 'revision_not_found', error: `Revision ${args.revision} is not in this document's history.` }
    if (!previous) return { ok: false, reason: 'not_section', error: 'That is the first version in the history: there is no edit before it to undo.' }

    const meta = edit.edit_meta as Partial<CanonEditMeta> | null
    const section = (typeof meta?.section === 'string' && meta.section) || changedSection(previous.content ?? '', edit.content ?? '')
    if (!section) {
      return { ok: false, reason: 'not_section', error: 'That change touched more than one section (or none): restore the whole version instead (restore_document_revision).' }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const { data } = await supabase
        .from('document')
        .select('title, content, revision, project_id, canon_key')
        .eq('id', args.documentId)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle()
      if (!data) return { ok: false, reason: 'not_found', error: 'Document not found' }
      const row = data as { title: string | null; content: string | null; revision?: unknown; project_id?: string | null; canon_key?: string | null }
      const now = row.content ?? ''
      const revision = parseRevision(row.revision) ?? 1
      const next = putSectionBack(now, previous.content ?? '', edit.content ?? '', section)
      if (next === null) {
        return {
          ok: false,
          reason: 'not_section',
          error: `"${section}" was renamed or removed after that edit, so there is no section to put back. Restore the whole version instead (restore_document_revision).`,
        }
      }
      const laterChangesToSection = sectionTextAt(now, section) !== sectionTextAt(edit.content ?? '', section)
      if (next === now) return { ok: true, revision, section, unchanged: true, laterChangesToSection }

      const written = await writeDocument(supabase, {
        documentId: args.documentId,
        workspaceId: args.workspaceId,
        baseRevision: revision,
        patch: { content: next, edit_meta: canonEditMeta({ section, op: 'revert', reverts: args.revision }) },
        source,
        memberId: access.memberId,
        summary: canonEditSummary('revert', section, args.revision),
      })
      if (written.ok) {
        // The Now file is no canon and never embedded (migration 440): nothing to do after it.
        if (!nowFile) await afterCanonWrite(supabase, {
          workspaceId: args.workspaceId,
          userId: args.userId,
          documentId: args.documentId,
          projectId: row.project_id ?? null,
          content: next,
          revision: written.revision,
          section,
          title: row.title,
          reverted: true,
          logLine: source === 'agent',
          memberId: access.memberId,
          sectionText: sectionTextAt(next, section),
          sectionBefore: sectionTextAt(now, section) ?? '',
          canon: { key: row.canon_key ?? (access.isProductDoc ? 'product' : null), createdBy: access.row.created_by },
        })
        return { ok: true, revision: written.revision, section, laterChangesToSection }
      }
      if (written.reason !== 'conflict') return { ok: false, reason: written.reason === 'refused' ? 'refused' : written.reason === 'not_found' ? 'not_found' : 'error', error: 'error' in written ? written.error : 'Could not revert the edit.' }
    }
    return { ok: false, reason: 'conflict', error: 'This document changed twice while the edit was being reverted. Try again.' }
  } catch (err) {
    return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}

