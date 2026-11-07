import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { mergeContactPair } from '@/lib/crm/contact-dedup'
import { NextResponse, type NextRequest } from 'next/server'

// Merge management for a single (target) contact:
//   POST   — fold another contact (source_id) into this one
//   GET    — list merges that produced this contact (undo history)
//   DELETE — undo a merge (merge_id) and split the contacts back apart

async function resolve(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return { error: NextResponse.json({ error: 'No workspace' }, { status: 400 }) }

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()
  if (!member) return { error: NextResponse.json({ error: 'Not a workspace member' }, { status: 403 }) }

  return { supabase, workspaceId, memberId: member.id as string }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolve(request)
  if ('error' in ctx) return ctx.error
  const { supabase, workspaceId, memberId } = ctx

  const { id: targetId } = await params
  const body = await request.json().catch(() => ({}))
  const sourceId: string | undefined = body.source_id
  if (!sourceId) return NextResponse.json({ error: 'source_id is required' }, { status: 400 })
  if (sourceId === targetId) return NextResponse.json({ error: 'Cannot merge a contact into itself' }, { status: 400 })

  // Both contacts must belong to the caller's workspace and still be active.
  const { data: rows, error } = await supabase
    .from('contact')
    .select('id, merged_into_contact_id')
    .eq('workspace_id', workspaceId)
    .in('id', [targetId, sourceId])
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length !== 2) {
    return NextResponse.json({ error: 'Contact not found in this workspace' }, { status: 404 })
  }
  if (rows.some((r) => r.merged_into_contact_id)) {
    return NextResponse.json({ error: 'One of the contacts is already merged' }, { status: 409 })
  }

  const res = await mergeContactPair({
    targetId,
    sourceId,
    matchType: 'manual',
    performedBy: memberId,
    reasons: ['merged manually'],
  })
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 500 })

  return NextResponse.json({ success: true, target_id: res.targetId })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolve(request)
  if ('error' in ctx) return ctx.error
  const { supabase, workspaceId } = ctx

  const { id: targetId } = await params

  const { data, error } = await supabase
    .from('contact_merge')
    .select('id, source_contact_id, source_snapshot, match_type, score, reasons, performed_by, undone_at, created_at')
    .eq('workspace_id', workspaceId)
    .eq('target_contact_id', targetId)
    .order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const merges = (data || []).map((m) => {
    const snap = (m.source_snapshot || {}) as Record<string, unknown>
    return {
      id: m.id,
      source_contact_id: m.source_contact_id,
      source_name: (snap.full_name as string) || null,
      source_email: (snap.email as string) || null,
      match_type: m.match_type,
      score: m.score,
      reasons: m.reasons,
      performed_by: m.performed_by,
      undone_at: m.undone_at,
      created_at: m.created_at,
    }
  })

  return NextResponse.json({ merges })
}

export async function DELETE(
  request: NextRequest,
  { params: _params }: { params: Promise<{ id: string }> },
) {
  const ctx = await resolve(request)
  if ('error' in ctx) return ctx.error
  const { supabase, workspaceId } = ctx

  const mergeId = request.nextUrl.searchParams.get('merge_id')
  if (!mergeId) return NextResponse.json({ error: 'merge_id is required' }, { status: 400 })

  // Confirm the merge belongs to this workspace before undoing it.
  const { data: merge, error } = await supabase
    .from('contact_merge')
    .select('id, undone_at')
    .eq('workspace_id', workspaceId)
    .eq('id', mergeId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!merge) return NextResponse.json({ error: 'Merge not found' }, { status: 404 })
  if (merge.undone_at) return NextResponse.json({ error: 'Merge already undone' }, { status: 409 })

  const supabaseAdmin = getServiceClient()
  const { data: restoredId, error: rpcError } = await supabaseAdmin.rpc('unmerge_contacts', {
    p_merge_id: mergeId,
  })
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 })

  return NextResponse.json({ success: true, source_id: restoredId })
}
