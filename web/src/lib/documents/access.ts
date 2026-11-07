/**
 * Who may change a document: the app half of migration 359
 * (supabase/migrations/359_document_write_rls.sql). The rules mirror the SQL
 * exactly, so a route refuses with a clean 403 before RLS would refuse with a
 * 0-row update, and the service-role paths (the chat and MCP tools, which RLS
 * can't cover) get the same rule:
 *
 *   EDIT    owner or admin: yes. The creator: yes, except the workspace
 *           product doc (owner or admin only). A plain member: only a shared
 *           wiki page (published, not a spec, no meeting-prep stamp, not in a
 *           project, and a slug or a type other than note). Guests: never.
 *           Spec pages are machine-written: owner or admin only.
 *   DELETE  owner or admin; or the creator, except the product doc. Covers the
 *           hard delete and the archive (soft delete). A SYSTEM document (one
 *           with a canon_key, or the product doc: migration 366) is never
 *           deleted or archived, by anyone; it can still be edited.
 *   SEE     every member sees a 'workspace' document; a 'private' one only
 *           its creator (migration 369, as captures: no admin override). To
 *           anyone else a private document does not exist: the loaders below
 *           return no access for it, so every route and tool says "not found".
 *   GUARD   (the 359 trigger) a non-admin never changes created_by; a
 *           non-admin who isn't the creator never changes status,
 *           published_status, slug or type; nobody changes the id, the
 *           workspace, the meeting-prep stamp or the Now file's stamp (440)
 *           from outside the server.
 *
 * Everything here is pure except loadDocumentAccess and loadDocumentsAccess.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MEETING_PREP_KEY } from '@/lib/agent-events/prep-ref'
import { NOW_KEY, NOW_PRIVATE_REFUSAL, isNowDocument } from '@/lib/now/now-stamp'
import { readProductDocPointer } from '@/lib/workspace/product-doc'
import { SYSTEM_DOCUMENT_PRIVATE_REFUSAL, SYSTEM_DOCUMENT_REFUSAL } from './system-document'

/** The document columns the rules read. */
export const DOCUMENT_ACCESS_COLUMNS = 'id, workspace_id, created_by, type, slug, published_status, frontmatter, project_id, status, canon_key, visibility'

export interface DocumentAccessRow {
  id: string
  workspace_id: string
  created_by: string | null
  type: string | null
  slug: string | null
  published_status: string | null
  frontmatter: unknown
  project_id: string | null
  status?: string | null
  /** The canon registry's key (migration 366): set = a system document. */
  canon_key?: string | null
  /** 'workspace' (every member) or 'private' (only its creator), migration 369. */
  visibility?: string | null
}

export interface DocumentAccess {
  /** The caller's role in the document's workspace; null when not a member. */
  role: string | null
  /** The caller's member row in the document's workspace; null when not a member. */
  memberId: string | null
  row: DocumentAccessRow
  /** Whether the document is the workspace product doc (workspace.settings.product_doc). */
  isProductDoc: boolean
}

/** Shown in the UI and returned by the routes when edit access is refused. */
export const EDIT_REFUSAL = 'Only the creator or an admin can edit this document.'
export const PRODUCT_DOC_EDIT_REFUSAL = 'Only an owner or admin can edit the workspace product doc.'
export const DELETE_REFUSAL = 'Only the creator or an admin can delete this document.'
export {
  SYSTEM_DOCUMENT_PRIVATE_REFUSAL,
  SYSTEM_DOCUMENT_PRIVATE_SQLSTATE,
  SYSTEM_DOCUMENT_REFUSAL,
  SYSTEM_DOCUMENT_SQLSTATE,
} from './system-document'
/** Refused when someone other than its creator tries to change who can see a document. */
export const VISIBILITY_REFUSAL = 'Only the document creator can change its visibility'

const isAdmin = (role: string | null | undefined) => role === 'owner' || role === 'admin'

/**
 * Whether frontmatter carries a meeting-prep stamp, as the SQL `frontmatter ?
 * 'meeting_prep'` reads it: an object with the key (any value, null too), an
 * array holding the string, or that string itself.
 */
export function hasMeetingPrepStamp(frontmatter: unknown): boolean {
  if (typeof frontmatter === 'string') return frontmatter === MEETING_PREP_KEY
  if (Array.isArray(frontmatter)) return frontmatter.includes(MEETING_PREP_KEY)
  if (frontmatter && typeof frontmatter === 'object') return Object.prototype.hasOwnProperty.call(frontmatter, MEETING_PREP_KEY)
  return false
}

/** A shared wiki page: the one kind a plain member may edit without being its creator. */
export function isSharedPage(row: Pick<DocumentAccessRow, 'type' | 'slug' | 'published_status' | 'frontmatter' | 'project_id'>): boolean {
  const type = row.type ?? 'note'
  return (
    row.published_status === 'published' &&
    type !== 'spec' &&
    !hasMeetingPrepStamp(row.frontmatter) &&
    row.project_id == null &&
    (row.slug != null || type !== 'note')
  )
}

