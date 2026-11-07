/**
 * Fire-and-forget client helper for recording-lifecycle reliability telemetry.
 *
 * Posts to /api/analytics/recording-event, which authenticates the session and
 * forwards to PostHog via trackServerEvent. Used from the recording hooks so a
 * future "transcript stopped / didn't resume" incident is diagnosable from the
 * event stream (cf. the capture that landed duration_seconds=3 after a freeze).
 *
 * Strictly best-effort: it NEVER throws and NEVER blocks the recording path —
 * callers do not await it. A failed/queued beacon must not affect capture.
 */
export type RecordingTelemetryEvent =
  | 'recording_resumed'
  | 'resume_failed'
  // The launch-time recovery of an interrupted capture: the prompt was shown,
  // the user chose End capture, or no prompt was shown and why (reason:
  // 'stale' | 'not_found' | 'ended' | 'check_failed' | 'recording'). See ProductEvent.
  | 'recovery_prompted'
  | 'recovery_declined'
  | 'recovery_skipped'
  | 'transcription_connected'
  | 'transcription_source_stalled'
  // Live transcription setup failed to connect: emitted per failed setup attempt
  // and once more with reason:'exhausted' when the bounded retry loop gives up
  // (the user is told no transcript is being captured). See ProductEvent.
  | 'transcription_failed'
  // A transcript auto-save entered a degraded state (a locked-terminal stop, a
  // 4xx delta-append that forced the full-text fallback, or a no-shrink guard
  // skip). Emitted so wedged / duplicated-transcript sessions are queryable.
  | 'transcript_save_degraded'
  // The authoritative stop-time force-PATCH was REJECTED (non-2xx) — the final
  // transcript may not be durable. Loud on purpose: this used to pass silently.
  | 'final_transcript_save_failed'
  // System-audio (other-participant capture) permission telemetry from the
  // desktop recording flow: the observed permission status of a recording, and a
  // user-initiated permission request + its outcome. Kept in sync with the route
  // allowlist + ProductEvent so a "couldn't capture the other side" report is
  // diagnosable from the event stream.
  | 'system_audio_permission_status'
  | 'system_audio_permission_requested'
  // On-device transcription analytics (local transcription is free — these are
  // never usage rows): a finished local session, and a switch to Deepgram.
  | 'local_transcription_completed'
  | 'local_transcription_fallback'

export function trackRecordingEvent(
  event: RecordingTelemetryEvent,
  properties: Record<string, string | number | boolean | null> = {},
): void {
  try {
    void fetch('/api/analytics/recording-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, properties }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    /* never let telemetry surface to the recording path */
  }
}
