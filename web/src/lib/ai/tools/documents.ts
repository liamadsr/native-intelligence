import { tool } from 'ai'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { indexDocument } from '@/lib/ai/embeddings'
import { wrapUntrusted } from '@/lib/email/untrusted'
import {
  DELETE_REFUSAL,
  SYSTEM_DOCUMENT_REFUSAL,
  SYSTEM_DOCUMENT_SQLSTATE,
  canDeleteDocument,
  documentUpdateRefusal,
  isPrivateDocument,
  isSystemDocument,
  loadDocumentAccess,
  type DocumentAccess,
} from '@/lib/documents/access'
import { ARCHIVE_MAX_DOCUMENTS, findReports, reportTitleFilter, setDocumentsArchived, type ArchiveOutcome } from '@/lib/documents/archive'
import { approvedDocumentDelete, raiseDocumentDeleteCard } from '@/lib/documents/delete-card'
import { getServiceClient } from '@/lib/supabase/service'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import type { ApprovalContext } from '@/lib/safety/approvals'
import { publishDraft, staleDraftMessage } from '@/lib/documents/publish'
import { describeRevisionAuthor, getDocumentRevision, listDocumentRevisions, restoreDocumentRevision } from '@/lib/documents/revision'
import { diffLines, diffStats, foldDiff } from '@/lib/documents/line-diff'
import {
  appendToSection,
  describeCandidates,
  findMatches,
  findSection,
  insertSectionAfter,
  numberedLines,
  outlineForModel,
  parseOutline,
  rebaseLineRange,
  removeSection,
  replaceLines,
  replaceSection,
  splitLines,
  textToLines,
  type OutlineEntry,
} from '@/lib/documents/markdown-structure'
import { conflictResult, parseRevision, readDocumentRevision, writeDocument } from '@/lib/documents/write'
import { NOW_EDIT_REFUSAL, NOW_READ_REFUSAL, isNowDocument } from '@/lib/now/now-stamp'

/**
 * A document's body as get_document hands it to a model (A5). A page the
 * reference ingest generated from an uploaded file (`frontmatter.generated` with
 * a `source_attachment_id`, src/lib/inngest/reference-ingest.ts) is that file's
 * text restated, so it goes inside the untrusted marker, kind FILE. A document
 * a person or an agent wrote stays as it is: the model edits those by exact
 * text (edit_document_content).
 */
/** Whether a document is marked outside-derived (migration 397). A failed read counts as marked. */
async function documentOutsideDerived(supabase: SupabaseClient, documentId: string, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase.from('document').select('outside_derived').eq('id', documentId).eq('workspace_id', workspaceId).maybeSingle()
  if (error) return true
  return (data as { outside_derived?: unknown } | null)?.outside_derived === true
}

export function documentContentForModel(content: string | null, frontmatter: unknown, outsideDerived = false): string | null {
  const fm = frontmatter && typeof frontmatter === 'object' ? (frontmatter as Record<string, unknown>) : {}
  const fromFile = fm.generated === true && typeof fm.source_attachment_id === 'string'
  if (fromFile) return wrapUntrusted(content, 'FILE')
  // Marked by the server for good (document.outside_derived, migration 397,
  // F3 review R2): its text came from outside, whatever its frontmatter says
  // now. The fence also makes reading it count as reading outside text.
  return outsideDerived ? wrapUntrusted(content, 'WEB') : content
}
import {
  resolveSince,
  resolveUntil,
  timeWindowParams,
  resolveEntityWorkspace,
  resolveCreateWorkspace,
  workspaceEcho,
  applyDocumentVisibility,
  documentRequesterMember,
  isDocumentVisible,
  type CreateWorkspacePolicy,
  type DocumentRequester,
} from './_shared'

/** Who can see a document (migration 369): every member, or only its creator. */
export type DocumentVisibility = 'workspace' | 'private'

const DOCUMENT_TIME_FIELDS = ['updated_at', 'created_at'] as const

/**
 * Past this many characters a document is long: get_document returns its
 * outline and the ways to read part of it instead of the whole body.
 */
export const LONG_DOCUMENT_CHARS = 12_000

/** The most lines one `lines` read returns. */
const MAX_LINES_PER_READ = 400

/**
 * get_document's description. Pinned byte for byte in the live agent's frozen
 * reference (src/lib/live-agent/__tests__/fixtures/live-agent-pre-port.json),
 * which is hand-edited with it.
 */
export const GET_DOCUMENT_DESCRIPTION =
  'Get a document, plus its backlinks (other entities that reference it) and outbound graph edges. ' +
  'A short document comes back whole; a long one (over 12,000 characters) comes back as its outline and how to read part of it. ' +
  'Read just the part you need: `section` (a heading), `lines` ({from, to}), `match` (a phrase: the passages around it, with line numbers and their section) or `outline: true`. ' +
  'Returns `revision`: name it as base_revision when you edit, so a newer change is never overwritten. ' +
  "Resolves cross-workspace when the user is a member of the document's workspace."

/**
 * Best-effort re-index of a document's body into document_chunks (migration
 * 185) after an AI tool wrote its content. Mirrors the capture re-index
 * precedent (captures/[id] PATCH): an embedding failure must never surface as a
 * tool error. indexDocument fetches the live content itself is NOT assumed —
 * callers pass the just-written body so we don't re-read. project_id is fetched
 * once so the chunk carries the doc's project scope.
 */
