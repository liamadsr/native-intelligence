import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { generateCaptureTitle } from '@/lib/captures/generate-title'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/captures/[id]/generate-title
 *
 * Generates a concise title for a capture from its ai_summary.
 * Only runs if the current title matches the auto-generated pattern ("Capture Mon D H:MM AM/PM").
 * Called fire-and-forget when recording stops. The work is generateCaptureTitle
 * (src/lib/captures/generate-title.ts), which the server-side finalizer of an
 * abandoned recording calls too.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  try {
    const result = await generateCaptureTitle(supabase, { captureId: id, workspaceId, userId: user.id })
    if (result.status === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (result.status === 'skipped') return NextResponse.json({ skipped: true, reason: result.reason })
    return NextResponse.json({ ok: true, title: result.title })
  } catch (err) {
    console.error('[generate-title] Failed:', err)
    return NextResponse.json({ error: 'Title generation failed' }, { status: 500 })
  }
}
