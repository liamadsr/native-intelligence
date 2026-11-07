import { createClient } from '@/lib/supabase/server'
import { trackServerEvent, type ProductEvent } from '@/lib/posthog'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/analytics/recording-event
 *
 * Durable sink for recording-lifecycle reliability telemetry emitted from the
 * desktop WebView (recording-context.tsx / use-recording.ts). These events exist
 * so a future "my transcript stopped / didn't resume" incident is diagnosable
 * from the PostHog stream instead of DB archaeology (cf. the capture that landed
 * duration_seconds=3 after a WebView freeze).
 *
 * Server-side so the event lands on the SAME person/workspace profile as every
 * other product event (the browser PostHog instance isn't reliably initialised
 * inside the Tauri WebView). Fail-soft by design: unauthenticated → 401 no-op,
 * unknown event → 400 no-op, and it never throws into the recording path.
 */

// Only the recording-lifecycle subset of ProductEvent may be emitted here, so a
// compromised/buggy client can't fire arbitrary product events through this route.
const ALLOWED: ReadonlySet<ProductEvent> = new Set<ProductEvent>([
  'recording_resumed',
  'resume_failed',
  // Launch-time recovery of an interrupted capture: prompt shown, declined, or
  // skipped (with the reason no prompt was shown).
  'recovery_prompted',
  'recovery_declined',
  'recovery_skipped',
  'transcription_connected',
  'transcription_source_stalled',
  // Live transcription setup failed to connect (both Deepgram legs failed), per
  // failed attempt and once with reason:'exhausted' when the retry loop gives up.
  'transcription_failed',
  // Transcript auto-save degradation (locked-terminal / 4xx / 5xx fallback /
  // no-shrink skip). Without this the client fires it but the route 400s and it
  // never reaches PostHog — the persistent-append outage stayed invisible.
  'transcript_save_degraded',
  // The stop-time force-PATCH was rejected (non-2xx): the final transcript may
  // not be durable. Loud on purpose — this used to pass silently.
  'final_transcript_save_failed',
  // System-audio (other-participant capture) permission telemetry from the
  // desktop recording flow — the observed permission status of a recording, and
  // user-initiated permission requests + their outcome.
  'system_audio_permission_status',
  'system_audio_permission_requested',
  // On-device transcription (desktop local-stt module): a finished local
  // session and a fallback to Deepgram. Analytics only — local is never billed.
  'local_transcription_completed',
  'local_transcription_fallback',
])

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ tracked: false }, { status: 401 })

  let body: { event?: string; workspaceId?: string | null; properties?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ tracked: false }, { status: 400 })
  }

  const event = body.event as ProductEvent | undefined
  if (!event || !ALLOWED.has(event)) {
    return NextResponse.json({ tracked: false }, { status: 400 })
  }

  // Keep only JSON-scalar properties so a client can't smuggle large/odd payloads
  // into the analytics pipeline.
  const props: Record<string, unknown> = {}
  if (body.properties && typeof body.properties === 'object') {
    for (const [k, v] of Object.entries(body.properties)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) props[k] = v
    }
  }

  trackServerEvent(
    event,
    { userId: user.id, workspaceId: body.workspaceId ?? null, email: user.email },
    props,
  )

  return NextResponse.json({ tracked: true })
}
