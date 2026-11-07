import type { SupabaseClient } from '@supabase/supabase-js'
import { CITABLE_SOURCE_TYPES } from '@/lib/knowledge/entity-registry'

/**
 * Capture-visibility gating for claims on UNATTENDED, workspace-readable paths
 * (the nightly knowledge weaver and the briefs it compiles).
 *
 * Lives in `lib/knowledge` rather than `lib/inngest` so both the weaver and
 * `brief.ts` can import it: the weaver already imports from `lib/knowledge`, so
 * the reverse direction would be a cycle.
 *
 * See docs/design-capture-visibility.md — these surfaces run with NO requester,
 * so a claim sourced solely from private captures must never be laundered into
 * a document every member can open.
 *
 * Mail (2026-10-15, migration 341): Dial8 doesn't learn from mail. A claim with
 * ANY `email` source is visible to no one: not the workspace, not the person
 * whose mail it came from. More generally, a claim is readable only when one
 * of its sources is (the private-capture rule below now covers every reader,
 * not only unattended runs). The SQL twin is `public.claim_visible_to` (and
 * the RESTRICTIVE policies on claim / claim_source / claim_chunks); the
 * helpers below are the app's copy for reads that run service-role or before
 * 341 is applied. The rows themselves stay until the purge.
 *
 * Chats (Liam, 2026-10-17; migration 353): what Dial8 learns from a person's
 * chat is theirs. A `conversation` source is readable only by the person whose
 * conversation it is (chat_conversations.user_id), and by no one on an
 * unattended run (the weaver, briefs): a claim known only from someone's chat
 * is theirs and their agent's, and never reaches a shared brief or merge. A
 * claim that is also known from a meeting or document stays shared, minus the
 * chat's own evidence row. A deleted conversation counts as hidden, as a
 * deleted capture does.
 *
 * Dedupe never widens (2026-10-18): extraction and the live agent dedupe a new
 * claim onto an existing one and then ATTACH the new source to it. Under the
 * any-visible-source rule, attaching a source that more people can read widens
 * the claim to them, so the dedupe read is scoped to the NEW source's own
 * audience (`dedupeRequesterFor` below): a private chat claim is matched only
 * by that person's own private sources, never by their workspace meeting or a
 * published doc (those fork a new shared claim instead).
 */

/** `claim_source.source_type` / entity types that are mail. */
export const MAIL_SOURCE_TYPES: ReadonlySet<string> = new Set(['email'])

export function isMailSourceType(type: string | null | undefined): boolean {
  return typeof type === 'string' && MAIL_SOURCE_TYPES.has(type)
}

/** `claim_source.source_type` / entity type of a chat conversation: private to the person who had it. */
export const CONVERSATION_SOURCE_TYPE = 'conversation'

/**
 * claim_visible_to's conversation rule (353): the requester's own
 * conversation only, so never for no requester, and never for an unknown
 * (deleted) one.
 */
export function conversationVisibleTo(ownerId: string | null | undefined, requester: string | null): boolean {
  return requester !== null && typeof ownerId === 'string' && ownerId === requester
}

/**
 * The ids among `conversationIds` that `requester` may not see: everyone
 * else's chats, and ids that no longer exist. All of them for no requester.
 * `null` when a read failed: callers fail closed.
 */
export async function conversationIdsHiddenFrom(
  supabase: SupabaseClient,
  conversationIds: readonly string[],
  requester: string | null,
): Promise<Set<string> | null> {
  const ids = [...new Set(conversationIds)]
  if (ids.length === 0 || requester === null) return new Set(ids)
  const owned = await readRowsByIds<{ id: string; user_id: string | null }>(ids, (c) =>
    supabase.from('chat_conversations').select('id, user_id').in('id', c),
  )
  if (!owned) return null
  const mine = new Set(owned.filter((r) => conversationVisibleTo(r.user_id, requester)).map((r) => r.id))
  return new Set(ids.filter((id) => !mine.has(id)))
}

/** Claim ids per `.in()` request: keeps each request URL bounded and each
 *  answer far under PostgREST's 1000-row cap (a claim has a handful of
 *  sources at most). */
const MAIL_ID_CHUNK = 100
/** Rows one request returns at most (PostgREST's default cap). */
const MAIL_PAGE_SIZE = 1000

