'use client'

import { useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { useOptionalRecordingStable } from '@/hooks/recording-context'

/**
 * Global prompt shown on launch when an interrupted capture is detected (the app
 * closed/crashed within ~10 minutes of an active recording). We deliberately ask
 * before turning the mic back on rather than silently auto-resuming.
 *
 * Confirm → resume the capture. Cancel → end it as Stop would: the server
 * closes it and writes the meeting up from what was captured (and the
 * recovery marker is dropped so it isn't offered again).
 *
 * Resume holds the focus when the prompt opens. Radix focuses Cancel by
 * default, so Enter or Space ended the capture: on the 2026-10-19 Owen call a
 * mid-call restart's prompt was answered End capture seconds after launch and
 * the meeting split into two captures.
 */
export function CaptureRecoveryPrompt() {
  const recording = useOptionalRecordingStable()
  const [busy, setBusy] = useState(false)
  const resumeRef = useRef<HTMLButtonElement>(null)

  const pending = recording?.pendingRecovery
  if (!recording || !pending) return null

  const handleConfirm = async () => {
    setBusy(true)
    try {
      await recording.confirmRecovery()
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = async () => {
    setBusy(true)
    try {
      await recording.dismissRecovery()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open>
      <AlertDialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          resumeRef.current?.focus()
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Resume interrupted capture?</AlertDialogTitle>
          <AlertDialogDescription>
            It looks like “{pending.title}” was still recording when the app
            closed. Want to resume it? Choosing End capture keeps what was
            captured and writes up the meeting from it, without recording
            again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} onClick={handleDismiss}>
            End capture
          </AlertDialogCancel>
          <AlertDialogAction ref={resumeRef} disabled={busy} onClick={handleConfirm}>
            Resume recording
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
