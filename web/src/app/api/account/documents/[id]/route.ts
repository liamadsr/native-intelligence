import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { indexDocument } from '@/lib/ai/embeddings'
import { conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import {
  DELETE_REFUSAL,
  EDIT_REFUSAL,
  SYSTEM_DOCUMENT_REFUSAL,
  SYSTEM_DOCUMENT_SQLSTATE,
  canDeleteDocument,
  canEditDocument,
  canSetDocumentProject,
  documentUpdateRefusal,
  isSystemDocument,
  loadDocumentAccess,
} from '@/lib/documents/access'
import { DOCUMENT_CONFLICT_MESSAGE, parseRevision, readDocumentRevision, writeDocument } from '@/lib/documents/write'
import { isNowDocument } from '@/lib/now/now-stamp'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { noteDocumentOpened } from '@/lib/documents/report-archive'
import { loadStaleSections } from '@/lib/documents/canon-freshness'
import { NextResponse, type NextRequest } from 'next/server'

/** PostgREST: `.single()` found no row (an RLS-refused update reads as one). */
const NO_ROW = 'PGRST116'
/** Postgres insufficient_privilege (the 359 guard and the delete RPC raise it). */
const NOT_ALLOWED = '42501'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params

  const [{ data, error }, accessRes] = await Promise.all([
    supabase
      .from('document')
      .select(`
      id, title, content, content_json, slug, type, tags, frontmatter, project_id, team_id, status, published_status, published_at, is_pinned, sort_order, revision, canon_key, visibility, kind, created_at, updated_at,
      project:projects!project_id(id, name),
      author:member!created_by(id, display_name, avatar_url)
    `)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    // An edit grant (512) makes it editable here as everywhere it is written.
    loadDocumentAccess(supabase, workspaceId, user.id, id, { editGrants: true }),
  ])

  if (error) {
    // No row: missing, or someone else's private document (migration 369),
    // which to them does not exist.
    if ((error as { code?: string }).code === NO_ROW) return notFound('Document not found')
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const projectData = data.project as unknown as { id: string; name: string } | null
  const authorData = data.author as unknown as { id: string; display_name: string; avatar_url: string | null } | null

  const { count: commentCount } = await supabase
    .from('comment')
    .select('*', { count: 'exact', head: true })
    .eq('commentable_type', 'document')
    .eq('commentable_id', id)

  // A report or prep a person opened stays out of the 30-day archive
  // (decision 18, migration 378): at most one write a day per document.
  await noteDocumentOpened(getServiceClient(), { documentId: id, workspaceId, kind: (data as { kind?: unknown }).kind })

  // Who may change it (migration 359): the UI goes read-only / hides delete.
  const access = accessRes.access
  const canEdit = access ? canEditDocument(access) : false
  const canDelete = access ? canDeleteDocument(access) : false
  const canSetProject = access ? canSetDocumentProject(access) : false
  // A system document (migration 366): edited as usual, never deleted.
  const isSystem = access ? isSystemDocument(access) : false

  // A canon document's sections nobody has changed or checked in 90 days
  // (canon D3): the view's quiet "not checked since" marker. Empty, it hides.
  const staleSections = (data as { canon_key?: unknown }).canon_key
    ? await loadStaleSections(supabase, { workspaceId, documentId: id, content: (data.content as string | null) ?? '' })
    : []

  // The current user's draft (if any) — shown alongside published content
  // so the editor can resume mid-edit.
  const memberId = access?.memberId ?? null

  let draft: { content: string | null; updated_at: string } | null = null
  if (memberId) {
    const { data: draftRow } = await supabase
      .from('document_draft')
      .select('content, content_json, updated_at')
      .eq('document_id', id)
      .eq('author_id', memberId)
      .maybeSingle()
    if (draftRow) {
      draft = { content: draftRow.content, updated_at: draftRow.updated_at }
    }
  }

  return NextResponse.json({
    document: {
      ...data,
      project: undefined,
      author: undefined,
      project_name: projectData?.name || null,
      created_by: authorData?.id || null,
      created_by_name: authorData?.display_name || null,
      created_by_avatar: authorData?.avatar_url || null,
      comment_count: commentCount || 0,
      can_edit: canEdit,
      can_delete: canDelete,
      can_set_project: canSetProject,
      is_system: isSystem,
      stale_sections: staleSections,
    },
    draft,
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const body = await request.json()

  // Who may change it (migration 359), checked before writing: a refusal is a
  // 403 here, not a 0-row update that `.single()` would turn into a 500.
  const { access, error: accessError } = await loadDocumentAccess(supabase, workspaceId, user.id, id, { editGrants: true })
  if (accessError) return serverError(accessError)
  if (!access) return notFound('Document not found')

  const updates: Record<string, unknown> = {}
  if (body.title !== undefined) updates.title = body.title
  if (body.content !== undefined) updates.content = body.content
  if (body.content_json !== undefined) updates.content_json = body.content_json
  if (body.project_id !== undefined) updates.project_id = body.project_id || null
  if (body.team_id !== undefined) updates.team_id = body.team_id || null
  if (body.status !== undefined) updates.status = body.status
  if (body.is_pinned !== undefined) updates.is_pinned = body.is_pinned
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order
  if (body.slug !== undefined) updates.slug = body.slug || null
  if (body.type !== undefined) updates.type = body.type
  if (Array.isArray(body.tags)) updates.tags = body.tags
  if (body.frontmatter !== undefined) {
    // Replacing the frontmatter never sets or drops a meeting-prep stamp: the
    // stored one is kept (prep-ref.ts withServerFrontmatter), so the 359 guard,
    // which refuses any change to it, never fires on a frontmatter edit.
    const frontmatter = withServerFrontmatter(body.frontmatter, access.row.frontmatter)
    if (frontmatter) updates.frontmatter = frontmatter
  }

  const refusal = documentUpdateRefusal(access, updates)
  if (refusal) return forbidden(refusal)

  const columns = 'id, title, content, content_json, slug, type, tags, project_id, team_id, status, published_status, is_pinned, sort_order, revision, created_at, updated_at'
  const editorMemberId = access.memberId
  let data: Record<string, unknown> & { content?: string | null; published_status?: string }

  if (updates.title !== undefined || updates.content !== undefined) {
    // A change to the text names the revision it was made against (migration
    // 364): if the document moved on (an agent's edit, another tab), nothing is
    // written and the editor gets a 409 with the revision it is at now. A
    // rename alone (an inline list edit) is checked against the revision read
    // just now.
    let baseRevision = parseRevision(body.base_revision)
    if (baseRevision === null && updates.content !== undefined) {
      // An editor from before 364 (the desktop app's webview and open tabs
      // keep their bundle until a reload) sends no base: its autosave is
      // written blind, as it always was, and still lands in the history.
      // TODO(documents): remove this grace once every client sends
      // base_revision, and answer 428 BASE_REVISION_REQUIRED again.
      console.warn(`[documents] body change without base_revision on ${id} (an old client): written blind`)
    }
    if (baseRevision === null) baseRevision = await readDocumentRevision(supabase, id, workspaceId)
    if (baseRevision === null) return notFound('Document not found')

    const written = await writeDocument(supabase, {
      documentId: id,
      workspaceId,
      baseRevision,
      patch: updates,
      source: 'human',
      memberId: editorMemberId,
      summary: typeof body.change_summary === 'string' ? body.change_summary : null,
      select: columns,
    })
    if (!written.ok) {
      if (written.reason === 'conflict') {
        return conflict(DOCUMENT_CONFLICT_MESSAGE, { revision: written.currentRevision, base_revision: baseRevision })
      }
      if (written.reason === 'not_found') return notFound('Document not found')
      if (written.reason === 'refused') return forbidden(EDIT_REFUSAL)
      return NextResponse.json({ error: written.error }, { status: 500 })
    }
    data = written.row
  } else {
    // Track who edited last (used by audit).
    if (editorMemberId) updates.last_edited_by = editorMemberId

    const res = await supabase
      .from('document')
      .update(updates)
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select(columns)
      .single()

    if (res.error) {
      // RLS refused the row (no row back) or the 359 guard raised: not allowed.
      const code = (res.error as { code?: string }).code
      if (code === SYSTEM_DOCUMENT_SQLSTATE) return forbidden(SYSTEM_DOCUMENT_REFUSAL)
      if (code === NO_ROW || code === NOT_ALLOWED) return forbidden(refusalOrDefault(res.error.message, code))
      return NextResponse.json({ error: res.error.message }, { status: 500 })
    }
    data = res.data as unknown as typeof data
  }

  // Re-sync wikilinks whenever the body changes on a published doc. Must be
  // awaited — a dropped promise can be cut off when the serverless function
  // freezes after the response returns.
  if (
    body.content !== undefined &&
    data.published_status === 'published' &&
    typeof data.content === 'string'
  ) {
    const { syncDocumentLinks } = await import('@/lib/wiki/wikilinks')
    await syncDocumentLinks(supabase, workspaceId, id, data.content, editorMemberId || null, user.id)
  }

  // Re-index embeddings whenever the body changed (document_chunks, migration
  // 185) — same staleness fix as captures/[id] PATCH: without this, a content
  // edit leaves document_chunks pointing at the old text forever. Gated on
  // body.content (title-only / metadata-only edits don't touch the body).
  // Indexes off the returned row's FULL current values. Best-effort and awaited
  // (the function freezes after the response); an embedding failure never fails
  // the PATCH. Unlike wikilinks, we index drafts too — the vector index is not
  // publish-gated (a published doc's live body is always the search target).
  // Runs even when content was cleared to null — indexDocument deletes the
  // stale chunks for an emptied body, otherwise old vectors linger forever.
  // The person's Now file is never embedded (migration 440); the row read for
  // access already says so, so indexDocument needs no read of its own.
  if (body.content !== undefined && !isNowDocument(access.row.frontmatter)) {
    const row = data as unknown as { content?: string | null; project_id?: string | null }
    try {
      await indexDocument(supabase, id, user.id, row.project_id ?? null, row.content ?? null, workspaceId)
    } catch (err) {
      console.error('[documents.patch] re-index failed (non-fatal):', err)
    }
  }

  return NextResponse.json({ document: data })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const permanent = request.nextUrl.searchParams.get('permanent') === 'true'

  // Owner or admin; or the creator, except the product doc (migration 359).
  // The same rule covers the hard delete and the archive.
  const { access, error: accessError } = await loadDocumentAccess(supabase, workspaceId, user.id, id)
  if (accessError) return serverError(accessError)
  if (!access) return notFound('Document not found')
  // A system document (migration 366): never deleted or archived, by anyone.
  if (isSystemDocument(access)) return forbidden(SYSTEM_DOCUMENT_REFUSAL)
  if (!canDeleteDocument(access)) return forbidden(DELETE_REFUSAL)

  if (permanent) {
    // Permanent delete must also tear down any knowledge graph derived from
    // this document — same polymorphic-provenance hole as captures (migration
    // 109; claim_source/entity_link don't cascade). The RPC (migration 178)
    // hard-deletes claims sole-sourced by this document, prunes shared-claim
    // evidence + mirrored edges, and deletes the document row, atomically.
    const { error } = await supabase.rpc('delete_document_with_knowledge', {
      p_document_id: id,
      p_workspace_id: workspaceId,
      p_user_id: user.id,
    })

    if (error) {
      const code = (error as { code?: string }).code
      if (code === 'P0002') {
        return NextResponse.json({ error: 'Document not found' }, { status: 404 })
      }
      if (code === SYSTEM_DOCUMENT_SQLSTATE) {
        return forbidden(SYSTEM_DOCUMENT_REFUSAL)
      }
      if (code === NOT_ALLOWED) {
        return forbidden(DELETE_REFUSAL)
      }
      console.error('[document.delete] cleanup RPC failed:', code, error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  } else {
    // Archive is a delete (the DELETE rule above), not an edit: the creator of
    // a spec page may archive it though they can't edit it, so the write runs
    // on the service client after that check. `.select('id')` makes a 0-row
    // archive a 404 instead of a silent success.
    const { data: archived, error } = await getServiceClient()
      .from('document')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .select('id')

    if (error) {
      if ((error as { code?: string }).code === SYSTEM_DOCUMENT_SQLSTATE) return forbidden(SYSTEM_DOCUMENT_REFUSAL)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!archived || (archived as unknown[]).length === 0) return notFound('Document not found')
  }

  return NextResponse.json({ success: true })
}

/** The guard's own line when it raised (it says what was refused), else the generic one. */
function refusalOrDefault(message: string, code: string): string {
  return code === NOT_ALLOWED && message ? message : EDIT_REFUSAL
}