/**
 * The ids among `claimIds` that have a mail source. `null` when any read
 * failed: callers fail closed (treat every claim as hidden), because a missed
 * row would show a claim learned from mail. A chunk whose answer reaches the
 * row cap may be truncated, so every claim in it counts as hidden.
 */
export async function mailSourcedClaimIds(
  supabase: SupabaseClient,
  claimIds: readonly string[],
): Promise<Set<string> | null> {
  const ids = [...new Set(claimIds)]
  const out = new Set<string>()
  if (ids.length === 0) return out
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += MAIL_ID_CHUNK) chunks.push(ids.slice(i, i + MAIL_ID_CHUNK))
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabase
        .from('claim_source')
        .select('claim_id, source_type')
        .in('claim_id', chunk)
        .eq('source_type', 'email')
        .limit(MAIL_PAGE_SIZE)
      if (error) return false
      const rows = (data ?? []) as Array<{ claim_id: string; source_type: string | null }>
      if (rows.length >= MAIL_PAGE_SIZE) {
        for (const id of chunk) out.add(id)
        return true
      }
      for (const r of rows) if (isMailSourceType(r.source_type)) out.add(r.claim_id)
      return true
    }),
  )
  return results.every(Boolean) ? out : null
}

/**
 * Every claim id in a workspace that has a mail source, for whole-workspace
 * reads (the knowledge graph) where chunking thousands of ids would cost tens
 * of requests. One paged read of the mail rows only. claim_source.workspace_id
 * is nullable (migration 117 backfilled it; writers set it), so rows without
 * one are read too: they carry only a claim id, and a user client's RLS keeps
 * them to the caller's workspaces. `null` when a read failed (fail closed).
 */
export async function mailSourcedClaimIdsInWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<Set<string> | null> {
  const out = new Set<string>()
  for (let offset = 0; ; offset += MAIL_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('claim_source')
      .select('claim_id, source_type')
      .eq('source_type', 'email')
      .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
      .order('id', { ascending: true })
      .range(offset, offset + MAIL_PAGE_SIZE - 1)
    if (error) return null
    const page = (data ?? []) as Array<{ claim_id: string; source_type: string | null }>
    for (const r of page) if (isMailSourceType(r.source_type)) out.add(r.claim_id)
    if (page.length < MAIL_PAGE_SIZE) return out
  }
}

// ---------------------------------------------------------------------------
// The full rule, for a requester (migration 341: claims follow their sources)
// ---------------------------------------------------------------------------
//
// A claim is readable only when one of its sources is: the SQL twin is
// `public.claim_visible_to(id, requester)`, and RLS holds the same rule through
// `claims_hidden_from_me()`. These are the app's copy for service-role reads
// (the agent's tools) and for reads before 341 / 353 are applied. `requester`
// is the person reading; `null` means no requester, so only workspace-visible
// captures count and no chat does (an unattended run, or a tool told to omit
// private captures).

/** The capture columns the claim rule reads. */
interface CaptureVisibilityRow {
  id: string
  visibility?: string | null
  user_id?: string | null
  is_eval?: boolean | null
}

/** claim_visible_to's capture rule: not an eval, and workspace-visible or the requester's own. */
export function captureVisibleTo(
  capture: Omit<CaptureVisibilityRow, 'id'> | undefined,
  requester: string | null,
): boolean {
  if (!capture) return false
  if (capture.is_eval === true) return false
  if (capture.visibility !== 'private') return true
  return requester !== null && capture.user_id === requester
}

/**
 * A document's visibility (migration 369): 'workspace' or 'private', and its
 * creator's auth uid (document.created_by is a member row; this is that
 * member's user_id).
 */
export interface DocumentVisibilityRow {
  visibility: string | null
  owner_user_id: string | null
}

/** claim_visible_to's document rule (369): workspace-visible, or the requester's own private one. A missing document is hidden. */
export function documentVisibleTo(doc: DocumentVisibilityRow | undefined, requester: string | null): boolean {
  if (!doc) return false
  if (doc.visibility !== 'private') return true
  return requester !== null && doc.owner_user_id === requester
}

