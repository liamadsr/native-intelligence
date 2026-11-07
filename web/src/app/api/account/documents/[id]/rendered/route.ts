import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { renderEmbeddedQueries } from '@/lib/wiki/render'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Returns the rendered view of a document — body unchanged, plus the
 * resolved data for every {{...}} block in it.
 *
 * The renderer doesn't mutate the body; the caller (UI) is responsible for
 * splicing in the resolved blocks (typically by replacing the raw `{{...}}`
 * text with a rendered component).
 *
 * Query params:
 *   - source=draft → render the current user's draft instead of published
 *                    body (so the editor can preview embedded queries live).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const source = request.nextUrl.searchParams.get('source')

  let content: string | null = null
  if (source === 'draft') {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (member?.id) {
      const { data: draft } = await supabase
        .from('document_draft')
        .select('content')
        .eq('document_id', id)
        .eq('author_id', member.id)
        .maybeSingle()
      content = draft?.content ?? null
    }
  }

  if (content === null) {
    const { data: doc, error } = await supabase
      .from('document')
      .select('content')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    content = doc.content ?? ''
  }

  const { body, blocks } = await renderEmbeddedQueries(supabase, workspaceId, content ?? '')
  return NextResponse.json({ body, blocks })
}
