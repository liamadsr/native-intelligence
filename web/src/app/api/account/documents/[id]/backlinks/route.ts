import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { loadReferenceEdges } from '@/lib/entity-links/references'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Backlinks: every entity_link row pointing AT this document, claims
 * included, each source labelled through the viewer's RLS by the shared
 * reader every kind's "Referenced in" uses (src/lib/entity-links/references.ts).
 * A source the viewer can't read is left out. The generic, any-kind route is
 * /api/account/entities/[type]/[id]/references.
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

  const loaded = await loadReferenceEdges(supabase, { workspaceId, type: 'document', id, includeClaims: true, limit: 100 })
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 })

  const backlinks = loaded.edges.map((l) => ({
    id: l.id,
    source_type: l.source_type,
    source_id: l.source_id,
    relation: l.relation,
    label: l.label,
    created_at: l.created_at,
  }))
  return NextResponse.json({ backlinks, count: backlinks.length })
}
