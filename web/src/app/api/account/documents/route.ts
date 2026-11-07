import { createClient } from '@/lib/supabase/server'
import { withServerFrontmatter } from '@/lib/agent-events/prep-ref'
import { indexDocument } from '@/lib/ai/embeddings'
import { trackServerEvent } from '@/lib/posthog'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { templateKey } from '@/lib/documents/canon'
import { createCanonDocument } from '@/lib/documents/canon-create'

export async function GET(request: NextRequest) {
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

  const { searchParams } = request.nextUrl
  const projectId = searchParams.get('project_id')
  const teamId = searchParams.get('team_id')
  const search = searchParams.get('search')

  const type = searchParams.get('type')
  const tag = searchParams.get('tag')
  const publishedStatus = searchParams.get('published_status')
  // document.kind (migration 367): 'doc', 'report' or 'prep', comma-separated.
  const kinds = (searchParams.get('kind') ?? '').split(',').map((k) => k.trim()).filter((k) => ['doc', 'report', 'prep'].includes(k))

  let query = supabase
    .from('document')
    .select(`
      id, title, content, slug, type, tags, frontmatter, project_id, team_id, status, kind, visibility, published_status, published_at, is_pinned, sort_order, created_at, updated_at,
      project:projects!project_id(id, name),
      author:member!created_by(id, display_name, avatar_url)
    `)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')

  if (type) query = query.eq('type', type)
  // The person's Now file (kind 'now', migration 440) is in no list: it opens
  // from its chat row. (The kind filter above never admits it either.)
  if (kinds.length) query = query.in('kind', kinds)
  else query = query.neq('kind', 'now')
  if (tag) query = query.contains('tags', [tag])
  if (publishedStatus) query = query.eq('published_status', publishedStatus)

  if (projectId) {
    query = query.eq('project_id', projectId)
  }
  if (teamId) {
    query = query.eq('team_id', teamId)
  }
  if (search) {
    query = query.textSearch('fts', search, { type: 'websearch' })
  }

  query = query
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false })

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const documents = (data || []).map((d) => {
    const projectData = d.project as unknown as { id: string; name: string } | null
    const authorData = d.author as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    return {
      id: d.id,
      title: d.title,
      slug: d.slug,
      type: d.type,
      kind: (d as { kind?: string }).kind ?? 'doc',
      tags: d.tags || [],
      content_preview: d.content ? d.content.slice(0, 200) : null,
      project_id: d.project_id,
      project_name: projectData?.name || null,
      team_id: d.team_id,
      created_by: authorData?.id || null,
      created_by_name: authorData?.display_name || null,
      created_by_avatar: authorData?.avatar_url || null,
      status: d.status,
      published_status: d.published_status,
      published_at: d.published_at,
      is_pinned: d.is_pinned,
      created_at: d.created_at,
      updated_at: d.updated_at,
    }
  })

  // Batch-fetch comment counts
  const docIds = documents.map((d) => d.id)
  let commentCounts: Record<string, number> = {}
  if (docIds.length > 0) {
    const { data: counts } = await supabase
      .from('comment')
      .select('commentable_id')
      .eq('commentable_type', 'document')
      .in('commentable_id', docIds)
    commentCounts = (counts || []).reduce((acc: Record<string, number>, c: { commentable_id: string }) => {
      acc[c.commentable_id] = (acc[c.commentable_id] || 0) + 1
      return acc
    }, {})
  }

  const documentsWithCounts = documents.map((d) => ({
    ...d,
    comment_count: commentCounts[d.id] || 0,
  }))

  return NextResponse.json({ documents: documentsWithCounts })
}

export async function POST(request: NextRequest) {
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

  const body = await request.json()

  // A canon document from its template (canon D2): `canon_template` names it
  // (product, team-playbook, person:voice, content-brief with `channel`). The
  // template's sections, under its key; who may create which is
  // createCanonDocument's check, on the service client.
  if (body.canon_template !== undefined) {
    const key = typeof body.canon_template === 'string' ? templateKey(body.canon_template, typeof body.channel === 'string' ? body.channel : null) : null
    if (!key) return NextResponse.json({ error: 'Unknown canon template' }, { status: 400 })
    const result = await createCanonDocument(getServiceClient(), {
      workspaceId,
      userId: user.id,
      key,
      title: typeof body.title === 'string' ? body.title : null,
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ document: result.document, outcome: result.outcome, missing_sections: result.missingSections }, { status: result.outcome === 'created' ? 201 : 200 })
  }

  const title = (body.title || 'Untitled Document').trim()

  // Resolve current member id
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    title,
    created_by: member?.id || null,
    status: 'active',
  }

  if (body.content !== undefined) insert.content = body.content
  if (body.content_json !== undefined) insert.content_json = body.content_json
  if (body.project_id) insert.project_id = body.project_id
  if (body.team_id) insert.team_id = body.team_id
  if (body.slug) insert.slug = body.slug
  if (body.type) insert.type = body.type
  if (Array.isArray(body.tags)) insert.tags = body.tags
  // A meeting-prep stamp is the server's alone (prep-ref.ts withServerFrontmatter).
  const frontmatter = withServerFrontmatter(body.frontmatter)
  if (frontmatter) insert.frontmatter = frontmatter
  if (body.published_status) insert.published_status = body.published_status
  if (member?.id) insert.last_edited_by = member.id

  const { data, error } = await supabase
    .from('document')
    .insert(insert)
    .select('id, title, content, slug, type, tags, project_id, status, published_status, is_pinned, created_at, updated_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  trackServerEvent('document_created', { userId: user.id, workspaceId, email: user.email }, { document_id: data.id })

  // Sync wikilinks on first save (published rows only — drafts re-sync on
  // publish). Must be awaited: a Vercel function freezes once the response
  // returns, so a dropped promise can leave links unsynced.
  if (data.published_status === 'published' && typeof body.content === 'string' && body.content.length > 0) {
    const { syncDocumentLinks } = await import('@/lib/wiki/wikilinks')
    await syncDocumentLinks(supabase, workspaceId, data.id, body.content, member?.id || null)
  }

  // Index the body for semantic search (document_chunks, migration 185). Best-
  // effort and awaited — a Vercel function freezes after the response returns,
  // so a dropped promise could leave the doc unembedded. indexDocument skips
  // empty/short bodies on its own. Mirrors the capture re-index precedent
  // (captures/[id] PATCH): an embedding failure must never fail the create.
  if (typeof data.content === 'string' && data.content.length > 0) {
    try {
      await indexDocument(supabase, data.id, user.id, data.project_id ?? null, data.content, workspaceId)
    } catch (err) {
      console.error('[documents.post] index failed (non-fatal):', err)
    }
  }

  return NextResponse.json({ document: data })
}