/** The EDIT rule (SQL can_edit_document). */
export function canEditDocument(a: DocumentAccess): boolean {
  const { role, memberId, row } = a
  if (role !== 'owner' && role !== 'admin' && role !== 'member') return false
  // Nobody edits what they can't see (migration 369): no admin override.
  if (!documentVisibleToMember(row, memberId)) return false
  if (isAdmin(role)) return true
  if (a.isProductDoc) return false
  if ((row.type ?? 'note') === 'spec') return false
  if (row.created_by != null && memberId != null && row.created_by === memberId) return true
  return isSharedPage(row)
}

/**
 * A system document (migration 366): one with a canon_key, or the workspace
 * product doc. It can be edited (by the EDIT rule) but never deleted or
 * archived.
 */
export function isSystemDocument(a: Pick<DocumentAccess, 'isProductDoc' | 'row'>): boolean {
  return a.isProductDoc || (a.row.canon_key ?? null) !== null
}

/** Why the document can't be deleted or archived: the system line, or null. */
export function systemDocumentDeleteRefusal(a: Pick<DocumentAccess, 'isProductDoc' | 'row'>): string | null {
  return isSystemDocument(a) ? SYSTEM_DOCUMENT_REFUSAL : null
}

/**
 * Whether `memberId` may see a document (migration 369): a workspace document,
 * or a private one they created. No admin override; a private document with
 * no creator is visible to no one.
 */
export function documentVisibleToMember(
  row: Pick<DocumentAccessRow, 'visibility' | 'created_by'>,
  memberId: string | null,
): boolean {
  if ((row.visibility ?? 'workspace') !== 'private') return true
  return memberId !== null && row.created_by != null && row.created_by === memberId
}

/** Whether the document is private (only its creator sees it). */
export function isPrivateDocument(row: Pick<DocumentAccessRow, 'visibility'>): boolean {
  return (row.visibility ?? 'workspace') === 'private'
}

/** The DELETE rule (SQL document_delete policy and delete_document_with_knowledge), and never a system document. */
export function canDeleteDocument(a: DocumentAccess): boolean {
  if (isSystemDocument(a)) return false
  if (!a.role) return false
  if (isAdmin(a.role)) return true
  if (a.isProductDoc) return false
  return a.row.created_by != null && a.memberId != null && a.row.created_by === a.memberId
}

/**
 * Whether the caller may move the document into or out of a project: edit
 * access AND (owner/admin or the creator), the same people the 359 guard lets
 * change status and type. A member editing a shared wiki page can't: putting
 * it in a project makes it the creator's alone (the WITH CHECK refuses it).
 */
export function canSetDocumentProject(a: DocumentAccess): boolean {
  if (!canEditDocument(a)) return false
  if (isAdmin(a.role)) return true
  return a.row.created_by != null && a.memberId != null && a.row.created_by === a.memberId
}

/** The line a refusal to edit says. */
export function editRefusalMessage(a: DocumentAccess): string {
  return a.isProductDoc && !isAdmin(a.role) ? PRODUCT_DOC_EDIT_REFUSAL : EDIT_REFUSAL
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => sameJson(v, bb[i]))
  }
  const ak = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const bk = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return ak.length === bk.length && ak.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const stampOf = (frontmatter: unknown, key: string = MEETING_PREP_KEY): unknown =>
  frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
    ? (frontmatter as Record<string, unknown>)[key]
    : undefined

/**
 * Why this update would be refused (the RLS USING and WITH CHECK, and the 359
 * guard), or null when it may go through. `patch` is the column update the
 * caller is about to write. Pure.
 */
