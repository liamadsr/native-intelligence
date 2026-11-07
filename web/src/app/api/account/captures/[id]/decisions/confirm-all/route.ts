import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
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

  // Verify the capture belongs to this user/workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const { data, error } = await supabase
    .from('decision')
    .update({ confirmation: 'confirmed' })
    .eq('capture_id', id)
    .eq('confirmation', 'suggested')
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Promote any decision_summary claims sourced from this capture in lockstep.
  // entity_link is the authoritative graph edge (relation: cites) so we use
  // it rather than re-matching on text.
  const { data: linkedClaimIds } = await supabase
    .from('entity_link')
    .select('source_id')
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'claim')
    .eq('target_type', 'capture')
    .eq('target_id', id)
    .eq('relation', 'cites')

  if (linkedClaimIds && linkedClaimIds.length > 0) {
    await supabase
      .from('claim')
      .update({ confirmation: 'confirmed', last_verified_at: new Date().toISOString() })
      .in('id', linkedClaimIds.map((l) => l.source_id as string))
      .eq('workspace_id', workspaceId)
      .eq('type', 'decision_summary')
      .eq('confirmation', 'suggested')
  }

  return NextResponse.json({ confirmed_count: data?.length || 0 })
}