async function reindexDocumentBestEffort(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
  workspaceId: string,
  content: string | null | undefined,
) {
  try {
    const { data: doc } = await supabase
      .from('document')
      .select('project_id')
      .eq('id', documentId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    await indexDocument(supabase, documentId, userId, doc?.project_id ?? null, content, workspaceId)
  } catch (err) {
    console.error('[documents.tool] re-index failed (non-fatal):', err)
  }
}

export function createDocumentTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  // Trailing positional after `strict`, as ./index.ts threads it. 'session'
  // keeps chat byte-identical; the MCP bridge passes 'explicit'.
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // Private documents (migration 369). An unattended run (a skill run, a work
  // run) omits them: it reads no private document, not even its run-as
  // person's own, because what it writes lands where everyone can read it.
  omitPrivate = false,
  // Who a document create_document writes can be seen by when the call names
  // nothing: 'private' in a run that writes for one person (a meeting prep,
  // a home-turn helper), else 'workspace' (what people create themselves).
  defaultVisibility: DocumentVisibility = 'workspace',
  // delete_document's card (GEN-1169, src/lib/documents/delete-card.ts): the
  // chat it renders in, the door's re-check context, and the accepted card's
  // replay. Never from a model.
  // nowReadable: the person's Now file (docs/plans/now-file.md). get_document
  // and the history tools read it only in the person's own main chat (the
  // chat tool route's nowContext.readable). Every tool here refuses to edit it.
  extra: {
    conversationId?: string | null
    approvedCall?: ApprovedCall
    approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document'>
    nowReadable?: boolean
  } = {},
) {
  const nowReadable = extra.nowReadable === true
  /**
   * The caller's member row per workspace, for the private-document rule: a
   * private document is visible only to the member who created it. Null when
   * private documents are omitted (see omitPrivate).
   */
  const requesterByWs = new Map<string, Promise<DocumentRequester>>()
  function requesterIn(targetWs: string): Promise<DocumentRequester> {
    let r = requesterByWs.get(targetWs)
    if (!r) {
      r = documentRequesterMember(supabase, userId, targetWs, omitPrivate)
      requesterByWs.set(targetWs, r)
    }
    return r
  }

  /** Whether the caller may see this document (its own private one, or a workspace one), and whether it is a Now file. */
  async function documentSight(documentId: string, targetWs: string): Promise<{ visible: boolean; nowFile: boolean }> {
    const { data } = await supabase
      .from('document')
      .select('visibility, created_by, frontmatter')
      .eq('id', documentId)
      .eq('workspace_id', targetWs)
      .maybeSingle()
    const row = data as { visibility?: string | null; created_by?: string | null; frontmatter?: unknown } | null
    return { visible: isDocumentVisible(row, await requesterIn(targetWs)), nowFile: isNowDocument(row?.frontmatter) }
  }

  /** Whether the caller may see this document: its own private one, or a workspace one. */
  async function canSeeDocument(documentId: string, targetWs: string): Promise<boolean> {
    return (await documentSight(documentId, targetWs)).visible
  }

  /** The person's Now file outside their own main chat: the history tools refuse it, as get_document does. */
  const nowReadRefusal = () => ({ success: false as const, code: 'NOW_FILE_PRIVATE' as const, error: NOW_READ_REFUSAL })
  /** Any document tool asked to change the Now file: update_now is the one way. */
  const nowEditRefusal = () => ({ success: false as const, error: NOW_EDIT_REFUSAL, use_instead: 'update_now' as const })
  /**
   * Fence for the action_document join table. Both sides are caller-supplied
   * ids written straight into an insert/delete with no workspace predicate,
   * and MCP hands these tools a service-role client (RLS bypassed) — so this
   * is the only gate. Each id must resolve to a workspace the caller belongs
   * to (or, under strictWorkspace, to the active one), and both must land in
   * the SAME workspace so a link can never straddle two tenants.
   *
   * The failure message never says WHICH id was rejected: a foreign id has to
   * look exactly like a nonexistent one.
   */
  async function linkScopeError(actionId: string, documentId: string) {
    const action = await resolveEntityWorkspace(supabase, userId, 'actions', actionId, workspaceId, strictWorkspace)
    const document = await resolveEntityWorkspace(supabase, userId, 'document', documentId, workspaceId, strictWorkspace)
    if (!action || !document) return { success: false as const, error: 'Action or document not found' }
    // A private document is its creator's alone: to anyone else it doesn't exist.
    if (!(await canSeeDocument(documentId, document.workspaceId))) return { success: false as const, error: 'Action or document not found' }
    if (action.workspaceId !== document.workspaceId) {
      return { success: false as const, error: 'Action and document are in different workspaces' }
    }
    return null
  }

  /**
   * Edit access for a write (migration 359, src/lib/documents/access.ts).
   * These tools run on a SERVICE-ROLE client, so RLS can't cover them: this is
   * the gate. Owner or admin; the creator (not of the product doc); a plain
   * member only on a shared wiki page. A refusal points at
   * propose_document_edit, which writes the caller's own draft instead.
   */
  async function editGate(
    documentId: string,
    targetWs: string,
    patch: Record<string, unknown>,
    refusalTail = 'Use propose_document_edit to save the change as your own draft for the creator or an admin to review.',
    opts: { canonText?: 'allow' } = {},
  ): Promise<{ access: DocumentAccess } | { refused: { success: false; error: string; use_instead?: 'propose_document_edit' | 'propose_section_edit' | 'update_now' } }> {
    const { access, error } = await loadDocumentAccess(supabase, targetWs, userId, documentId)
    if (error) return { refused: { success: false, error } }
    // loadDocumentAccess already hides someone else's private document; a run
    // that omits private documents doesn't see its person's own either.
    if (!access || (omitPrivate && isPrivateDocument(access.row))) return { refused: { success: false, error: 'Document not found' } }
    // The person's Now file (migration 440) changes only through update_now,
    // where its line rules, dates and caps apply, and only from the person's
    // own chat. These tools aren't attended-only, so without this a background
    // turn could write it through them (DOCUMENT_ACCESS_COLUMNS reads the
    // frontmatter already: no extra read).
    if (isNowDocument(access.row.frontmatter)) return { refused: nowEditRefusal() }
    // A canon document's text (a canon key, or the product doc) changes only
    // through propose_section_edit, where the budget, the fixed sections,
    // the grades, the history's sources, the outside-text label and the
    // digest line all apply (canon D2). These tools are an agent's; a person's editor is untouched. Only
    // restoring a version the person asked for stays here.
    if ('content' in patch && opts.canonText !== 'allow' && isSystemDocument(access)) {
      return { refused: canonTextRefusal(access) }
    }
    const refusal = documentUpdateRefusal(access, patch)
    if (refusal) return { refused: { success: false, error: `${refusal} ${refusalTail}`, use_instead: 'propose_document_edit' } }
    return { access }
  }

  const currentRevision = (documentId: string, targetWs: string) => readDocumentRevision(supabase, documentId, targetWs)

  /** Why an agent's text edit to a canon document is refused, and what to use. */
  function canonTextRefusal(access: Pick<DocumentAccess, 'isProductDoc' | 'row'>) {
    const key = access.row.canon_key ?? (access.isProductDoc ? 'product' : null)
    return {
      success: false as const,
      error: `This is a canon document${key ? ` (\`${key}\`)` : ''}: edit it one section at a time with propose_section_edit${key ? ` (key "${key}")` : ''}, so the edit is checked, kept in the history with its sources and shown in the daily digest.`,
      use_instead: 'propose_section_edit' as const,
    }
  }

  /** A write that didn't land, as a tool result. */
  function writeFailure(
    result: Exclude<Awaited<ReturnType<typeof writeDocument>>, { ok: true }>,
    baseRevision: number,
    refusedLine = 'This document could not be edited. Use propose_document_edit to save the change as your own draft.',
  ) {
    if (result.reason === 'conflict') return conflictResult(baseRevision, result.currentRevision)
    if (result.reason === 'not_found') return { success: false as const, error: 'Document not found' }
    if (result.reason === 'refused') return { success: false as const, error: refusedLine, use_instead: 'propose_document_edit' as const }
    return { success: false as const, error: result.error }
  }

  type Transform =
    | { ok: true; content: string; detail?: Record<string, unknown> }
    | { ok: false; error: string; detail?: Record<string, unknown> }

  /**
   * A targeted edit (exact text, a section by heading, a line range), safe
   * against concurrent writes (migration 364): read the body and its
   * revision, apply `transform`, and write only while the document is still
   * at that revision. If another write landed in between, read again and
   * apply the same targeted change to the new text once (it names its target
   * by text or heading, so it still lands in the right place); a second
   * conflict is returned. `transform` gets the revision it runs against.
   *
   * Edit access (editGate) is checked before the first write; a refusal
   * writes nothing. The body is re-indexed after a write that landed.
   */
  async function applyTargetedEdit(opts: {
    documentId: string
    targetWs: string
    /** The revision the agent read, when it named one (only reported back). */
    baseRevision: number | null
    transform: (content: string, revision: number) => Transform | Promise<Transform>
    summary: string
  }) {
    let gate: { access: DocumentAccess } | null = null
    let lastRead = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      const { data, error } = await supabase
        .from('document')
        .select('id, title, content, revision, visibility, created_by, frontmatter')
        .eq('id', opts.documentId)
        .eq('workspace_id', opts.targetWs)
        .maybeSingle()
      if (error) return { success: false as const, error: error.message }
      // A private document is its creator's alone: to anyone else it doesn't exist.
      if (!data || !isDocumentVisible(data as { visibility?: string | null; created_by?: string | null }, await requesterIn(opts.targetWs))) {
        return { success: false as const, error: 'Document not found' }
      }
      // The Now file: refused before its text is read into any result (editGate refuses it too).
      if (isNowDocument((data as { frontmatter?: unknown }).frontmatter)) return nowEditRefusal()
      const revision = parseRevision((data as { revision?: unknown }).revision) ?? 1
      const current = (data as { content?: string | null }).content || ''
      const changedSinceRead = opts.baseRevision !== null && opts.baseRevision !== revision

      const next = await opts.transform(current, revision)
      if (!next.ok) {
        // The agent's text no longer holds once the document moved on: say so.
        if (changedSinceRead) {
          return { ...conflictResult(opts.baseRevision!, revision), error: `${conflictResult(opts.baseRevision!, revision).error} ${next.error}`, ...(next.detail ?? {}) }
        }
        return { success: false as const, error: next.error, ...(next.detail ?? {}) }
      }

      if (!gate) {
        const g = await editGate(opts.documentId, opts.targetWs, { content: next.content })
        if ('refused' in g) return g.refused
        gate = g
      }

      lastRead = revision
      const written = await writeDocument(supabase, {
        documentId: opts.documentId,
        workspaceId: opts.targetWs,
        baseRevision: revision,
        patch: { content: next.content },
        source: 'agent',
        memberId: gate.access.memberId,
        summary: opts.summary,
      })
      if (written.ok) {
        // The body changed: re-index so search matches the edit. Best-effort.
        await reindexDocumentBestEffort(supabase, opts.documentId, userId, opts.targetWs, next.content)
        return {
          success: true as const,
          title: (data as { title?: string }).title ?? null,
          revision: written.revision,
          ...(changedSinceRead || attempt > 0
            ? { rebased: true, note: `The document had changed (you read revision ${opts.baseRevision ?? revision}); the edit was applied to revision ${revision}.` }
            : {}),
          ...(next.detail ?? {}),
        }
      }
      if (written.reason !== 'conflict') return writeFailure(written, revision)
      // Another write landed between the read and the write: read again, once.
    }
    const now = await supabase.from('document').select('revision').eq('id', opts.documentId).eq('workspace_id', opts.targetWs).maybeSingle()
    return conflictResult(lastRead, parseRevision((now.data as { revision?: unknown } | null)?.revision) ?? lastRead + 1)
  }

  /** Where a heading landed after an edit, nearest `nearLine` when it repeats. */
  function placedSection(content: string, heading: string, nearLine = 0) {
    const want = heading.replace(/\s+/g, ' ').trim().toLowerCase()
    const hits = parseOutline(content).filter((e) => e.heading.replace(/\s+/g, ' ').trim().toLowerCase() === want)
    if (hits.length === 0) return null
    const e = hits.reduce((a, b) => (Math.abs(b.line - nearLine) < Math.abs(a.line - nearLine) ? b : a))
    return { heading: e.heading, path: e.path.join(' > '), from_line: e.line, to_line: e.endLine }
  }

  /**
   * A section op (replace_section, append_to_section, remove_section,
   * insert_section_after): find the section by heading in the text as it is
   * now (on a retry, the new text), refuse a missing or ambiguous heading with
   * the candidates, and apply `apply` through applyTargetedEdit.
   */
  async function sectionEdit(opts: {
    documentId: string
    section: string
    baseRevision: number | undefined
    summary: string
    apply: (current: string, entry: OutlineEntry) => string
    /** The heading to report where it landed (default: the section's own). */
    heading?: string
    removed?: boolean
  }) {
    const resolved = await resolveEntityWorkspace(supabase, userId, 'document', opts.documentId, workspaceId, strictWorkspace)
    if (!resolved) return { success: false as const, error: 'Document not found' }
    const result = await applyTargetedEdit({
      documentId: opts.documentId,
      targetWs: resolved.workspaceId,
      baseRevision: parseRevision(opts.baseRevision),
      summary: opts.summary,
      transform: (current) => {
        const toc = parseOutline(current)
        const found = findSection(toc, opts.section)
        if (!found.ok) {
          return {
            ok: false,
            error:
              found.reason === 'ambiguous'
                ? `More than one heading matches "${opts.section}": ${describeCandidates(found.matches)}. Name the path ("Parent > Heading"), or use edit_document_lines.`
                : `No heading matches "${opts.section}".${toc.length ? ` Headings: ${describeCandidates(toc.slice(0, 40))}.` : ' The document has no headings: use edit_document_content or edit_document_lines.'}`,
          }
        }
        const content = opts.apply(current, found.entry)
        if (content === current) return { ok: false, error: 'That changes nothing: the section already reads that way.' }
        return {
          ok: true,
          content,
          detail: opts.removed
            ? { removed_section: found.entry.path.join(' > ') }
            : { section: placedSection(content, opts.heading ?? found.entry.heading, opts.heading ? found.entry.endLine : found.entry.line) },
        }
      },
    })
    return result.success ? { ...result, message: `Edited document "${(result as { title?: string | null }).title ?? ''}"` } : result
  }

  /**
   * archive_document / restore_document: each document in its own workspace
   * (the session's only, under strictWorkspace), each by the caller's own
   * access there (src/lib/documents/archive.ts). A foreign or unseen id reads
   * as not found, and its title is never echoed.
   */
  async function archiveOrRestore(documentIds: readonly string[], archived: boolean) {
    // Postgres hands ids back in lowercase: match them that way.
    const ids = [...new Set(documentIds.map((id) => id.toLowerCase()))]
    let rowsQuery = supabase.from('document').select('id, workspace_id, title').in('id', ids)
    if (strictWorkspace) rowsQuery = rowsQuery.eq('workspace_id', workspaceId)
    const { data, error } = await rowsQuery
    if (error) return { success: false as const, error: error.message }
    const rows = (data ?? []) as Array<{ id: string; workspace_id: string; title: string | null }>
    const byId = new Map(rows.map((r) => [r.id, r]))
    // Grouped in the order the ids were given, so the result reads in that order.
    const byWorkspace = new Map<string, string[]>()
    for (const docId of ids) {
      const r = byId.get(docId)
      if (r) byWorkspace.set(r.workspace_id, [...(byWorkspace.get(r.workspace_id) ?? []), docId])
    }

    const total: ArchiveOutcome = { changed: [], unchanged: [], refused: ids.filter((id) => !byId.has(id)).map((id) => ({ id, reason: 'Document not found' })) }
    const errors: string[] = []
    for (const [ws, wsIds] of byWorkspace) {
      const out = await setDocumentsArchived(supabase, { userId, workspaceId: ws, ids: wsIds, archived, omitPrivate })
      total.changed.push(...out.changed)
      total.unchanged.push(...out.unchanged)
      total.refused.push(...out.refused)
      if (out.error) errors.push(out.error)
    }
    const row = (id: string) => ({ id, workspace_id: byId.get(id)!.workspace_id, title: byId.get(id)!.title })
    const verb = archived ? 'Archived' : 'Restored'
    const n = total.changed.length
    const what = n === 1 ? '1 document' : `${n} documents`
    return {
      success: n > 0 || (total.refused.length === 0 && errors.length === 0),
      [archived ? 'archived' : 'restored']: total.changed.map(row),
      ...(total.unchanged.length ? { [archived ? 'already_archived' : 'not_archived']: total.unchanged.map(row) } : {}),
      ...(total.refused.length ? { refused: total.refused } : {}),
      ...(errors.length ? { error: errors.join(' ') } : {}),
      message:
        n === 0
          ? `Nothing was ${archived ? 'archived' : 'restored'}.`
          : archived
            ? `${verb} ${what}: out of the lists and search, kept with their history. restore_document with these ids puts them back.`
            : `${verb} ${what}: back in the lists and search, as they were.`,
    }
  }

  return {
    list_documents: tool({
      description:
        'List documents in the workspace, optionally filtered by project. Use `since`/`until` with `time_field` for time-window queries (e.g. "documents updated in the past 7 days"). ' +
        // Byte-pinned by the live agent's frozen reference
        // (live-agent/__tests__/fixtures/live-agent-pre-port.json): `archived`
        // says what it does in its own description.
        'Skill and loop reports and meeting preps are left out unless you ask for them (include_reports, include_preps); each row says its kind.',
      inputSchema: z.object({
        project_id: z.string().optional().describe('Filter by project UUID'),
        include_reports: z.boolean().optional().describe('Also list skill and loop reports ("{skill} — {date}")'),
        include_preps: z.boolean().optional().describe('Also list meeting preps'),
        archived: z.boolean().optional().describe('List only archived documents (left out otherwise), e.g. to restore one with restore_document; add include_reports for archived reports'),
        search: z.string().optional().describe('Full-text search query'),
        limit: z.number().optional().default(20).describe('Max results'),
        ...timeWindowParams,
        time_field: z
          .enum(DOCUMENT_TIME_FIELDS)
          .optional()
          .default('updated_at')
          .describe(
            'Which date column `since`/`until` apply to. Defaults to `updated_at` (most recently edited first). ' +
              'Use `created_at` for "documents I created in the past month".',
          ),
      }),
      execute: async ({ project_id, include_reports, include_preps, archived, search, limit, since, until, time_field }) => {
        const sinceISO = resolveSince(since)
        const untilISO = resolveUntil(until)
        const timeField = time_field ?? 'updated_at'
        // document.kind (migration 367): docs, plus reports and preps when asked.
        const kinds = ['doc', ...(include_reports ? ['report'] : []), ...(include_preps ? ['prep'] : [])]

        // Workspace documents, plus the caller's own private ones (migration 369).
        let query = applyDocumentVisibility(
          supabase
            .from('document')
            .select(
              'id, workspace_id, title, project_id, status, kind, visibility, is_pinned, created_at, updated_at, project:projects!project_id(id, name), author:member!created_by(id, display_name)',
            )
            .eq('workspace_id', workspaceId)
            .in('kind', kinds),
          await requesterIn(workspaceId),
        )
        query = archived ? query.eq('status', 'archived') : query.neq('status', 'archived')
        query = query
          .order('is_pinned', { ascending: false })
          .order('updated_at', { ascending: false })
          .limit(limit)

        if (project_id) {
          query = query.eq('project_id', project_id)
        }

        if (search) {
          const tsQuery = search.trim().split(/\s+/).join(' & ')
          query = query.textSearch('fts', tsQuery)
        }

        if (sinceISO) query = query.gte(timeField, sinceISO)
        if (untilISO) query = query.lte(timeField, untilISO)

        const { data, error } = await query

        if (error) return { success: false, error: error.message }

        const documents = (data || []).map((d) => {
          const projectData = d.project as unknown as { id: string; name: string } | null
          const authorData = d.author as unknown as { id: string; display_name: string } | null
          return {
            id: d.id,
            // Every row names its own workspace: an agent holding one row should
            // never have to infer the tenant from the session's active workspace.
            workspace_id: d.workspace_id,
            title: d.title,
            project_id: d.project_id,
            project_name: projectData?.name || null,
            author_name: authorData?.display_name || null,
            status: d.status,
            kind: (d as { kind?: string }).kind ?? 'doc',
            ...((d as { visibility?: string }).visibility === 'private' ? { visibility: 'private' } : {}),
            is_pinned: d.is_pinned,
            created_at: d.created_at,
            updated_at: d.updated_at,
          }
        })

        return {
          success: true,
          documents,
          count: documents.length,
          ...(kinds.length < 3 ? { left_out: [...(include_reports ? [] : ['reports']), ...(include_preps ? [] : ['meeting preps'])].join(' and ') } : {}),
          ...(sinceISO || untilISO
            ? { time_field: timeField, since: sinceISO, until: untilISO }
            : {}),
        }
      },
    }),

    create_document: tool({
      description: 'Create a new document (wiki page, PRD, spec, etc.).',
      inputSchema: z.object({
        title: z.string().describe('Title of the document'),
        content: z.string().optional().describe('Document content (markdown)'),
        project_id: z.string().optional().describe('UUID of the project to link to'),
        team_id: z.string().optional().describe('UUID of the team to link to'),
        workspace_id: z
          .string()
          .optional()
          .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.'),
        visibility: z
          .enum(['workspace', 'private'])
          .optional()
          .describe('Who can see it: "workspace" (everyone in the workspace) or "private" (only the person). Leave it out for the usual default.'),
      }),
      execute: async ({ title, content, project_id, team_id, workspace_id, visibility }) => {
        // ROOT create: decide the tenant FIRST, because everything under it —
        // the created_by member row, the insert, the embedding index — is
        // workspace-scoped and would otherwise silently use the session's.
        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // Resolve current member for created_by — IN THE TARGET WORKSPACE.
        // `member` is per (user, workspace): the session workspace's member id
        // stamped onto a document in another tenant is a cross-workspace FK, and
        // the doc would show an author nobody in that workspace can see.
        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', targetWs)
          .single()

        const insert: Record<string, unknown> = {
          workspace_id: targetWs,
          title,
          content: content || '',
        }
        if (member?.id) insert.created_by = member.id
        // Private documents (migration 369) need their creator.
        const chosen = visibility ?? defaultVisibility
        if (chosen === 'private') {
          if (!member?.id) return { success: false, error: 'A private document needs its creator: you are not a member of that workspace.' }
          insert.visibility = 'private'
        }
        if (project_id) insert.project_id = project_id
        if (team_id) insert.team_id = team_id

        const { data, error } = await supabase
          .from('document')
          .insert(insert)
          .select('id, title, project_id, visibility')
          .single()

        if (error) return { success: false, error: error.message }

        // Index the body for semantic search, into the TARGET workspace's chunks
        // — an index row tagged with the session workspace would make the new
        // doc searchable from the wrong tenant. Best-effort — never fail the tool.
        if (content) {
          await reindexDocumentBestEffort(supabase, data.id, userId, targetWs, content)
        }

        return {
          success: true,
          document: data,
          message: `Created document: "${data.title}"`,
          ...workspaceEcho(targetWs, ws.workspaceName),
        }
      },
    }),

    update_document: tool({
      description:
        'Update an existing document: its title, its whole body, its project or its pin. Only its creator or a workspace owner/admin can (any member may edit a shared, published wiki page); otherwise use propose_document_edit. ' +
        'Replacing the whole body needs base_revision (the revision get_document returned): if the document changed since, nothing is written and you get a conflict, so re-read it. ' +
        'To change part of a document, prefer edit_document_content, edit_document_lines or the section tools (replace_section, append_to_section, remove_section, insert_section_after).',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        base_revision: z
          .number()
          .int()
          .optional()
          .describe('The revision you read (get_document returns it). Required with content; recommended with title.'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New content (markdown): replaces the whole body'),
        project_id: z.string().optional().describe('Move to a different project (empty string to unlink)'),
        is_pinned: z.boolean().optional().describe('Pin/unpin the document'),
        visibility: z
          .enum(['workspace', 'private'])
          .optional()
          .describe('Who can see it: "workspace" or "private" (only its creator). Only its creator can change it; a system document is never private.'),
        change_summary: z.string().optional().describe('One line for the version history (what changed and why)'),
      }),
      execute: async ({ document_id, base_revision, title, content, project_id, is_pinned, visibility, change_summary }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }

        const base = parseRevision(base_revision)
        if (content !== undefined && base === null) {
          return {
            success: false,
            error: 'Pass base_revision (the revision get_document returned) when replacing the whole body, so a newer edit is never overwritten. To change one part, use edit_document_content, edit_document_lines or a section tool instead.',
          }
        }

        const updates: Record<string, unknown> = {}
        if (title !== undefined) updates.title = title
        if (content !== undefined) updates.content = content
        if (project_id !== undefined) updates.project_id = project_id || null
        if (is_pinned !== undefined) updates.is_pinned = is_pinned
        if (visibility !== undefined) updates.visibility = visibility

        const gate = await editGate(document_id, resolved.workspaceId, updates)
        if ('refused' in gate) return gate.refused

        const textChange = title !== undefined || content !== undefined
        if (!textChange) {
          // A project, pin or visibility change: not part of the text, no revision.
          if (gate.access.memberId) updates.last_edited_by = gate.access.memberId
          const { data, error } = await supabase
            .from('document')
            .update(updates)
            .eq('id', document_id)
            .eq('workspace_id', resolved.workspaceId)
            .select('id, title, revision')
            .single()
          if (error) {
            // No row back: RLS refused it (a session client), or it just went away.
            if ((error as { code?: string }).code === 'PGRST116') {
              return { success: false, error: 'This document could not be updated. Use propose_document_edit to save the change as your own draft.', use_instead: 'propose_document_edit' }
            }
            return { success: false, error: error.message }
          }
          return { success: true, document: data, revision: (data as { revision?: number }).revision ?? null, message: `Updated: "${data.title}"` }
        }

        // A title-only rename may go without base_revision: it is checked
        // against the revision read just now instead.
        const baseRevision = base ?? (await currentRevision(document_id, resolved.workspaceId))
        if (baseRevision === null) return { success: false, error: 'Document not found' }
        const written = await writeDocument<{ id: string; title: string }>(supabase, {
          documentId: document_id,
          workspaceId: resolved.workspaceId,
          baseRevision,
          patch: updates,
          source: 'agent',
          memberId: gate.access.memberId,
          summary: change_summary ?? (content !== undefined ? 'Rewrote the document' : `Renamed to "${title}"`),
          select: 'id, title',
        })
        if (!written.ok) {
          return writeFailure(written, baseRevision, 'This document could not be updated. Use propose_document_edit to save the change as your own draft.')
        }

        // Re-index only when the body changed (title/pin/project edits don't
        // touch the vectors). Best-effort — never fail the tool.
        if (content !== undefined) {
          await reindexDocumentBestEffort(supabase, document_id, userId, resolved.workspaceId, content)
        }

        return { success: true, document: written.row, revision: written.revision, message: `Updated: "${written.row.title}"` }
      },
    }),

    edit_document_content: tool({
      description:
        'Make a surgical text edit to a document. Finds the exact old_text and replaces it with new_text. Use this instead of update_document when the user asks to change specific text in a document they are viewing. ' +
        'Safe against concurrent edits: if the document changed since you read it, the edit is applied to the new text as long as old_text is still there exactly once. Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        old_text: z.string().describe('The exact text to find and replace. Must match exactly (including whitespace and punctuation).'),
        new_text: z.string().describe('The replacement text.'),
        base_revision: z.number().int().optional().describe('The revision you read (get_document returns it).'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, old_text, new_text, base_revision, change_summary }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }
        if (!old_text) return { success: false, error: 'old_text is empty. Use edit_document_lines or a section tool to add text.' }

        const result = await applyTargetedEdit({
          documentId: document_id,
          targetWs: resolved.workspaceId,
          baseRevision: parseRevision(base_revision),
          summary: change_summary ?? 'Edited text',
          transform: (stored) => {
            // old_text must be there exactly once. Compared as LF text (CRLF
            // read as LF), as the line and section tools read the body.
            const current = stored.replace(/\r\n?/g, '\n')
            const find = old_text.replace(/\r\n?/g, '\n')
            const occurrences = current.split(find).length - 1
            if (occurrences === 0) {
              return { ok: false, error: 'Text not found in document. Make sure old_text matches exactly, including whitespace and punctuation.' }
            }
            if (occurrences > 1) {
              return { ok: false, error: `Found ${occurrences} occurrences of old_text. Provide more surrounding context to make the match unique.` }
            }
            const at = current.indexOf(find)
            return { ok: true, content: current.slice(0, at) + new_text + current.slice(at + find.length) }
          },
        })
        if (!result.success) return result
        const { title, ...rest } = result as typeof result & { title: string | null }
        return {
          ...rest,
          old_text,
          new_text,
          message: `Edited document "${title ?? ''}"`,
        }
      },
    }),

    get_document: tool({
      description: GET_DOCUMENT_DESCRIPTION,
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        outline: z.boolean().optional().describe('Return the outline: every heading with its level, line number and size'),
        section: z
          .string()
          .optional()
          .describe('Read one section by its heading text (subsections included). Two headings with the same text: name the path, "Parent > Heading"'),
        lines: z
          .object({
            from: z.number().int().describe('First line (1-based)'),
            to: z.number().int().describe('Last line (inclusive)'),
          })
          .optional()
          .describe('Read a line range; the lines come back numbered'),
        match: z
          .string()
          .optional()
          .describe('Find a phrase: the passages around each place it appears (case ignored), numbered, with the section each is in'),
        context_lines: z.number().int().optional().describe('Lines of context either side of each match (default 3, max 20)'),
        full: z.boolean().optional().describe('The whole body even when the document is long'),
      }),
      execute: async ({ document_id, outline, section, lines, match, context_lines, full }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }

        const { data, error } = await supabase
          .from('document')
          .select(
            'id, title, content, content_json, slug, type, tags, frontmatter, outside_derived, project_id, team_id, status, published_status, published_at, is_pinned, revision, canon_key, visibility, created_by, created_at, updated_at, project:projects!project_id(id, name), author:member!created_by(id, display_name)',
          )
          .eq('id', document_id)
          .eq('workspace_id', resolved.workspaceId)
          .single()

        if (error) return { success: false, error: error.message }
        // A private document is its creator's alone: to anyone else it doesn't exist.
        if (!isDocumentVisible(data as { visibility?: string | null; created_by?: string | null }, await requesterIn(resolved.workspaceId))) {
          return { success: false, error: 'Document not found' }
        }
        // The person's Now file reaches their own main chat as its now section;
        // a background turn or a quick helper reads none of it (migration 440).
        if (isNowDocument(data.frontmatter) && !nowReadable) return nowReadRefusal()

        const projectData = data.project as unknown as { id: string; name: string } | null
        const authorData = data.author as unknown as { id: string; display_name: string } | null
        const body: string = data.content ?? ''
        // Text from a generated page is outside text, whichever part is read (A5).
        const forModel = (text: string) => documentContentForModel(text, data.frontmatter, (data as { outside_derived?: unknown }).outside_derived === true)
        const allLines = splitLines(body)
        const toc = parseOutline(body)
        const revision = parseRevision((data as { revision?: unknown }).revision) ?? 1

        const header = {
          id: data.id,
          // The hint below is prose for the agent; this is the machine-readable
          // answer, and it is present whether or not the lookup crossed tenants.
          workspace_id: resolved.workspaceId,
          title: data.title,
          // Name it on a write (base_revision): a write against an older
          // revision is refused instead of overwriting the newer text.
          revision,
          chars: body.length,
          line_count: allLines.length,
          // A system document (migration 366): edited as usual, never deleted.
          ...((data as { canon_key?: string | null }).canon_key ? { canon_key: (data as { canon_key: string }).canon_key, system_document: true } : {}),
          // Only its creator sees a private document (migration 369).
          ...((data as { visibility?: string }).visibility === 'private' ? { visibility: 'private' } : {}),
        }
        // Deliberately NOT "call dial8_set_workspace to switch": switching is a
        // sticky, session-wide side effect that silently re-points every LATER
        // create in the turn. Now that creates take a `workspace_id`, the
        // correct follow-up is to name this id on the call that needs it.
        const crossHint = resolved.crossWorkspace
          ? { workspace_hint: `This document lives in workspace ${resolved.workspaceId}, not the currently active one. Pass workspace_id: "${resolved.workspaceId}" explicitly if you act on it.` }
          : {}
        const withOutline = outline ? { outline: outlineForModel(toc) } : {}

        // ── A part of the document. No links are read: a partial read stays cheap. ──
        if (section !== undefined) {
          const found = findSection(toc, section)
          if (!found.ok) {
            return {
              success: false,
              error:
                found.reason === 'ambiguous'
                  ? `More than one heading matches "${section}": ${describeCandidates(found.matches)}. Name the path ("Parent > Heading").`
                  : `No heading matches "${section}".${toc.length ? ` Headings: ${describeCandidates(toc.slice(0, 40))}.` : ' The document has no headings.'}`,
              document: header,
            }
          }
          const e = found.entry
          return {
            success: true,
            document: header,
            section: { heading: e.heading, path: e.path.join(' > '), level: e.level, from_line: e.line, to_line: e.endLine, chars: e.chars },
            text: forModel(allLines.slice(e.line - 1, e.endLine).join('\n')),
            ...withOutline,
            ...crossHint,
          }
        }
        if (lines !== undefined) {
          const from = Math.max(1, lines.from)
          const to = Math.min(allLines.length, lines.to)
          if (from > to) return { success: false, error: `No lines in ${lines.from}..${lines.to}: the document has ${allLines.length} lines.`, document: header }
          const shownTo = Math.min(to, from + MAX_LINES_PER_READ - 1)
          return {
            success: true,
            document: header,
            from_line: from,
            to_line: shownTo,
            ...(shownTo < to ? { truncated: `Showing ${MAX_LINES_PER_READ} lines; read from line ${shownTo + 1} next.` } : {}),
            text: forModel(numberedLines(allLines, from, shownTo)),
            ...withOutline,
            ...crossHint,
          }
        }
        if (match !== undefined) {
          const found = findMatches(body, match, context_lines ?? 3)
          return {
            success: true,
            document: header,
            match_mode: found.mode,
            total_matches: found.total_matches,
            ...(found.truncated ? { truncated: 'More matches than shown: narrow the phrase, or read by section or lines.' } : {}),
            passages: found.passages.map((p) => ({ ...p, text: forModel(p.text) })),
            ...(found.mode === 'none' ? { note: `"${match}" is not in the document.` } : {}),
            ...withOutline,
            ...crossHint,
          }
        }

        const { data: backlinks } = await supabase
          .from('entity_link')
          .select('id, source_type, source_id, relation')
          .eq('workspace_id', resolved.workspaceId)
          .eq('target_type', 'document')
          .eq('target_id', document_id)
          .limit(50)

        const { data: outbound } = await supabase
          .from('entity_link')
          .select('id, target_type, target_id, relation')
          .eq('workspace_id', resolved.workspaceId)
          .eq('source_type', 'document')
          .eq('source_id', document_id)
          .limit(50)

        // A long document comes back as its outline and how to read part of
        // it, so its middle never falls outside what the model can see.
        const long = body.length > LONG_DOCUMENT_CHARS && !full
        const showBody = !outline && !long

        return {
          success: true,
          document: {
            ...header,
            slug: data.slug,
            type: data.type,
            tags: data.tags || [],
            frontmatter: data.frontmatter || {},
            ...(showBody ? { content: forModel(body) } : {}),
            project_id: data.project_id,
            project_name: projectData?.name || null,
            team_id: data.team_id,
            author_name: authorData?.display_name || null,
            status: data.status,
            published_status: data.published_status,
            published_at: data.published_at,
            is_pinned: data.is_pinned,
            created_at: data.created_at,
            updated_at: data.updated_at,
          },
          ...(showBody ? {} : { outline: outlineForModel(toc) }),
          ...(long && !outline
            ? {
                long_document: true,
                how_to_read: `This document is long (${body.length} characters, ${allLines.length} lines), so only its outline is here. Read the part you need with get_document and section: "<heading>", lines: {from, to}, or match: "<phrase>"; or full: true for the whole body.`,
              }
            : {}),
          backlinks: backlinks || [],
          outbound_links: outbound || [],
          ...crossHint,
        }
      },
    }),

    propose_document_edit: tool({
      description:
        'Stage an edit to a document as a draft for the current user. Does NOT publish — the user must explicitly publish via publish_draft (or the wiki UI). Use this instead of update_document when you\'re proposing changes the user should review. Replaces the full body; for surgical edits use edit_document_content first then call this with the result. ' +
        'Pass base_revision, the revision you read (get_document returns it): the draft records it, so publishing it after the document changed asks first instead of reverting the newer edits.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        base_revision: z.number().int().describe('The revision your draft is based on: the one get_document returned when you read it'),
        title: z.string().optional().describe('New title'),
        content: z.string().optional().describe('New full content (markdown)'),
        frontmatter: z.record(z.string(), z.unknown()).optional().describe('Replacement frontmatter (jsonb)'),
        tags: z.array(z.string()).optional().describe('Replacement tags'),
      }),
      execute: async ({ document_id, base_revision, title, content, frontmatter, tags }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }

        const sight = await documentSight(document_id, resolved.workspaceId)
        if (!sight.visible) return { success: false, error: 'Document not found' }
        // A draft of the Now file would publish around update_now's rules.
        if (sight.nowFile) return nowEditRefusal()
        // The revision the draft was written against, never "now": a draft
        // based on now would publish over edits made since it was read.
        const baseRevision = parseRevision(base_revision)
        if (baseRevision === null) {
          return { success: false, error: 'Pass base_revision (the revision get_document returned), so publishing the draft never reverts a newer edit.' }
        }

        const { data: member } = await supabase
          .from('member')
          .select('id')
          .eq('user_id', userId)
          .eq('workspace_id', resolved.workspaceId)
          .maybeSingle()
        if (!member?.id) return { success: false, error: 'Not a workspace member' }

        const upsert: Record<string, unknown> = {
          document_id,
          workspace_id: resolved.workspaceId,
          author_id: member.id,
          base_revision: baseRevision,
        }
        if (title !== undefined) upsert.title = title
        if (content !== undefined) upsert.content = content
        // A draft never carries a meeting-prep stamp (prep-ref.ts withServerFrontmatter).
        if (frontmatter !== undefined) upsert.frontmatter = withServerFrontmatter(frontmatter) ?? null
        if (Array.isArray(tags)) upsert.tags = tags

        const { data, error } = await supabase
          .from('document_draft')
          .upsert(upsert, { onConflict: 'document_id,author_id' })
          .select('document_id, updated_at')
          .single()
        if (error) return { success: false, error: error.message }

        return {
          success: true,
          draft: { ...data, base_revision: baseRevision },
          message: 'Draft saved. The user can review and publish it.',
        }
      },
    }),

    link_document_to_action: tool({
      description:
        'Link an existing document to an action item. Creates a many-to-many association so the document appears in the action properties panel. ' +
        'To link a document to a project instead, use update_document with project_id.',
      inputSchema: z.object({
        action_id: z.string().describe('UUID of the action to link the document to'),
        document_id: z.string().describe('UUID of the document to link'),
      }),
      execute: async ({ action_id, document_id }) => {
        const scopeError = await linkScopeError(action_id, document_id)
        if (scopeError) return scopeError

        const { data, error } = await supabase
          .from('action_document')
          .insert({ action_id, document_id })
          .select('id')
          .single()

        if (error) {
          if (error.code === '23505')
            return { success: false, error: 'Document is already linked to this action' }
          return { success: false, error: error.message }
        }
        return { success: true, link_id: data.id, message: 'Document linked to action' }
      },
    }),

    unlink_document_from_action: tool({
      description: 'Remove the link between a document and an action item.',
      inputSchema: z.object({
        action_id: z.string().describe('UUID of the action'),
        document_id: z.string().describe('UUID of the document to unlink'),
      }),
      execute: async ({ action_id, document_id }) => {
        const scopeError = await linkScopeError(action_id, document_id)
        if (scopeError) return scopeError

        const { error } = await supabase
          .from('action_document')
          .delete()
          .eq('action_id', action_id)
          .eq('document_id', document_id)

        if (error) return { success: false, error: error.message }
        return { success: true, message: 'Document unlinked from action' }
      },
    }),

    list_action_documents: tool({
      description: 'List documents linked to an action item.',
      inputSchema: z.object({
        action_id: z.string().describe('UUID of the action'),
      }),
      execute: async ({ action_id }) => {
        // `action_document` is a bare join table: no workspace_id of its own, and
        // `action_id` arrives from the model. On the MCP path these tools hold a
        // SERVICE-ROLE client (RLS bypassed), so without this probe ANY action
        // uuid — including one from a tenant the caller has no part in — would
        // read back its linked document titles. Resolve the action first; a
        // foreign action is not-found, exactly as a nonexistent one is, and no
        // join read is issued at all. (link/unlink already fence both sides via
        // linkScopeError above; this is the read half of the same gate.)
        const resolved = await resolveEntityWorkspace(supabase, userId, 'actions', action_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Action not found' }

        const { data, error } = await supabase
          .from('action_document')
          .select(
            'id, document:document!document_id(id, workspace_id, title, updated_at, visibility, owner:created_by, created_by:member!created_by(id, display_name))',
          )
          .eq('action_id', action_id)
          .order('created_at', { ascending: false })

        if (error) return { success: false, error: error.message }

        const requester = await requesterIn(resolved.workspaceId)
        const documents = (data || [])
          .map((row) => {
            const doc = row.document as unknown as {
              id: string
              workspace_id: string
              title: string
              updated_at: string
              visibility?: string | null
              owner?: string | null
              created_by: { id: string; display_name: string } | null
            } | null
            // Defence in depth, and it fails CLOSED. linkScopeError refuses to
            // create a link that straddles two tenants, but rows predating that
            // fence (or a doc moved afterwards) could still point out of the
            // action's workspace — and the join is unfiltered by design.
            if (!doc || doc.workspace_id !== resolved.workspaceId) return null
            // Someone else's private document (migration 369) isn't listed.
            if (!isDocumentVisible({ visibility: doc.visibility, created_by: doc.owner }, requester)) return null
            return {
              link_id: row.id,
              id: doc.id,
              workspace_id: doc.workspace_id,
              title: doc.title,
              updated_at: doc.updated_at,
              created_by_name: doc.created_by?.display_name || null,
            }
          })
          .filter((d): d is NonNullable<typeof d> => d !== null)

        return { success: true, documents, count: documents.length, workspace_id: resolved.workspaceId }
      },
    }),

    publish_draft: tool({
      description:
        'Publish the current user\'s draft of a document. Keeps the replaced version in history, drains the draft, re-syncs wikilinks, and stamps published_at. Use sparingly — most edits should be left in draft for the user to publish themselves. ' +
        'If the document changed since the draft was made, publishing is refused (it would undo the newer edits): tell the person, and pass overwrite: true only when they confirm.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        change_summary: z.string().optional().describe('Short note about what changed'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Publish even though the document changed since the draft was made, replacing the newer edits (they stay in history). Only when the person confirms.'),
      }),
      execute: async ({ document_id, change_summary, overwrite }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }

        const { access, error } = await loadDocumentAccess(supabase, resolved.workspaceId, userId, document_id)
        if (error) return { success: false, error }
        if (!access || (omitPrivate && isPrivateDocument(access.row))) return { success: false, error: 'Document not found' }
        if (!access.memberId) return { success: false, error: 'Not a workspace member' }
        // A draft published over a canon document would skip every canon check,
        // and over the Now file every update_now rule.
        if (isNowDocument(access.row.frontmatter)) return nowEditRefusal()
        if (isSystemDocument(access)) return canonTextRefusal(access)

        const result = await publishDraft<{ id: string; title: string; content: string | null }>(supabase, {
          documentId: document_id,
          workspaceId: resolved.workspaceId,
          access,
          userId,
          source: 'agent',
          changeSummary: change_summary ?? null,
          overwrite: overwrite === true,
          select: 'id, title, content, slug, type, tags, project_id, published_status, published_at',
        })
        if (!result.ok) {
          switch (result.reason) {
            case 'no_draft':
              return { success: false, error: 'No draft to publish' }
            case 'not_found':
              return { success: false, error: 'Document not found' }
            case 'refused':
              // Publishing over the document needs edit access; the draft stays.
              return {
                success: false,
                error: `${result.error} The draft stays saved (propose_document_edit keeps it current); the creator or an admin can publish it.`,
                use_instead: 'propose_document_edit',
              }
            case 'stale_draft':
              return {
                success: false,
                stale_draft: true,
                error: `${staleDraftMessage(result.draftBaseRevision, result.revision)} Tell the person. Re-apply the change to the current text with propose_document_edit, or call publish_draft again with overwrite: true only if they confirm.`,
                draft_base_revision: result.draftBaseRevision,
                current_revision: result.revision,
              }
            case 'conflict':
              return conflictResult(result.baseRevision, result.currentRevision)
            default:
              return { success: false, error: result.error }
          }
        }

        return {
          success: true,
          document: result.document,
          revision: result.revision,
          message: `Published as revision ${result.revision}`,
        }
      },
    }),

    edit_document_lines: tool({
      description:
        'Replace, insert or delete lines of a document by line number (get_document with lines or match shows them numbered). ' +
        'Replaces lines from..to with new_text; to = from - 1 inserts before line `from` without replacing anything (from = line count + 1 appends); an empty new_text deletes the lines. ' +
        'Needs base_revision, the revision those line numbers come from: if the document changed since, the same lines are found in the new text and edited there, or you get a conflict. Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        base_revision: z.number().int().describe('The revision you read the line numbers from (get_document returns it)'),
        from: z.number().int().describe('First line to replace (1-based)'),
        to: z.number().int().describe('Last line to replace (inclusive); from - 1 to insert before `from`'),
        new_text: z.string().describe('The new lines (markdown); empty to delete'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, base_revision, from, to, new_text, change_summary }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }
        const base = parseRevision(base_revision)
        if (base === null) return { success: false, error: 'base_revision is the revision get_document returned with the line numbers.' }

        // The text at base_revision, from the history, to find the same lines
        // again if the document moved on (read once, only when needed).
        let baseText: string | null | undefined
        const added = textToLines(new_text).length
        const result = await applyTargetedEdit({
          documentId: document_id,
          targetWs: resolved.workspaceId,
          baseRevision: base,
          summary: change_summary ?? (to < from ? `Inserted ${added} line${added === 1 ? '' : 's'} at line ${from}` : new_text === '' ? `Deleted lines ${from}–${to}` : `Edited lines ${from}–${to}`),
          transform: async (current, revision) => {
            let range = { from, to }
            if (revision !== base) {
              if (baseText === undefined) {
                const { revision: row } = await getDocumentRevision(supabase, document_id, resolved.workspaceId, base)
                baseText = row ? (row.content ?? '') : null
              }
              const moved = baseText === null ? null : rebaseLineRange(baseText, current, from, to)
              if (!moved) {
                return { ok: false, error: 'Those lines could not be found again in the new text. Read the lines again and edit against the new numbers.' }
              }
              range = moved
            }
            const next = replaceLines(current, range.from, range.to, new_text)
            if (!next.ok) return next
            return { ok: true, content: next.content, detail: { from_line: range.from, to_line: range.from + added - 1, lines_added: added, lines_removed: Math.max(0, range.to - range.from + 1) } }
          },
        })
        return result.success ? { ...result, message: `Edited document "${(result as { title?: string | null }).title ?? ''}"` } : result
      },
    }),

    replace_section: tool({
      description:
        "Replace one section of a document: everything under its heading (subsections included) becomes new_text; the heading stays unless new_heading renames it. The rest of the document is untouched. " +
        'Addressed by heading (an ambiguous one is refused; name the path "Parent > Heading"). Safe against concurrent edits: a document that changed meanwhile gets the same change applied to the new text. Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        section: z.string().describe('The heading text, or a "Parent > Heading" path'),
        new_text: z.string().describe("The section's new body (markdown, without its heading)"),
        new_heading: z.string().optional().describe('Rename the heading too'),
        base_revision: z.number().int().optional().describe('The revision you read (get_document returns it)'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, section, new_text, new_heading, base_revision, change_summary }) =>
        sectionEdit({
          documentId: document_id,
          section,
          baseRevision: base_revision,
          summary: change_summary ?? `Replaced section "${section}"`,
          apply: (current, entry) => replaceSection(current, entry, new_text, new_heading),
          heading: new_heading,
        }),
    }),

    append_to_section: tool({
      description:
        "Add text at the end of one section of a document (before its first subsection), leaving everything else as it is. " +
        'Addressed by heading (an ambiguous one is refused; name the path "Parent > Heading"). Safe against concurrent edits. Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        section: z.string().describe('The heading text, or a "Parent > Heading" path'),
        text: z.string().describe('The text to add (markdown)'),
        base_revision: z.number().int().optional().describe('The revision you read (get_document returns it)'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, section, text, base_revision, change_summary }) =>
        sectionEdit({
          documentId: document_id,
          section,
          baseRevision: base_revision,
          summary: change_summary ?? `Added to section "${section}"`,
          apply: (current, entry) => appendToSection(current, entry, text),
        }),
    }),

    remove_section: tool({
      description:
        'Remove one section of a document: its heading and everything under it, subsections included. ' +
        'Addressed by heading (an ambiguous one is refused; name the path "Parent > Heading"). It stays in the version history (restore_document_revision). Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        section: z.string().describe('The heading text, or a "Parent > Heading" path'),
        base_revision: z.number().int().optional().describe('The revision you read (get_document returns it)'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, section, base_revision, change_summary }) =>
        sectionEdit({
          documentId: document_id,
          section,
          baseRevision: base_revision,
          summary: change_summary ?? `Removed section "${section}"`,
          apply: (current, entry) => removeSection(current, entry),
          removed: true,
        }),
    }),

    insert_section_after: tool({
      description:
        'Add a new section to a document after an existing one (after its subsections), at the same heading level unless you give one; with no `after`, at the end of the document. ' +
        'Addressed by heading (an ambiguous one is refused; name the path "Parent > Heading"). Safe against concurrent edits. Returns the new revision.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        after: z.string().optional().describe('The heading (or "Parent > Heading" path) to insert after; omit to add at the end'),
        heading: z.string().describe("The new section's heading text"),
        text: z.string().describe("The new section's body (markdown)"),
        level: z.number().int().optional().describe('Heading level 1-6 (default: the level of `after`, or 2)'),
        base_revision: z.number().int().optional().describe('The revision you read (get_document returns it)'),
        change_summary: z.string().optional().describe('One line for the version history'),
      }),
      execute: async ({ document_id, after, heading, text, level, base_revision, change_summary }) => {
        if (!heading.trim()) return { success: false, error: 'heading is empty.' }
        const lvl = level === undefined ? undefined : Math.min(6, Math.max(1, Math.floor(level)))
        if (after === undefined || after.trim() === '') {
          const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
          if (!resolved) return { success: false, error: 'Document not found' }
          return applyTargetedEdit({
            documentId: document_id,
            targetWs: resolved.workspaceId,
            baseRevision: parseRevision(base_revision),
            summary: change_summary ?? `Added section "${heading.trim()}"`,
            transform: (current) => {
              const content = insertSectionAfter(current, null, heading, text, lvl)
              return { ok: true, content, detail: { section: placedSection(content, heading) } }
            },
          })
        }
        return sectionEdit({
          documentId: document_id,
          section: after,
          baseRevision: base_revision,
          summary: change_summary ?? `Added section "${heading.trim()}" after "${after}"`,
          apply: (current, entry) => insertSectionAfter(current, entry, heading, text, lvl),
          heading,
        })
      },
    }),

    list_document_revisions: tool({
      description:
        'List a document\'s version history, newest first: one entry per change to its title or body, with who it was for (a person, Native Intelligence for a person, or the system), a one-line summary and when. ' +
        'The newest entry is the document as it is now; a section edit names its section, reason and sources, and `outside` when it rested on outside text. Use get_document_revision to see one version and what it changed, restore_document_revision to put one back, revert_section_edit to undo just one edit.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        limit: z.number().int().optional().describe('How many entries (default 20, max 100)'),
        before: z.number().int().optional().describe('Page back: only revisions below this number'),
      }),
      execute: async ({ document_id, limit, before }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        const sight = resolved ? await documentSight(document_id, resolved.workspaceId) : null
        if (!resolved || !sight?.visible) return { success: false, error: 'Document not found' }
        if (sight.nowFile && !nowReadable) return nowReadRefusal()
        const [{ revisions, error }, current] = await Promise.all([
          listDocumentRevisions(supabase, document_id, resolved.workspaceId, { limit: limit ?? 20, before: before ?? null }),
          currentRevision(document_id, resolved.workspaceId),
        ])
        if (error) return { success: false, error }
        return {
          success: true,
          document_id,
          current_revision: current,
          revisions: revisions.map((r) => ({
            revision: r.revision_number,
            by: describeRevisionAuthor(r),
            author_kind: r.author_kind,
            summary: r.change_summary,
            ...(r.section ? { section: r.section } : {}),
            ...(r.reason ? { reason: r.reason } : {}),
            ...(r.sources?.length ? { sources: r.sources } : {}),
            title: r.title,
            at: r.updated_at,
            ...(r.revision_number === current ? { current: true } : {}),
          })),
          ...(revisions.length === 0 ? { note: 'No history yet: the document has not changed since it was created (or since history began).' } : {}),
        }
      },
    }),

    get_document_revision: tool({
      description:
        'Read one version of a document from its history: what that change did (a line diff against the version before it, or against the document now), and the version\'s text. ' +
        'Long versions return only the diff unless you ask for include_content.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        revision: z.number().int().describe('The revision number (list_document_revisions)'),
        compare_to: z
          .enum(['previous', 'current'])
          .optional()
          .describe('Diff against the version before it (default: what this change did) or against the document now (what restoring it would change)'),
        include_content: z.boolean().optional().describe('Include the version\'s full text (default: only for short documents)'),
      }),
      execute: async ({ document_id, revision, compare_to, include_content }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        const sight = resolved ? await documentSight(document_id, resolved.workspaceId) : null
        if (!resolved || !sight?.visible) return { success: false, error: 'Document not found' }
        if (sight.nowFile && !nowReadable) return nowReadRefusal()
        const { revision: row, previous, error } = await getDocumentRevision(supabase, document_id, resolved.workspaceId, revision)
        if (error) return { success: false, error }
        if (!row) return { success: false, error: `Revision ${revision} is not in this document's history. Use list_document_revisions.` }

        let against: { label: string; content: string } | null = null
        if (compare_to === 'current') {
          const { data } = await supabase.from('document').select('content, revision').eq('id', document_id).eq('workspace_id', resolved.workspaceId).maybeSingle()
          against = { label: `the document now (revision ${(data as { revision?: number } | null)?.revision ?? '?'})`, content: (data as { content?: string | null } | null)?.content ?? '' }
        } else if (previous) {
          against = { label: `revision ${previous.revision_number}`, content: previous.content ?? '' }
        }

        const content = row.content ?? ''
        const showContent = include_content ?? content.length <= LONG_DOCUMENT_CHARS
        let diff: string | null = null
        let stats: { added: number; removed: number } | null = null
        if (against) {
          // From the other version to this one, or from this one to now.
          const lines = compare_to === 'current' ? diffLines(content, against.content) : diffLines(against.content, content)
          stats = diffStats(lines)
          diff = foldDiff(lines, 2)
            .slice(0, 400)
            .map((l) => (l.kind === 'fold' ? `… ${l.count} unchanged line${l.count === 1 ? '' : 's'}` : `${l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '} ${l.text}`))
            .join('\n')
        }
        return {
          success: true,
          document_id,
          revision: row.revision_number,
          by: describeRevisionAuthor(row),
          author_kind: row.author_kind,
          summary: row.change_summary,
          at: row.updated_at,
          title: row.title,
          ...(against
            ? { diff_against: against.label, diff_direction: compare_to === 'current' ? 'this version → now' : 'before → this version', lines_added: stats!.added, lines_removed: stats!.removed, diff }
            : { note: 'The first version in history: nothing to compare it with.' }),
          ...(showContent
            ? { content: documentContentForModel(content, row.frontmatter, await documentOutsideDerived(supabase, document_id, resolved.workspaceId)) }
            : { content_omitted: `${content.length} characters; pass include_content: true to read it.` }),
        }
      },
    }),

    restore_document_revision: tool({
      description:
        'Put an earlier version of a document back (its title and body), as a new revision, so the restore can itself be undone. Use it to undo an edit: find the version with list_document_revisions. ' +
        'Only for a person in the conversation who asked for it. Same edit access as update_document. Pass base_revision (the revision you saw as current) so a newer change is never thrown away unseen.',
      inputSchema: z.object({
        document_id: z.string().describe('UUID of the document'),
        revision: z.number().int().describe('The revision to restore'),
        base_revision: z.number().int().optional().describe('The document\'s current revision as you saw it (list_document_revisions current_revision)'),
      }),
      execute: async ({ document_id, revision, base_revision }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }
        // Restoring a version the person asked for is the one text write a canon document takes outside propose_section_edit.
        const gate = await editGate(document_id, resolved.workspaceId, { content: '' }, 'Ask the creator or an admin to restore it.', { canonText: 'allow' })
        if ('refused' in gate) return gate.refused
        const result = await restoreDocumentRevision(supabase, {
          documentId: document_id,
          workspaceId: resolved.workspaceId,
          access: gate.access,
          userId,
          revisionNumber: revision,
          baseRevision: parseRevision(base_revision),
          source: 'agent',
        })
        if (!result.ok) {
          switch (result.reason) {
            case 'not_found':
              return { success: false, error: 'Document not found' }
            case 'revision_not_found':
              return { success: false, error: `Revision ${revision} is not in this document's history. Use list_document_revisions.` }
            case 'refused':
              return { success: false, error: result.error }
            case 'conflict':
              return conflictResult(result.baseRevision, result.currentRevision)
            default:
              return { success: false, error: result.error }
          }
        }
        return {
          success: true,
          revision: result.revision,
          restored_from: result.restoredFrom,
          message: result.unchanged
            ? `The document already matches revision ${result.restoredFrom}; nothing changed.`
            : `Restored revision ${result.restoredFrom} as revision ${result.revision}. Restoring revision ${result.revision - 1} undoes this.`,
        }
      },
    }),

    // GEN-1169: archiving is the soft delete (status 'archived': kept, with its
    // history, and restorable); delete_document is the hard one, on a card.
    archive_document: tool({
      description:
        'Archive documents: they leave the document lists and search but are kept, with their whole history, and restore_document puts them back as they were. ' +
        'For stale reports, throwaway meeting preps and duplicates; for many skill or loop reports at once, use archive_reports. ' +
        'Only their creator or a workspace owner/admin can, and never a canon document. Use this rather than delete_document unless the person asks for a permanent delete.',
      inputSchema: z.object({
        document_ids: z.array(z.string().uuid()).min(1).max(ARCHIVE_MAX_DOCUMENTS).describe('The documents to archive, by id'),
      }),
      execute: async ({ document_ids }) => archiveOrRestore(document_ids, true),
    }),

    restore_document: tool({
      description:
        'Bring archived documents back (undoes archive_document or archive_reports): each returns to the lists and search exactly as it was. ' +
        'Find archived ones with list_documents (archived: true). Needs edit access, as update_document does. To undo an edit to a document, use restore_document_revision instead.',
      inputSchema: z.object({
        document_ids: z.array(z.string().uuid()).min(1).max(ARCHIVE_MAX_DOCUMENTS).describe('The archived documents to restore, by id'),
      }),
      execute: async ({ document_ids }) => archiveOrRestore(document_ids, false),
    }),

    archive_reports: tool({
      description:
        'Archive many skill or loop reports ("{skill} — {date}"), or meeting preps, in one call: the ones created more than `older_than_days` ago, or in a window (`since`/`until`: "last month\'s" is since and until last_month), ' +
        'and only one skill\'s when you name it (`title`: the skill\'s name as the titles start, e.g. "Morning brief"; or its `skill_id`). Name at least one of these. ' +
        'Only the person\'s own reports, unless an owner or admin asks for teammates\' too (include_others). ' +
        `Archived reports leave the lists and search, keep their history, and come back with restore_document (the result lists their ids). Pinned ones are left alone. At most ${ARCHIVE_MAX_DOCUMENTS} per call, oldest first. Never touches other documents.`,
      inputSchema: z.object({
        older_than_days: z.number().int().min(0).max(3650).optional().describe('Only those created more than this many days ago'),
        ...timeWindowParams,
        title: z.string().optional().describe('Only those whose title contains this (case ignored): the skill\'s name, e.g. "Morning brief"'),
        skill_id: z.string().uuid().optional().describe('Only the reports this skill wrote (an id from list_skills)'),
        kind: z.enum(['report', 'prep']).optional().default('report').describe('"report" (skill and loop reports, the default) or "prep" (meeting preps)'),
        include_others: z.boolean().optional().describe("Also teammates' reports, not only the person's own (an owner or admin only, when they ask for the whole workspace's)"),
      }),
      execute: async ({ older_than_days, since, until, title, skill_id, kind, include_others }) => {
        // `*` can't be matched literally (reportTitleFilter): a title of only `*` is no filter.
        const titleText = reportTitleFilter(title)
        const named = older_than_days !== undefined || !!since || !!until || !!titleText || !!skill_id
        if (!named) {
          return { success: false, error: 'Say which reports: older_than_days, a since/until window, a title or a skill_id. Nothing was archived.' }
        }
        // A bound that doesn't parse must refuse, never widen the archive to everything.
        const sinceISO = resolveSince(since)
        // A bare date as the upper bound means the end of that day.
        const untilISO = until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? resolveUntil(`${until}T23:59:59.999Z`) : resolveUntil(until)
        if ((since && !sinceISO) || (until && !untilISO)) {
          return { success: false, error: `"${since && !sinceISO ? since : until}" is not a date or one of the presets. Nothing was archived.` }
        }

        // Whose: the person's own by default. Only an owner or admin may archive
        // teammates' (the delete-level rule), so a member's read never fills up
        // with reports they can't archive.
        const { data: me } = await supabase.from('member').select('id, role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
        const member = me as { id?: string; role?: string } | null
        if (!member?.id) return { success: false, error: 'You are not a member of this workspace. Nothing was archived.' }
        const isAdmin = member.role === 'owner' || member.role === 'admin'
        if (include_others && !isAdmin) {
          return { success: false, error: "Only an owner or admin can archive teammates' reports. Leave include_others out to archive the person's own. Nothing was archived." }
        }

        const filter = {
          kind: kind ?? 'report',
          olderThanDays: older_than_days,
          since: sinceISO,
          until: untilISO,
          title: titleText,
          skillId: skill_id,
          createdBy: include_others ? null : member.id,
        }
        const requester = await requesterIn(workspaceId)
        // Pinned ones are read apart (only to say they were left alone), so they
        // never fill the batch: every row read here is one to archive.
        const [found, pinnedFound] = await Promise.all([
          findReports(supabase, { workspaceId, requester, filter: { ...filter, pinned: false }, limit: ARCHIVE_MAX_DOCUMENTS + 1 }),
          findReports(supabase, { workspaceId, requester, filter: { ...filter, pinned: true }, limit: 20 }),
        ])
        if (found.error) return { success: false, error: found.error }
        const more = found.rows.length > ARCHIVE_MAX_DOCUMENTS
        const candidates = found.rows.slice(0, ARCHIVE_MAX_DOCUMENTS)
        const pinned = pinnedFound.rows
        const noun = (kind ?? 'report') === 'prep' ? 'meeting preps' : 'reports'
        const leftPinned = pinned.length ? { left_pinned: pinned.map((r) => ({ id: r.id, title: r.title })) } : {}
        const pinnedLine = pinned.length ? ` ${pinned.length === 20 ? '20 or more' : pinned.length} pinned ${pinned.length === 1 ? 'one was' : 'ones were'} left alone.` : ''
        if (candidates.length === 0) {
          return {
            success: true,
            archived: [],
            ...leftPinned,
            message: `No unpinned active ${noun} match. Nothing was archived.${pinnedLine}`,
          }
        }

        const out = await setDocumentsArchived(supabase, { userId, workspaceId, ids: candidates.map((r) => r.id), archived: true, omitPrivate })
        if (out.error && out.changed.length === 0) return { success: false, error: out.error }
        const changed = new Set(out.changed)
        const archived = candidates.filter((r) => changed.has(r.id)).map((r) => ({ id: r.id, title: r.title, created_at: r.created_at }))
        const n = archived.length
        return {
          success: true,
          workspace_id: workspaceId,
          archived,
          ...leftPinned,
          ...(out.refused.length ? { refused: out.refused } : {}),
          ...(more ? { more: true } : {}),
          message:
            (n === 0
              ? `Nothing was archived: none of the ${candidates.length} matching ${noun} could be.`
              : `Archived ${n} ${n === 1 ? noun.replace(/s$/, '') : noun}: out of the lists and search, kept with their history. restore_document with these ids puts them back.`) +
            pinnedLine +
            (more ? ` More match: call again to archive the next ${ARCHIVE_MAX_DOCUMENTS}.` : ''),
        }
      },
    }),

    delete_document: tool({
      description:
        "Delete a document for good, with its whole history and anything learned only from it. Never immediate: it raises the person's approval card, and the document is deleted only when they accept. " +
        'Only when the person asks for a permanent delete; otherwise use archive_document, which can be undone. Only its creator or a workspace owner/admin can, and never a canon document.',
      inputSchema: z.object({
        document_id: z.string().uuid().describe('The document to delete, by id'),
      }),
      execute: async ({ document_id }) => {
        const resolved = await resolveEntityWorkspace(supabase, userId, 'document', document_id, workspaceId, strictWorkspace)
        if (!resolved) return { success: false, error: 'Document not found' }
        const ws = resolved.workspaceId
        const { access, error: accessError } = await loadDocumentAccess(supabase, ws, userId, document_id)
        if (accessError) return { success: false, error: accessError }
        if (!access || !access.role || (omitPrivate && isPrivateDocument(access.row))) return { success: false, error: 'Document not found' }
        // A canon document (a canon key, or the product doc: migration 366) is never deleted, card or not.
        if (isSystemDocument(access)) return { success: false, code: 'SYSTEM_DOCUMENT', error: `${SYSTEM_DOCUMENT_REFUSAL} Canon documents are never deleted or archived.` }
        if (!canDeleteDocument(access)) return { success: false, error: DELETE_REFUSAL }

        const { data: doc } = await supabase.from('document').select('title, revision').eq('id', document_id).eq('workspace_id', ws).maybeSingle()
        if (!doc) return { success: false, error: 'Document not found' }
        const title = ((doc as { title?: string | null }).title ?? '').trim().slice(0, 120) || 'Untitled'
        const revision = parseRevision((doc as { revision?: unknown }).revision) ?? 1

        // The person accepted the card: delete, if it is still what the card showed.
        const approved = approvedDocumentDelete(extra.approvedCall, document_id)
        if (approved) {
          if (approved.revision !== revision) {
            return { success: false, code: 'DOCUMENT_CHANGED', error: 'The document changed after its card was made, so it was not deleted. Ask again: a new card shows it as it is now.' }
          }
          // The app's own permanent delete (migration 178/359): it re-checks the
          // creator-or-admin rule, prunes what was learned only from it, and the
          // 366 guard refuses a system document.
          const { error } = await supabase.rpc('delete_document_with_knowledge', { p_document_id: document_id, p_workspace_id: ws, p_user_id: userId })
          if (error) {
            const code = (error as { code?: string }).code
            if (code === 'P0002') return { success: false, error: 'Document not found' }
            if (code === SYSTEM_DOCUMENT_SQLSTATE) return { success: false, code: 'SYSTEM_DOCUMENT', error: SYSTEM_DOCUMENT_REFUSAL }
            if (code === '42501') return { success: false, error: DELETE_REFUSAL }
            return { success: false, error: error.message }
          }
          return { success: true, message: `Deleted "${title}" for good, after the person accepted its card.` }
        }

        const { count } = await supabase.from('document_revision').select('id', { count: 'exact', head: true }).eq('document_id', document_id)
        const versions = typeof count === 'number' && count > 0 ? count : 1
        const history = versions === 1 ? '1 version' : `${versions} versions`
        const held = await raiseDocumentDeleteCard(getServiceClient(), {
          userId,
          workspaceId: ws,
          // The real argument plus what the card shows (the schema strips those
          // on replay). The revision keeps a card for an older state from being reused.
          input: { document_id, document: title, history, revision },
          card: {
            title: `Delete "${title}" for good?`,
            why: `Deletes it with its ${history} of history and anything learned only from it. This can't be undone; archiving it instead keeps everything.`,
          },
          context: { kind: 'delete', document_id, revision },
          approvalContext: extra.approvalContext,
          conversationId: extra.conversationId ?? null,
        })
        return {
          success: false,
          code: 'APPROVAL_REQUIRED',
          approval_id: held.approval_id,
          message: held.ok
            ? `Nothing is deleted yet. The person has a card to delete "${title}" and its ${history} of history, in the chat right under your message; it is deleted only if they accept. Tell them it is waiting there; do not call delete_document again.`
            : `Nothing was deleted, and no card could be made: ${held.error ?? 'unknown error'} Tell the person; they can delete it from the document's menu, or you can archive it instead.`,
        }
      },
    }),
  }
}