/** document rows read with `id, visibility, owner:member!created_by(user_id)`, as DocumentVisibilityRow by id. */
function documentVisibilityMap(rows: ReadonlyArray<{ id: string; visibility?: string | null; owner?: unknown }>): Map<string, DocumentVisibilityRow> {
  return new Map(
    rows.map((d) => {
      const owner = (Array.isArray(d.owner) ? d.owner[0] : d.owner) as { user_id?: string | null } | null | undefined
      return [d.id, { visibility: d.visibility ?? null, owner_user_id: owner?.user_id ?? null }] as const
    }),
  )
}

const DOCUMENT_VISIBILITY_SELECT = 'id, visibility, owner:member!created_by(user_id)'

type SourceRef = { claim_id: string; source_type: string | null; source_id: string | null }

/**
 * Pure: which of `claimIds` are hidden, given every source row of those claims
 * (`sources`), the cited captures (`captures`, by id), the cited attachments
 * (`attachmentNoteIds`: id → parent capture id, null for none; an absent id is
 * dangling) and the cited conversations' owners (`conversationOwners`: id →
 * user_id; an absent id is dangling). Any mail source hides the claim; no
 * sources at all is visible; otherwise visible when at least one source is.
 */
export function hiddenClaimIds(
  claimIds: readonly string[],
  sources: readonly SourceRef[],
  captures: ReadonlyMap<string, Omit<CaptureVisibilityRow, 'id'>>,
  attachmentNoteIds: ReadonlyMap<string, string | null>,
  requester: string | null,
  conversationOwners: ReadonlyMap<string, string | null> = new Map(),
  // The cited documents (369), by id; an absent id is dangling. Left out,
  // document sources count as visible (a caller that didn't read them).
  documents?: ReadonlyMap<string, DocumentVisibilityRow>,
): Set<string> {
  const byClaim = new Map<string, SourceRef[]>()
  for (const s of sources) (byClaim.get(s.claim_id) ?? byClaim.set(s.claim_id, []).get(s.claim_id)!).push(s)
  const sourceVisible = (s: SourceRef): boolean => {
    if (isMailSourceType(s.source_type)) return false
    if (s.source_type === 'capture') return s.source_id !== null && captureVisibleTo(captures.get(s.source_id), requester)
    if (s.source_type === 'attachment') {
      if (s.source_id === null || !attachmentNoteIds.has(s.source_id)) return false
      const noteId = attachmentNoteIds.get(s.source_id) ?? null
      return noteId === null || captureVisibleTo(captures.get(noteId), requester)
    }
    if (s.source_type === CONVERSATION_SOURCE_TYPE) return s.source_id !== null && conversationVisibleTo(conversationOwners.get(s.source_id), requester)
    if (s.source_type === 'document' && documents) return s.source_id !== null && documentVisibleTo(documents.get(s.source_id), requester)
    return true
  }
  const hidden = new Set<string>()
  for (const id of new Set(claimIds)) {
    const rows = byClaim.get(id)
    if (!rows || rows.length === 0) continue
    if (rows.some((s) => isMailSourceType(s.source_type)) || !rows.some(sourceVisible)) hidden.add(id)
  }
  return hidden
}

/** Ids per `.in()` request. */
const ID_CHUNK = 100

function chunked<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Every page of one query, or null when a page failed. */
async function readPages<R>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<R[] | null> {
  const rows: R[] = []
  for (let from = 0; ; from += MAIL_PAGE_SIZE) {
    const { data, error } = await page(from, from + MAIL_PAGE_SIZE - 1)
    if (error) return null
    const batch = (data ?? []) as R[]
    rows.push(...batch)
    if (batch.length < MAIL_PAGE_SIZE) return rows
  }
}

/**
 * One read per chunk of `ids`, in parallel; null when any failed. For reads
 * keyed by the row's own id (at most one row per id, so a chunk never nears
 * the row cap).
 */
