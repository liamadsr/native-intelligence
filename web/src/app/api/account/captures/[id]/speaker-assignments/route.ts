import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET /api/account/captures/[id]/speaker-assignments
 *
 * Retrieve speaker-to-contact assignments for a capture.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id: captureId } = await params

  // Verify capture belongs to this workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data, error } = await supabase
    .from('capture_participant')
    .select('id, speaker_label, contact_id, voice_match_confidence, external_name, contact:contact_id(id, full_name, email)')
    .eq('capture_id', captureId)
    .not('speaker_label', 'is', null)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ assignments: data || [] })
}

/**
 * POST /api/account/captures/[id]/speaker-assignments
 *
 * Save speaker-to-contact assignments when recording stops.
 * Upserts capture_participant rows with speaker_label, contact_id, and confidence.
 *
 * Body: {
 *   assignments: [{
 *     speaker_label: "remote_1",
 *     contact_id: "uuid",
 *     contact_name: "Emily",
 *     voice_match_confidence: 0.92
 *   }]
 * }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id: captureId } = await params
  const body = await request.json()
  const { assignments } = body as {
    assignments: {
      speaker_label: string
      contact_id: string
      contact_name: string
      voice_match_confidence?: number
    }[]
  }

  if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
    return NextResponse.json({ error: 'No assignments provided' }, { status: 400 })
  }

  // Verify capture belongs to this workspace
  const { data: capture, error: captureError } = await supabase
    .from('captures')
    .select('id')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .single()

  if (captureError || !capture) {
    // Capture may not exist yet (e.g. test recordings from settings page).
    // Skip participant linking — enrollments are saved separately.
    return NextResponse.json({ skipped: true, reason: 'Capture not found' })
  }

  // Validate every posted contact_id belongs to THIS workspace before linking.
  // Otherwise a member could point a capture participant at a contact_id from
  // another workspace (the same poisoning gap the voice-enrollments route
  // closes — capture_participant RLS is workspace-wide FOR ALL).
  //
  // Filter PER ROW rather than 403-ing the whole batch: at stop we save every
  // speaker at once, and a single stale contact_id (e.g. a contact deleted
  // mid-meeting) must not nuke ALL the other, valid speaker links. Rows whose
  // contact_id isn't in this workspace are skipped (logged + reported); the
  // rest are processed. A single-item request with a foreign contact still
  // gets nothing linked, and the cross-workspace-write property holds row-wise.
  const referencedContactIds = new Set(
    assignments.map((a) => a.contact_id).filter((id): id is string => !!id),
  )
  let ownedIds = new Set<string>()
  if (referencedContactIds.size > 0) {
    const [{ data: ownedContacts, error: contactError }, { data: me }] = await Promise.all([
      supabase
        .from('contact')
        .select('id, member_id')
        .eq('workspace_id', workspaceId)
        .in('id', Array.from(referencedContactIds)),
      supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle(),
    ])
    if (contactError) return NextResponse.json({ error: contactError.message }, { status: 500 })
    // The caller's own member-linked contact is not an attendee: their voice
    // binds their self row (/self-confirm), never a second participant row
    // (followups issue 11).
    const myMemberId = (me as { id: string } | null)?.id ?? null
    ownedIds = new Set(
      ((ownedContacts || []) as Array<{ id: string; member_id: string | null }>)
        .filter((c) => !myMemberId || c.member_id !== myMemberId)
        .map((c) => c.id),
    )
  }

  // Rows referencing a contact_id NOT in this workspace are dropped. Rows with
  // no contact_id (external_name-only speakers) always pass — they link no
  // cross-workspace row.
  const skippedContactIds: string[] = []
  const acceptedAssignments = assignments.filter((a) => {
    if (!a.contact_id) return true
    if (ownedIds.has(a.contact_id)) return true
    skippedContactIds.push(a.contact_id)
    return false
  })
  if (skippedContactIds.length > 0) {
    console.warn(
      `[speaker-assignments] Skipped ${skippedContactIds.length} assignment(s) referencing contact_id(s) not in workspace ${workspaceId} or the caller's own contact:`,
      skippedContactIds,
    )
  }

  // Upsert capture_participant rows for each speaker assignment
  const results = []
  for (const assignment of acceptedAssignments) {
    // Check if a participant already exists for this speaker_label
    const { data: existing } = await supabase
      .from('capture_participant')
      .select('id, is_self')
      .eq('capture_id', captureId)
      .eq('speaker_label', assignment.speaker_label)
      .maybeSingle()

    // A label already bound to the user's own self row is theirs: an attendee
    // assignment never overwrites it (followups issue 11).
    if ((existing as { is_self?: boolean | null } | null)?.is_self === true) {
      results.push({ speaker_label: assignment.speaker_label, action: 'skipped_self' })
      continue
    }

    if (existing) {
      // Update existing participant
      const { error } = await supabase
        .from('capture_participant')
        .update({
          contact_id: assignment.contact_id,
          voice_match_confidence: assignment.voice_match_confidence || null,
          external_name: assignment.contact_name,
        })
        .eq('id', existing.id)

      if (error) {
        console.error(`[speaker-assignments] Update failed for ${assignment.speaker_label}:`, error)
      } else {
        results.push({ speaker_label: assignment.speaker_label, action: 'updated' })
      }
    } else {
      // Insert new participant
      const { error } = await supabase
        .from('capture_participant')
        .insert({
          capture_id: captureId,
          speaker_label: assignment.speaker_label,
          contact_id: assignment.contact_id,
          voice_match_confidence: assignment.voice_match_confidence || null,
          external_name: assignment.contact_name,
          role: 'attendee',
        })

      if (error) {
        console.error(`[speaker-assignments] Insert failed for ${assignment.speaker_label}:`, error)
      } else {
        results.push({ speaker_label: assignment.speaker_label, action: 'created' })
      }
    }
  }

  return NextResponse.json({
    results,
    skippedCount: skippedContactIds.length,
    skippedContactIds,
  })
}
