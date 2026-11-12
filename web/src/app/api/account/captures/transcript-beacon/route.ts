import { requireWorkspace } from '@/lib/api-auth'
import { NextResponse, type NextRequest } from 'next/server'
import { TRANSCRIPT_FROM_CALL, feedOwnsTranscript } from '@/lib/capture-feed/transcript'

/**
 * Transcript flush beacon. Called via `navigator.sendBeacon` on pagehide /
 * beforeunload while a recording is live, so the latest transcript is persisted
 * even during tab close / app teardown — where a normal async fetch can't
 * reliably complete. sendBeacon only issues POSTs, so this can't reuse the
 * PATCH route on captures/[id].
 *
 * Applies the SAME no-shrink guard as the capture PATCH route: it never replaces
 * a non-empty transcript with an empty or strictly shorter one. This is a
 * best-effort, fire-and-forget endpoint — it always returns 200 quickly so the
 * browser doesn't penalize the beacon, and it never throws back to the caller.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireWorkspace()
    if (auth instanceof Response) return auth
    const { supabase, workspaceId } = auth

    let body: { capture_id?: string; transcript?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ ok: false }, { status: 200 })
    }

    const captureId = body.capture_id
    const incoming = typeof body.transcript === 'string' ? body.transcript : ''
    if (!captureId || incoming.trim().length === 0) {
      return NextResponse.json({ ok: false }, { status: 200 })
    }

    const { data: existingRow } = await supabase
      .from('captures')
      .select('transcript, is_transcript_locked, ended_at, metadata')
      .eq('id', captureId)
      .eq('workspace_id', workspaceId)
      .single()

    // A call's capture the recorder is filling: its transcript is the feed's while the call runs.
    // Refused, nothing written (200 like every beacon answer: a beacon never reads it).
    if (feedOwnsTranscript(existingRow)) {
      return NextResponse.json({ ok: false, code: TRANSCRIPT_FROM_CALL }, { status: 200 })
    }

    // Don't touch a locked (finalized) capture — mirrors the DB trigger.
    if (existingRow?.is_transcript_locked) {
      return NextResponse.json({ ok: false, locked: true }, { status: 200 })
    }

    const existing = typeof existingRow?.transcript === 'string' ? existingRow.transcript : ''
    // No-shrink guard: only persist when equal-or-longer than what's stored.
    if (existing.trim().length > 0 && incoming.trim().length < existing.trim().length) {
      return NextResponse.json({ ok: false, skipped: 'shrink' }, { status: 200 })
    }

    await supabase
      .from('captures')
      .update({ transcript: incoming })
      .eq('id', captureId)
      .eq('workspace_id', workspaceId)

    return NextResponse.json({ ok: true }, { status: 200 })
  } catch {
    // Best-effort: never surface an error to a beacon caller.
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}
