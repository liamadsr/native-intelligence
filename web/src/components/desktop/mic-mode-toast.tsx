'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { isDesktopApp } from '@/lib/platform'
import { useRecordingStable } from '@/hooks/recording-context'
import { getThisWebviewLabel, tauriBridge, type MicMode } from '@/lib/tauri-bridge'

const TOAST_ID = 'mic-mode'
const POLL_MS = 5000

/** The modes worth a word, and what to say about each. */
const COPY: Partial<Record<MicMode, { title: string; description: string }>> = {
  'voice-isolation': {
    title: 'Voice Isolation is on for Dial8',
    description:
      'It removes other people in the room from your recording. Choose Standard in Mic Mode.',
  },
  'wide-spectrum': {
    title: 'Wide Spectrum is on for Dial8',
    description: 'Choose Standard in Mic Mode for the most reliable recordings.',
  },
}

/**
 * Dial8's macOS Mic Mode (Control Center → Mic Mode), while a desktop
 * recording is live. Voice Isolation strips other people in the room out of
 * the recording, and either non-standard mode makes macOS reconfigure every
 * app's audio each time a Dial8 process starts audio, which can deadlock
 * macOS's audio daemon (see the desktop's audio/health.rs).
 *
 * An app can't change its own Mic Mode, so the action opens the menu. macOS
 * lists Dial8 there only while it's using the mic, which is also why this
 * only ever shows during a recording. Reading the mode is a preference read:
 * it never touches the mic.
 *
 * Once per recording: dismissed, it stays away until the next one; switched
 * to Standard, it goes by itself. Main window only.
 *
 * Renders nothing — it only drives the global <Toaster> mounted in the shell.
 */
export function MicModeToast() {
  const { isRecording } = useRecordingStable()

  useEffect(() => {
    if (!isDesktopApp() || !isRecording) return
    let disposed = false
    let dismissed = false
    let shown: MicMode | null = null

    const check = async () => {
      const mode = await tauriBridge.micMode.get()
      if (disposed || dismissed) return
      const copy = COPY[mode]
      if (!copy) {
        if (shown) toast.dismiss(TOAST_ID)
        shown = null
        return
      }
      if (shown === mode) return
      shown = mode
      toast.warning(copy.title, {
        id: TOAST_ID,
        description: copy.description,
        duration: Infinity,
        onDismiss: () => {
          dismissed = true
        },
        action: {
          label: 'Open Mic Mode',
          onClick: (event) => {
            // Stay up until the mode really changes (the next check).
            event.preventDefault()
            void tauriBridge.micMode.openPicker().catch(() => {})
          },
        },
      })
    }

    let timer: ReturnType<typeof setInterval> | undefined
    void getThisWebviewLabel().then((label) => {
      if (disposed || (label !== null && label !== 'main')) return
      void check()
      timer = setInterval(() => void check(), POLL_MS)
    })

    return () => {
      disposed = true
      if (timer) clearInterval(timer)
      toast.dismiss(TOAST_ID)
    }
  }, [isRecording])

  return null
}
