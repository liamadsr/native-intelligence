import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

const INVERSE_MAP: Record<string, string> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; relationId: string }> },
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

  const { relationId } = await params

  // Fetch the relation to find its inverse
  const { data: relation } = await supabase
    .from('action_relation')
    .select('id, type, action_id, related_action_id')
    .eq('id', relationId)
    .single()

  if (!relation) {
    return NextResponse.json({ error: 'Relation not found' }, { status: 404 })
  }

  // Verify the source action belongs to this user's workspace
  const { data: ownerCheck } = await supabase
    .from('actions')
    .select('id')
    .eq('id', relation.action_id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!ownerCheck) {
    return NextResponse.json({ error: 'Relation not found' }, { status: 404 })
  }

  // Delete the relation
  await supabase.from('action_relation').delete().eq('id', relationId)

  // Delete inverse if it exists
  const inverse = INVERSE_MAP[relation.type]
  if (inverse) {
    await supabase
      .from('action_relation')
      .delete()
      .eq('action_id', relation.related_action_id)
      .eq('related_action_id', relation.action_id)
      .eq('type', inverse)
  }

  return NextResponse.json({ success: true })
}
