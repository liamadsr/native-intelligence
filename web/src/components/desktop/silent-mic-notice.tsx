'use client'

/**
 * The mic in use sends nothing: the desktop's `audio://input-silent` says its
 * stream has carried pure digital silence for 3 s (a hardware mute switch, a
 * muted interface, a dead virtual device), and again when sound is back. One
 * toast per episode, while something is listening (a capture, voice mode or a
 * bot bubble's talk, Interactive, dictation or Voice ID enrollment): an
 * episode that began before the listening is told once it starts. Mounted once
 * for the app in the dashboard shell, next to Interactive's host. Desktop
 * only; a desktop without the event never calls back. Renders nothing.
 */

import { useEffect, useMemo, useRef } from 'react'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { isDesktopApp } from '@/lib/platform'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { tauriBridge, type InputSilentEvent } from '@/lib/tauri-bridge'
import { useInteractiveVoice } from '@/lib/voice/interactive-store'
import { voiceToast } from '@/lib/voice/messages'
import { useVoiceSessionHeld } from '@/lib/voice/session-claim'

/** The toast's words. */
export function silentMicMessage(name: string): string {
  const mic = name.trim() || 'Your microphone'
  return `${mic} isn’t sending any sound. Check it isn’t muted, or pick another mic.`
}

export interface SilentMicNotifier {
  /** One `audio://input-silent`. */
  onEvent: (event: InputSilentEvent) => void
  /** Something started listening: an episode not yet told is told now. */
  activeChanged: () => void
}

/** The episodes: a device going silent opens one (another device's replaces
 *  it), sound from it closes it; each is told at most once, and only while
 *  `isActive()`. */
export function createSilentMicNotifier(opts: {
  isActive: () => boolean
  notify: (name: string) => void
}): SilentMicNotifier {
  let episode: { key: string; name: string; told: boolean } | null = null
  const keyOf = (e: InputSilentEvent) => e.deviceId ?? `name:${e.name}`
  const tell = () => {
    if (!episode || episode.told || !opts.isActive()) return
    episode.told = true
    opts.notify(episode.name)
  }
  return {
    onEvent: (e) => {
      const key = keyOf(e)
      if (!e.silent) {
        // Sound again (an unnamed device's recovery closes whatever is open).
        if (episode && (episode.key === key || e.deviceId === null)) episode = null
        return
      }
      if (episode?.key !== key) episode = { key, name: e.name, told: false }
      tell()
    },
    activeChanged: tell,
  }
}

export function SilentMicNotice() {
  if (!isDesktopApp()) return null
  return <Notice />
}

function Notice() {
  const recording = useOptionalRecordingStable()
  const capturing = !!(recording?.isRecording || recording?.isStarting)
  const conversation = useVoiceSessionHeld()
  const { phase } = useInteractiveVoice()
  // Dictation and Voice ID enrollment hold read-aloud while they listen.
  const held = useReadAloudHeld()
  const active = capturing || conversation || phase !== 'off' || held
  const activeRef = useRef(active)
  activeRef.current = active

  const notifier = useMemo(
    () =>
      createSilentMicNotifier({
        isActive: () => activeRef.current,
        notify: (name) => voiceToast(silentMicMessage(name)),
      }),
    [],
  )

  useEffect(() => tauriBridge.onInputSilent((event) => notifier.onEvent(event)), [notifier])

  useEffect(() => {
    if (active) notifier.activeChanged()
  }, [active, notifier])

  return null
}
