/**
 * Read-aloud off while the mic records the user's own voice: Voice ID
 * enrollment (speech played then would be captured into the voiceprint) and
 * chat dictation (it would be transcribed into the composer).
 *
 * `holdReadAloud()` silences the desktop now and keeps every read-aloud
 * surface (chat panels, auto-read, the Settings preview) off until the
 * returned release is called. Holds nest; the last release lifts the pause.
 *
 * A hold also claims the mic unless `{ mic: false }`: Voice ID enrollment
 * does (the chat voice controls render disabled, see useVoiceAvailability);
 * dictation doesn't, since it is the one using the mic.
 *
 * Every hold also keeps alert sounds quiet (../sounds/quiet), across windows:
 * a chime would land in the recording for the same reason speech would.
 */

import { useSyncExternalStore } from 'react'
import { speechOutput } from '@/lib/speech-output'
import { holdSoundQuiet } from '@/lib/sounds/quiet'

let holds = 0
let micHolds = 0
const listeners = new Set<() => void>()

function notify() {
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Pause read-aloud (and stop what is playing). Returns the release. */
export function holdReadAloud({ mic = true }: { mic?: boolean } = {}): () => void {
  holds++
  if (mic) micHolds++
  void speechOutput.cancel()
  // The same reason keeps alert sounds out of the mic, in every window.
  const releaseSoundQuiet = holdSoundQuiet(mic ? 'mic-hold' : 'dictation')
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
    if (mic) micHolds--
    releaseSoundQuiet()
    notify()
  }
}

export function isReadAloudHeld(): boolean {
  return holds > 0
}

/** True while something holds read-aloud off. */
export function useReadAloudHeld(): boolean {
  return useSyncExternalStore(subscribe, isReadAloudHeld, () => false)
}

/** A hold that also claims the mic (Voice ID enrollment) is in place. */
export function isMicHeld(): boolean {
  return micHolds > 0
}

/** True while a hold claims the mic (not dictation's own hold). */
export function useMicHeld(): boolean {
  return useSyncExternalStore(subscribe, isMicHeld, () => false)
}