export function documentUpdateRefusal(a: DocumentAccess, patch: Record<string, unknown>): string | null {
  if (!canEditDocument(a)) return editRefusalMessage(a)
  const row = a.row as unknown as Record<string, unknown>
  const changes = (key: string) => key in patch && patch[key] !== undefined && !sameJson(patch[key], row[key])

  if (changes('id') || changes('workspace_id')) return 'A document changes workspace only by moving it.'
  // The Now file (migration 440) is its creator's alone: always private, never canon.
  if (isNowDocument(a.row.frontmatter) && ((changes('visibility') && patch.visibility !== 'private') || (changes('canon_key') && patch.canon_key))) {
    return NOW_PRIVATE_REFUSAL
  }
  if (isSystemDocument(a) && changes('status') && patch.status === 'archived') return SYSTEM_DOCUMENT_REFUSAL
  if (changes('visibility')) {
    // Only its creator says who can see a document; a system document is never private.
    const isCreator = a.row.created_by != null && a.memberId != null && a.row.created_by === a.memberId
    if (!isCreator) return VISIBILITY_REFUSAL
    if (patch.visibility === 'private' && isSystemDocument(a)) return SYSTEM_DOCUMENT_PRIVATE_REFUSAL
  }
  if (changes('canon_key') && patch.canon_key && isPrivateDocument(a.row)) return SYSTEM_DOCUMENT_PRIVATE_REFUSAL
  if (changes('canon_key') && !isAdmin(a.role)) return 'Only an owner or admin can set which documents are system documents.'
  if ('frontmatter' in patch && patch.frontmatter !== undefined && !sameJson(stampOf(patch.frontmatter), stampOf(a.row.frontmatter))) {
    return 'A meeting-prep stamp is written by the server only.'
  }
  // The Now file's stamp (migration 440), the same way.
  if ('frontmatter' in patch && patch.frontmatter !== undefined && !sameJson(stampOf(patch.frontmatter, NOW_KEY), stampOf(a.row.frontmatter, NOW_KEY))) {
    return 'A Now file stamp is written by the server only.'
  }
  if (!isAdmin(a.role)) {
    if (changes('created_by')) return 'Only an owner or admin can change who created a document.'
    const isCreator = a.row.created_by != null && a.memberId != null && a.row.created_by === a.memberId
    if (!isCreator && (changes('status') || changes('published_status') || changes('slug') || changes('type'))) {
      return EDIT_REFUSAL
    }
  }
  // The row as it would be must still be editable (the policy's WITH CHECK).
  const next = { ...a.row, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as DocumentAccessRow
  if (!canEditDocument({ ...a, row: next })) return editRefusalMessage(a)
  return null
}

/**
 * The caller's access to one document: their role and member row in the
 * workspace (with the workspace settings, for the product-doc pointer, in the
 * same read) and the document's rule columns. Two reads, issued together; a
 * single embedded read through workspace -> document would be ambiguous to
 * PostgREST (document_revision and document_draft join the two). Scoped by
 * (workspace, user) and (id, workspace), so it is fenced on a service-role
 * client too.
 *
 * Returns `{ access: null }` when the document isn't in the workspace, and an
 * error string when a read failed.
 */
export async function loadDocumentAccess(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  docId: string,
): Promise<{ access: DocumentAccess | null; error: string | null }> {
  const [memberRes, docRes] = await Promise.all([
    supabase
      .from('member')
      .select('id, role, workspace:workspace_id(settings)')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('document').select(DOCUMENT_ACCESS_COLUMNS).eq('id', docId).eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (docRes.error) return { access: null, error: docRes.error.message }
  if (memberRes.error) return { access: null, error: memberRes.error.message }
  const doc = docRes.data as DocumentAccessRow | null
  if (!doc) return { access: null, error: null }
  const access = toDocumentAccess(memberRes.data, doc, workspaceId)
  // A private document is its creator's alone: to anyone else it does not exist.
  if (!documentVisibleToMember(access.row, access.memberId)) return { access: null, error: null }
  return { access, error: null }
}

/**
 * loadDocumentAccess for many documents at once (the bulk route): the same two
 * reads, the document one over `id in (...)`. Documents not in the workspace
 * are absent from the map. Fenced the same way.
 */
export async function loadDocumentsAccess(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  docIds: string[],
): Promise<{ access: Map<string, DocumentAccess>; error: string | null }> {
  const access = new Map<string, DocumentAccess>()
  if (docIds.length === 0) return { access, error: null }
  const [memberRes, docRes] = await Promise.all([
    supabase
      .from('member')
      .select('id, role, workspace:workspace_id(settings)')
      .eq('workspace_id', workspaceId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase.from('document').select(DOCUMENT_ACCESS_COLUMNS).in('id', docIds).eq('workspace_id', workspaceId),
  ])
  if (docRes.error) return { access, error: docRes.error.message }
  if (memberRes.error) return { access, error: memberRes.error.message }
  for (const doc of (docRes.data ?? []) as DocumentAccessRow[]) {
    const a = toDocumentAccess(memberRes.data, doc, workspaceId)
    // A private document is its creator's alone: absent, as one not in the workspace.
    if (documentVisibleToMember(a.row, a.memberId)) access.set(doc.id, a)
  }
  return { access, error: null }
}

/** One document's access from the member row (with its workspace settings) and the rule columns. */
function toDocumentAccess(memberData: unknown, doc: DocumentAccessRow, workspaceId: string): DocumentAccess {
  const member = memberData as { id?: unknown; role?: unknown; workspace?: unknown } | null
  const ws = Array.isArray(member?.workspace) ? member?.workspace[0] : member?.workspace
  const pointer = readProductDocPointer((ws as { settings?: unknown } | null | undefined)?.settings)
  return {
    role: typeof member?.role === 'string' ? member.role : null,
    memberId: typeof member?.id === 'string' ? member.id : null,
    row: {
      id: doc.id,
      workspace_id: doc.workspace_id ?? workspaceId,
      created_by: doc.created_by ?? null,
      type: doc.type ?? null,
      slug: doc.slug ?? null,
      published_status: doc.published_status ?? null,
      frontmatter: doc.frontmatter ?? {},
      project_id: doc.project_id ?? null,
      status: doc.status ?? null,
      canon_key: doc.canon_key ?? null,
      visibility: doc.visibility ?? 'workspace',
    },
    isProductDoc: pointer?.document_id === doc.id,
  }
}
