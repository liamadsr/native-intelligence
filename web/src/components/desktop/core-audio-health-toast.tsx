'use client'

import { useEffect } from 'react'
import { toast } from 'sonner'
import { isDesktopApp } from '@/lib/platform'
import { getThisWebviewLabel, tauriBridge, type AudioHealth } from '@/lib/tauri-bridge'

const TOAST_ID = 'core-audio-health'

/**
 * "macOS audio isn't responding": a persistent toast while the desktop app
 * reports macOS's audio daemon (coreaudiod) stuck (`audio://health`, see the
 * desktop's audio/health.rs). The daemon can deadlock (an Apple bug), and
 * then every app's audio stops and Native Intelligence can't record until it's restarted.
 * "Restart audio" does that: macOS asks for the Mac's password.
 *
 * Main window only, like the updater's binary half: a pop-out would stack a
 * second copy of the same app-wide problem.
 *
 * Renders nothing — it only drives the global <Toaster> mounted in the shell.
 */
export function CoreAudioHealthToast() {
  useEffect(() => {
    if (!isDesktopApp()) return
    let disposed = false
    let unsubscribe: () => void = () => {}
    let shown = false

    const apply = (health: AudioHealth) => {
      if (disposed) return
      if (health === 'unresponsive' && !shown) {
        shown = true
        showStuck()
      } else if (health === 'responsive' && shown) {
        shown = false
        toast.success('macOS audio is back', {
          id: TOAST_ID,
          description: 'Recording works again.',
          duration: 4000,
        })
      }
    }

    void getThisWebviewLabel().then((label) => {
      if (disposed || (label !== null && label !== 'main')) return
      unsubscribe = tauriBridge.audioHealth.onChanged(apply)
      // The verdict may have landed before this window subscribed.
      void tauriBridge.audioHealth.get().then(apply)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return null
}

function showStuck(description?: string) {
  toast.error("macOS audio isn't responding", {
    id: TOAST_ID,
    description:
      description ??
      "Your Mac's audio service has stopped responding, so Native Intelligence can't record. Restarting it takes a second and asks for your Mac's password.",
    duration: Infinity,
    action: {
      label: 'Restart audio',
      onClick: (event) => {
        // Keep the toast up: it becomes the progress, then the result.
        event.preventDefault()
        void restart()
      },
    },
  })
}

/** How long a restart gets to show up as audio://health before the toast
 *  says it didn't work. A fresh daemon answers within a couple of seconds. */
const RECHECK_MS = 10_000

async function restart() {
  toast.loading('Restarting macOS audio…', { id: TOAST_ID, duration: Infinity })
  try {
    await tauriBridge.audioHealth.restart()
    // Recovery arrives as audio://health → "macOS audio is back". If it
    // doesn't, don't leave the spinner up forever.
    setTimeout(() => {
      void tauriBridge.audioHealth.get().then((health) => {
        if (health === 'unresponsive') {
          showStuck("Audio still isn't responding. Try again, or restart your Mac.")
        }
      })
    }, RECHECK_MS)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    showStuck(
      message.includes('cancelled')
        ? "Audio wasn't restarted. Native Intelligence can't record until it is."
        : `Couldn't restart audio: ${message}`,
    )
  }
}
