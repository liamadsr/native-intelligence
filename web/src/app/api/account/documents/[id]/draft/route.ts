import { createClient } from '@/lib/supabase/server'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { parseRevision } from '@/lib/documents/write'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Per-user draft on a document.
 *
 * GET     → current user's draft, or null
 * PUT     → upsert the draft
 * DELETE  → discard the draft
 *
 * Drafts are private to the author (RLS enforced). They drain into the
 * document on POST /publish.
 *
 * A draft records the document revision it started from (base_revision,
 * migration 364): the `base_revision` the client read, on the first save that
 * sends one. Later saves keep it, so publishing a draft the document has moved
 * past asks first (publish route, STALE_DRAFT). A client that sends none (an
 * old bundle) leaves it null, never "the revision now", which would hide edits
 * made since: publishing a draft with no base asks first too.
 *
 * Any member may keep a draft of any page they can read: a draft is their
 * own row, never the document. Publishing it over the document is what needs
 * edit access (migration 359, src/lib/documents/access.ts), and the publish
 * route checks that.
 */

async function resolveContext(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return { error: NextResponse.json({ error: 'No workspace' }, { status: 400 }) }

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member?.id) return { error: NextResponse.json({ error: 'Not a workspace member' }, { status: 403 }) }

  return { supabase, workspaceId, memberId: member.id as string, request }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(_request)
  if ('error' in ctx) return ctx.error
  const { id } = await params

  const { data } = await ctx.supabase
    .from('document_draft')
    .select('document_id, title, content, content_json, frontmatter, tags, base_revision, updated_at')
    .eq('document_id', id)
    .eq('author_id', ctx.memberId)
    .maybeSingle()

  return NextResponse.json({ draft: data || null })
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(request)
  if ('error' in ctx) return ctx.error
  const { id } = await params
  const body = await request.json()

  // Confirm the document is visible to this user (RLS check via membership),
  // and whether this is the draft's first save.
  const [{ data: doc }, { data: existing }] = await Promise.all([
    ctx.supabase
      .from('document')
      .select('id, revision')
      .eq('id', id)
      .eq('workspace_id', ctx.workspaceId)
      .maybeSingle(),
    ctx.supabase
      .from('document_draft')
      .select('base_revision')
      .eq('document_id', id)
      .eq('author_id', ctx.memberId)
      .maybeSingle(),
  ])
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })

  const upsert: Record<string, unknown> = {
    document_id: id,
    workspace_id: ctx.workspaceId,
    author_id: ctx.memberId,
  }
  if (!existing || parseRevision((existing as { base_revision?: unknown }).base_revision) === null) {
    const base = parseRevision(body.base_revision)
    if (base !== null) upsert.base_revision = base
  }
  if (body.title !== undefined) upsert.title = body.title
  if (body.content !== undefined) upsert.content = body.content
  if (body.content_json !== undefined) upsert.content_json = body.content_json
  // A draft never carries a meeting-prep stamp (prep-ref.ts withServerFrontmatter).
  if (body.frontmatter !== undefined) upsert.frontmatter = body.frontmatter === null ? null : (withServerFrontmatter(body.frontmatter) ?? null)
  if (Array.isArray(body.tags)) upsert.tags = body.tags

  const { data, error } = await ctx.supabase
    .from('document_draft')
    .upsert(upsert, { onConflict: 'document_id,author_id' })
    .select('document_id, title, content, frontmatter, tags, base_revision, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ draft: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolveContext(_request)
  if ('error' in ctx) return ctx.error
  const { id } = await params

  const { error } = await ctx.supabase
    .from('document_draft')
    .delete()
    .eq('document_id', id)
    .eq('author_id', ctx.memberId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
