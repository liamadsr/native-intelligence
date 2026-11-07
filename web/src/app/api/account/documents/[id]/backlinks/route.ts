import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Backlinks: every entity_link row pointing AT this document. Resolves the
 * source side to titles for documents and claims; other types come back as
 * `{type, id}` for the UI to render generically.
 */
export async function GET(
  _request: NextRequest,
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

  const { data: links, error } = await supabase
    .from('entity_link')
    .select('id, source_type, source_id, relation, created_at')
    .eq('workspace_id', workspaceId)
    .eq('target_type', 'document')
    .eq('target_id', id)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const documentIds = (links || []).filter((l) => l.source_type === 'document').map((l) => l.source_id as string)
  const claimIds = (links || []).filter((l) => l.source_type === 'claim').map((l) => l.source_id as string)

  const titles = new Map<string, string>()
  if (documentIds.length > 0) {
    const { data: docs } = await supabase
      .from('document')
      .select('id, title, slug')
      .in('id', documentIds)
      .eq('workspace_id', workspaceId)
    for (const d of docs || []) {
      titles.set(`document:${d.id}`, (d.title as string) || (d.slug as string) || d.id)
    }
  }
  if (claimIds.length > 0) {
    const { data: claims } = await supabase
      .from('claim')
      .select('id, text')
      .in('id', claimIds)
      .eq('workspace_id', workspaceId)
    for (const c of claims || []) {
      const text = (c.text as string) || ''
      titles.set(`claim:${c.id}`, text.length > 80 ? `${text.slice(0, 80)}…` : text)
    }
  }

  const enriched = (links || []).map((l) => ({
    id: l.id,
    source_type: l.source_type,
    source_id: l.source_id,
    relation: l.relation,
    label: titles.get(`${l.source_type}:${l.source_id}`) || null,
    created_at: l.created_at,
  }))

  return NextResponse.json({ backlinks: enriched, count: enriched.length })
}
