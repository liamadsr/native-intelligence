import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/resume
 *
 * Unlock an ended capture for continued recording (clear ended_at + the
 * transcript lock), conflict-aware under migration 226's one-live-capture-
 * per-user-per-event index:
 *
 * - Calendar sync (and from-event) legitimately keep a live pending row for
 *   the meeting's NEXT occurrence — for EventKit series that row shares this
 *   capture's calendar_event_id, so a naive un-end PATCH would violate the
 *   unique index every time. A transcript-less placeholder is absorbed
 *   (archived) so the resume can proceed.
 * - A live row WITH content means another session is actively recording this
 *   meeting — the resume is refused instead of silently recording into a row
 *   that stays locked (the old fire-and-forget unlock lost the entire resumed
 *   session's transcript in that case).
 */
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

  const { data: capture } = await supabase
    .from('captures')
    .select('id, calendar_event_id, ended_at, metadata')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  const supabaseAdmin = getServiceClient()

  if (capture.calendar_event_id && capture.ended_at) {
    const { data: other } = await supabaseAdmin
      .from('captures')
      .select('id, transcript')
      .eq('calendar_event_id', capture.calendar_event_id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .is('ended_at', null)
      .neq('id', id)
      .limit(1)
      .maybeSingle()

    if (other) {
      if (other.transcript?.trim()) {
        return NextResponse.json(
          { error: 'Another capture for this meeting is currently in progress', capture_id: other.id },
          { status: 409 },
        )
      }
      // Transcript-less placeholder (sync pending row) — absorb it so the
      // unlock below doesn't violate the unique index. Archived, not ended:
      // an ended empty row would read as a zero-length session.
      const { error: archiveError } = await supabaseAdmin
        .from('captures')
        .update({ status: 'archived' })
        .eq('id', other.id)
      if (archiveError) {
        return NextResponse.json({ error: archiveError.message }, { status: 500 })
      }
    }
  }

  // A reopened capture is unprocessed again: clear the processed stamp (so
  // note-taker directives are taken again and its next end runs its pass) and
  // a server close's `metadata.finalized` (so a decline of THIS session is
  // finished, not read as the earlier one's).
  const metadata =
    capture.metadata && typeof capture.metadata === 'object'
      ? { ...(capture.metadata as Record<string, unknown>) }
      : null
  if (metadata) delete metadata.finalized
  const { error: unlockError } = await supabaseAdmin
    .from('captures')
    .update({
      ended_at: null,
      is_transcript_locked: false,
      batch_processed_at: null,
      ...(metadata ? { metadata } : {}),
    })
    .eq('id', id)

  if (unlockError) {
    if (unlockError.code === '23505') {
      return NextResponse.json(
        { error: 'Another capture for this meeting is currently in progress' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: unlockError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