async function readRowsByIds<R>(
  ids: readonly string[],
  read: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<R[] | null> {
  const parts = await Promise.all(
    chunked([...new Set(ids)]).map(async (c) => {
      const { data, error } = await read(c)
      return error ? null : ((data ?? []) as R[])
    }),
  )
  return parts.some((p) => p === null) ? null : (parts.flat() as R[])
}

/** One paged read per chunk of `ids`, in parallel; null when any failed. */
async function readByIds<R>(
  ids: readonly string[],
  page: (chunk: string[], from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
): Promise<R[] | null> {
  const parts = await Promise.all(chunked([...new Set(ids)]).map((c) => readPages<R>((from, to) => page(c, from, to))))
  return parts.some((p) => p === null) ? null : parts.flat() as R[]
}

/**
 * The documents among `documentIds` hidden from `requester` (migration 369):
 * someone else's private document, or one that no longer exists. `null` when
 * a read failed (callers fail closed).
 */
export async function documentIdsHiddenFrom(
  supabase: SupabaseClient,
  documentIds: readonly string[],
  requester: string | null,
): Promise<Set<string> | null> {
  const wanted = [...new Set(documentIds)]
  if (wanted.length === 0) return new Set()
  const rows = await readRowsByIds<{ id: string; visibility?: string | null; owner?: unknown }>(wanted, (c) =>
    supabase.from('document').select(DOCUMENT_VISIBILITY_SELECT).in('id', c),
  )
  if (!rows) return null
  const vis = documentVisibilityMap(rows)
  return new Set(wanted.filter((id) => !documentVisibleTo(vis.get(id), requester)))
}

/**
 * The ids among `claimIds` hidden from `requester`, by claim_visible_to's rule
 * (dangling references count as hidden, as the SQL's EXISTS does). Batched:
 * the claims' sources by 100 claim ids, then the cited attachments, captures
 * and (for a requester) conversations by id: three or four reads for up to
 * 100 claims. `null` when any read failed: callers fail closed.
 */
export async function claimIdsHiddenFrom(
  supabase: SupabaseClient,
  claimIds: readonly string[],
  requester: string | null,
): Promise<Set<string> | null> {
  if (claimIds.length === 0) return new Set()
  // A claim has a handful of sources, so 100 claims' sources sit far under the
  // row cap; a chunk whose answer reaches it may be truncated, and every claim
  // in it then counts as hidden (fail closed).
  const truncated = new Set<string>()
  const sourceParts = await Promise.all(
    chunked([...new Set(claimIds)]).map(async (c) => {
      const { data, error } = await supabase
        .from('claim_source')
        .select('claim_id, source_type, source_id')
        .in('claim_id', c)
        .limit(MAIL_PAGE_SIZE)
      if (error) return null
      const rows = (data ?? []) as SourceRef[]
      if (rows.length >= MAIL_PAGE_SIZE) for (const id of c) truncated.add(id)
      return rows
    }),
  )
  if (sourceParts.some((p) => p === null)) return null
  const sources = sourceParts.flat() as SourceRef[]
  const attachmentIds = sources.filter((s) => s.source_type === 'attachment' && s.source_id).map((s) => s.source_id as string)
  const attachments = attachmentIds.length
    ? await readRowsByIds<{ id: string; note_id: string | null }>(attachmentIds, (c) =>
        supabase.from('attachments').select('id, note_id').in('id', c),
      )
    : []
  if (!attachments) return null
  const attachmentNoteIds = new Map(attachments.map((a) => [a.id, a.note_id ?? null] as const))
  const captureIds = [
    ...sources.filter((s) => s.source_type === 'capture' && s.source_id).map((s) => s.source_id as string),
    ...attachments.map((a) => a.note_id).filter((id): id is string => !!id),
  ]
  const captures = captureIds.length
    ? await readRowsByIds<CaptureVisibilityRow>(captureIds, (c) =>
        supabase.from('captures').select('id, visibility, user_id, is_eval').in('id', c),
      )
    : []
  if (!captures) return null
  // A chat is only ever its owner's: nothing to read for no requester.
  const conversationIds = requester === null ? [] : sources.filter((s) => s.source_type === CONVERSATION_SOURCE_TYPE && s.source_id).map((s) => s.source_id as string)
  const conversations = conversationIds.length
    ? await readRowsByIds<{ id: string; user_id: string | null }>(conversationIds, (c) =>
        supabase.from('chat_conversations').select('id, user_id').in('id', c),
      )
    : []
  if (!conversations) return null
  // Private documents (369) are their creator's alone.
  const documentIds = sources.filter((s) => s.source_type === 'document' && s.source_id).map((s) => s.source_id as string)
  const documents = documentIds.length
    ? await readRowsByIds<{ id: string; visibility?: string | null; owner?: unknown }>(documentIds, (c) =>
        supabase.from('document').select(DOCUMENT_VISIBILITY_SELECT).in('id', c),
      )
    : []
  if (!documents) return null
  const hidden = hiddenClaimIds(
    claimIds,
    sources,
    new Map(captures.map((c) => [c.id, c])),
    attachmentNoteIds,
    requester,
    new Map(conversations.map((c) => [c.id, c.user_id ?? null] as const)),
    documentVisibilityMap(documents),
  )
  for (const id of truncated) hidden.add(id)
  return hidden
}

/** `claims` without the ones hidden from `requester`. Fails closed: a failed read returns nothing. */
export async function excludeClaimsHiddenFrom<T extends { id: string }>(
  supabase: SupabaseClient,
  claims: T[],
  requester: string | null,
): Promise<T[]> {
  if (claims.length === 0) return claims
  const hidden = await claimIdsHiddenFrom(supabase, claims.map((c) => c.id), requester)
  if (!hidden) return []
  return hidden.size === 0 ? claims : claims.filter((c) => !hidden.has(c.id))
}

/**
 * Every claim in a workspace hidden from `requester`, for whole-workspace
 * reads (the knowledge graph, ~10k claims) where checking every claim would
 * cost a hundred requests. It starts from the hidden things, as the RLS set
 * does: the mail sources, the captures this requester can't see (evals,
 * other people's private ones) with the sources citing them directly or
 * through an attachment, and the conversation sources that aren't the
 * requester's own chats (353). Those candidates then get the exact rule (one
 * with another visible source stays). Like the RLS set, a source pointing at
 * a capture or attachment that no longer exists is not found this way. `null`
 * when any read failed: callers fail closed.
 */
export async function claimIdsHiddenInWorkspace(
  supabase: SupabaseClient,
  workspaceId: string,
  requester: string | null,
): Promise<Set<string> | null> {
  const mail = await mailSourcedClaimIdsInWorkspace(supabase, workspaceId)
  if (!mail) return null
  const capturesRead = await readPages<CaptureVisibilityRow>((from, to) =>
    supabase
      .from('captures')
      .select('id, visibility, user_id, is_eval')
      .eq('workspace_id', workspaceId)
      .or('is_eval.eq.true,visibility.eq.private')
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!capturesRead) return null
  const hiddenCaptureIds = capturesRead.filter((c) => !captureVisibleTo(c, requester)).map((c) => c.id)
  const chatCandidates = await foreignConversationClaimIds(supabase, workspaceId, requester)
  if (!chatCandidates) return null
  // 369: the private documents this requester can't see, and the claims citing them.
  const privateDocs = await readPages<{ id: string; visibility?: string | null; owner?: unknown }>((from, to) =>
    supabase
      .from('document')
      .select(DOCUMENT_VISIBILITY_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('visibility', 'private')
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!privateDocs) return null
  const docVisibility = documentVisibilityMap(privateDocs)
  const hiddenDocumentIds = privateDocs.filter((d) => !documentVisibleTo(docVisibility.get(d.id), requester)).map((d) => d.id)
  const documentSources = hiddenDocumentIds.length
    ? await readByIds<{ claim_id: string }>(hiddenDocumentIds, (c, from, to) =>
        supabase.from('claim_source').select('claim_id').eq('source_type', 'document').in('source_id', c).order('id', { ascending: true }).range(from, to),
      )
    : []
  if (!documentSources) return null
  const documentCandidates = documentSources.map((s) => s.claim_id)
  if (hiddenCaptureIds.length === 0 && chatCandidates.length === 0 && documentCandidates.length === 0) return mail

  const [captureSources, attachments] = await Promise.all([
    readByIds<{ claim_id: string }>(hiddenCaptureIds, (c, from, to) =>
      supabase.from('claim_source').select('claim_id').eq('source_type', 'capture').in('source_id', c).order('id', { ascending: true }).range(from, to),
    ),
    readByIds<{ id: string }>(hiddenCaptureIds, (c, from, to) =>
      supabase.from('attachments').select('id').eq('workspace_id', workspaceId).in('note_id', c).order('id', { ascending: true }).range(from, to),
    ),
  ])
  if (!captureSources || !attachments) return null
  const attachmentSources = attachments.length
    ? await readByIds<{ claim_id: string }>(attachments.map((a) => a.id), (c, from, to) =>
        supabase.from('claim_source').select('claim_id').eq('source_type', 'attachment').in('source_id', c).order('id', { ascending: true }).range(from, to),
      )
    : []
  if (!attachmentSources) return null

  const candidates = [...new Set([...captureSources, ...attachmentSources].map((s) => s.claim_id).concat(chatCandidates, documentCandidates))].filter((id) => !mail.has(id))
  const hidden = await claimIdsHiddenFrom(supabase, candidates, requester)
  if (!hidden) return null
  return new Set([...mail, ...hidden])
}

/**
 * The claims in a workspace citing a chat that isn't `requester`'s own (every
 * chat, for no requester): one paged read of the conversation sources, and one
 * of the requester's own conversations there. `null` when a read failed.
 */
async function foreignConversationClaimIds(
  supabase: SupabaseClient,
  workspaceId: string,
  requester: string | null,
): Promise<string[] | null> {
  const rows = await readPages<{ claim_id: string; source_id: string | null }>((from, to) =>
    supabase
      .from('claim_source')
      .select('claim_id, source_id')
      .eq('source_type', CONVERSATION_SOURCE_TYPE)
      .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (!rows) return null
  if (rows.length === 0) return []
  let mine = new Set<string>()
  if (requester !== null) {
    const own = await readPages<{ id: string }>((from, to) =>
      supabase
        .from('chat_conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', requester)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (!own) return null
    mine = new Set(own.map((c) => c.id))
  }
  return [...new Set(rows.filter((r) => r.source_id === null || !mine.has(r.source_id)).map((r) => r.claim_id))]
}

/**
 * Decide, from prefetched source rows, which claims a NULL requester may see.
 *
 * The claim rule (docs/design-capture-visibility.md; SQL twin
 * `public.claim_visible_to` in migration 223): a claim is visible iff it has
 * zero sources, OR at least one source that is not hidden. Per source type:
 *
 *   - `capture` — visible only when the capture is `visibility = 'workspace'`;
 *     a dangling capture reference counts as hidden (fail closed).
 *   - `attachment` — resolves through `attachments.note_id`: visible when the
 *     attachment has no parent capture (`note_id IS NULL`) or its parent
 *     capture is workspace-visible. A dangling attachment id matches no row, so
 *     — exactly as the SQL's `EXISTS` does — it counts as hidden.
 *   - `email` — never visible, and it hides the whole claim: a claim with ANY
 *     mail source is visible to no one (migration 341; Dial8 doesn't learn
 *     from mail).
 *   - `conversation` — never visible here: a chat is only its owner's
 *     (353), and an unattended run has no owner. A claim known only from
 *     someone's chat never reaches a brief, a merge or a shared edge.
 *   - `document` — visible when the document is workspace-visible (369: a
 *     private document is its creator's alone, and an unattended run has no
 *     creator); a dangling document counts as hidden. Only checked when
 *     `workspaceVisibleDocumentIds` is given.
 *   - anything else — always visible.
 *
 * `attachmentNoteIds` maps attachment id → its `note_id` (`null` for a row with
 * no parent capture); an id absent from the map is dangling.
 *
 * Exported pure so the rule is unit-testable without a DB.
 */
export function filterClaimsVisibleToNobody<T extends { id: string }>(
  claims: T[],
  sources: Array<{ claim_id: string; source_type: string | null; source_id: string | null }>,
  workspaceVisibleCaptureIds: Set<string>,
  attachmentNoteIds: Map<string, string | null> = new Map(),
  workspaceVisibleDocumentIds?: Set<string>,
): T[] {
  const sourcesByClaim = new Map<string, Array<{ source_type: string | null; source_id: string | null }>>()
  for (const s of sources) {
    const list = sourcesByClaim.get(s.claim_id) ?? []
    list.push(s)
    sourcesByClaim.set(s.claim_id, list)
  }

  return claims.filter((c) => {
    const rows = sourcesByClaim.get(c.id)
    if (!rows || rows.length === 0) return true
    if (rows.some((s) => isMailSourceType(s.source_type))) return false
    return rows.some((s) => {
      if (s.source_type === 'capture') {
        return s.source_id !== null && workspaceVisibleCaptureIds.has(s.source_id)
      }
      if (s.source_type === 'attachment') {
        if (s.source_id === null || !attachmentNoteIds.has(s.source_id)) return false
        const noteId = attachmentNoteIds.get(s.source_id) ?? null
        return noteId === null || workspaceVisibleCaptureIds.has(noteId)
      }
      if (s.source_type === CONVERSATION_SOURCE_TYPE) return false
      if (s.source_type === 'document' && workspaceVisibleDocumentIds) {
        return s.source_id !== null && workspaceVisibleDocumentIds.has(s.source_id)
      }
      return true
    })
  })
}

/** Page size for the claim_source sweep. Pages until a short page proves exhaustion. */
const SOURCE_PAGE_SIZE = 1000

/**
 * Drop claims that are hidden from a NULL requester (see
 * {@link filterClaimsVisibleToNobody}). Batched — never N+1: three queries
 * regardless of claim count (`claim_source`, then `attachments`, then the one
 * `captures` fetch that covers direct capture sources AND the capture parents
 * the attachments resolved to).
 *
 * Fails CLOSED on an incomplete read: `filterClaimsVisibleToNobody` treats a
 * claim with zero source rows as visible (correct for a genuinely source-less
 * claim), so a truncated or errored `claim_source` fetch would silently invert
 * the rule and admit private-capture-sourced claims. Hence: page until
 * exhaustion, and drop every claim if any page errors.
 */
export async function excludePrivateSourcedClaims<T extends { id: string }>(
  supabase: SupabaseClient,
  workspaceId: string,
  claims: T[],
): Promise<T[]> {
  return (await claimsVisibleToNobody(supabase, workspaceId, claims)) ?? []
}

/**
 * {@link excludePrivateSourcedClaims}, but `null` when a read failed instead
 * of an empty list, for a caller that must tell "nothing is visible" from
 * "couldn't check" (brief compilation deletes a brief only on the first).
 */
export async function claimsVisibleToNobody<T extends { id: string }>(
  supabase: SupabaseClient,
  workspaceId: string,
  claims: T[],
): Promise<T[] | null> {
  if (claims.length === 0) return claims

  const claimIds = claims.map((c) => c.id)
  const rows: Array<{
    claim_id: string
    source_type: string | null
    source_id: string | null
  }> = []
  for (let offset = 0; ; offset += SOURCE_PAGE_SIZE) {
    const { data: page, error } = await supabase
      .from('claim_source')
      .select('claim_id, source_type, source_id')
      .in('claim_id', claimIds)
      // Order by the primary key: a unique total order, so paging can neither
      // skip nor duplicate a row.
      .order('id', { ascending: true })
      .range(offset, offset + SOURCE_PAGE_SIZE - 1)
    if (error) return null
    const batch = (page ?? []) as typeof rows
    rows.push(...batch)
    if (batch.length < SOURCE_PAGE_SIZE) break
  }

  // Attachment sources resolve through their parent capture (attachments.
  // note_id), so their note_ids must be known before the captures fetch — that
  // way ONE captures query covers both source kinds.
  const attachmentIds = [
    ...new Set(
      rows
        .filter((s) => s.source_type === 'attachment' && s.source_id)
        .map((s) => s.source_id as string),
    ),
  ]

  const attachmentNoteIds = new Map<string, string | null>()
  if (attachmentIds.length > 0) {
    const { data: attachments, error } = await supabase
      .from('attachments')
      .select('id, note_id')
      .eq('workspace_id', workspaceId)
      .in('id', attachmentIds)
    // Fail closed, same reasoning as the captures read below: an errored fetch
    // would leave every attachment source looking dangling-or-parentless by
    // accident. An id absent from the result IS treated as hidden (dangling),
    // matching the SQL twin's EXISTS.
    if (error) return null
    for (const a of attachments ?? []) {
      attachmentNoteIds.set(a.id as string, (a.note_id as string | null) ?? null)
    }
  }

  const captureIds = [
    ...new Set([
      ...rows
        .filter((s) => s.source_type === 'capture' && s.source_id)
        .map((s) => s.source_id as string),
      ...[...attachmentNoteIds.values()].filter((id): id is string => id !== null),
    ]),
  ]

  const visibleCaptureIds = new Set<string>()
  if (captureIds.length > 0) {
    const { data: captures, error } = await supabase
      .from('captures')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visibility', 'workspace')
      .in('id', captureIds)
    // Fail closed: an errored read would leave every capture source looking
    // hidden-or-visible by accident. Treat it as "nothing is visible".
    if (error) return null
    for (const c of captures ?? []) visibleCaptureIds.add(c.id as string)
  }

  // 369: a private document is its creator's alone, and an unattended read has no creator.
  const documentIds = [...new Set(rows.filter((s) => s.source_type === 'document' && s.source_id).map((s) => s.source_id as string))]
  const visibleDocumentIds = new Set<string>()
  if (documentIds.length > 0) {
    const { data: docs, error } = await supabase
      .from('document')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visibility', 'workspace')
      .in('id', documentIds)
    if (error) return null
    for (const d of docs ?? []) visibleDocumentIds.add(d.id as string)
  }

  return filterClaimsVisibleToNobody(claims, rows, visibleCaptureIds, attachmentNoteIds, visibleDocumentIds)
}

// ---------------------------------------------------------------------------
// Dedupe audience: attaching a source never widens a claim
// ---------------------------------------------------------------------------
//
// claim_visible_to shows a claim when ANY one of its sources is readable. A
// dedupe hit attaches the new source (and its anchor links) to the existing
// claim, so the existing claim's audience grows by the new provenance's
// audience. The dedupe read (`match_claims`) must therefore see only claims
// the new provenance's audience can ALREADY see:
//
//   - provenance readable by one person (their private capture, their chat,
//     an attachment on their private capture) → that person is the requester:
//     the match is visible to them already, so attaching adds no reader;
//   - provenance readable by everyone (a workspace capture, a document, a URL,
//     or any anchor link mirrored into an always-visible claim_source row) →
//     NULL requester. With no requester, claim_visible_to admits only claims
//     every member can already read (workspace captures, always-visible
//     sources, sourceless claims; never a chat, never a private capture), so
//     attaching to one cannot widen it;
//   - anything unknown (a failed read, a missing owner) → NULL, the narrowest
//     match set.
//
// Re-extracting the same source stays idempotent: a claim born from source S
// carries S's provenance, so S's audience can see it and it still matches.

/** The anchor-link shape `attachClaimProvenance` takes (only the fields read here). */
export interface DedupeLink {
  entity_type: string
  relation?: string | null
}

/**
 * Whether attaching `links` writes a claim_source row every member can read.
 * Mirrors attachClaimProvenance: a `cites`/`about` link (default `about`) to a
 * citable entity is cross-populated into claim_source, and claim_visible_to's
 * `ELSE TRUE` makes a project/company/contact/action row readable by all.
 * A link to a capture/attachment/conversation is counted too (conservative:
 * NULL is always safe).
 */
export function provenanceLinksReachEveryone(links: readonly DedupeLink[] | null | undefined): boolean {
  return (links ?? []).some((l) => {
    const relation = l.relation ?? 'about'
    return (relation === 'cites' || relation === 'about') && CITABLE_SOURCE_TYPES.has(l.entity_type)
  })
}

/**
 * The `p_requesting_user_id` for a dedupe `match_claims` read, so the match is
 * a claim the new source's audience can already see (see above).
 *
 * | sourceType     | condition                       | requester   |
 * |----------------|---------------------------------|-------------|
 * | any            | a link reaches everyone         | null        |
 * | capture        | visibility = 'private'          | owner       |
 * | capture        | 'workspace' / unknown           | null        |
 * | conversation   | (a chat is its owner's)         | owner       |
 * | attachment     | parent capture is 'private'     | owner       |
 * | attachment     | no parent / workspace / unknown | null        |
 * | document, external_url, anything else             | null        |
 *
 * `ownerUserId` is the capture's (or the attachment's parent capture's, or the
 * chat's) `user_id`; a missing owner yields null.
 */
export function dedupeRequesterFor(args: {
  sourceType: string
  ownerUserId: string | null | undefined
  captureVisibility?: string | null
  parentCaptureVisibility?: string | null
  /** A document source's visibility (369): a private one is its creator's. */
  documentVisibility?: string | null
  links?: readonly DedupeLink[] | null
}): string | null {
  if (provenanceLinksReachEveryone(args.links)) return null
  const owner = typeof args.ownerUserId === 'string' && args.ownerUserId.length > 0 ? args.ownerUserId : null
  switch (args.sourceType) {
    case 'capture':
      return args.captureVisibility === 'private' ? owner : null
    case CONVERSATION_SOURCE_TYPE:
      return owner
    case 'attachment':
      return args.parentCaptureVisibility === 'private' ? owner : null
    case 'document':
      return args.documentVisibility === 'private' ? owner : null
    default:
      return null
  }
}
