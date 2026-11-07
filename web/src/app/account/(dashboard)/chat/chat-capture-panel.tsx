'use client'

import { useRecordingStable } from '@/hooks/recording-context'

/**
 * Compact capture panel for the floating chat.
 * Shows: recording error and post-session review.
 * Recording controls live in the Capture button; voice ID, transcripts and the
 * live agent's controls in the composer while a capture page is on screen —
 * and, while a capture records, all of them wherever its page is (see
 * LiveAgentComposerPortal).
 */
export function ChatCapturePanel() {
  // recordingError lives in the STABLE context (it changes on mic failure, not
  // at audio-frame rate) — read it here so the parent chat panel doesn't have to
  // pass down the whole volatile recording object just to feed this one field.
  const { recordingError } = useRecordingStable()

  // Nothing to show — hide panel entirely
  if (!recordingError) return null

  return (
    <div className="border-b border-border/40">
      {/* ── Error ──────────────────────────────────────────────── */}
      {recordingError && (
        <div className="px-4 py-2 text-xs text-destructive">
          {recordingError}
        </div>
      )}
    </div>
  )
}
