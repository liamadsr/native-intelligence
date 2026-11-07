/**
 * Quiet: no alert sounds while the mic records the user or a capture records a
 * meeting. Page-played audio is not in the desktop's echo-cancellation
 * reference, so a chime then would land in the dictation, the voice-mode turn,
 * the Voice ID voiceprint or the meeting recording.
 *
 * Every window must know, not just the one holding the mic: the window that
 * wins an alert's dedupe claim may be another one, or one opened since. So
 * `holdSoundQuiet(reason)` counts here AND holds a Web Lock under
 * QUIET_LOCK_PREFIX, which every window can see (`isLockHeld`), whenever it
 * was opened. The holders:
 *  - the mic guard, for every read-aloud hold (dictation, Voice ID enrollment);
 *  - voice mode, for a live session (use-voice-mode);
 *  - the recording provider, for a capture.
 */

import { useEffect } from 'react'
import { holdLock, isLockHeld, windowId } from './cross-window'

export const QUIET_LOCK_PREFIX = 'dial8-sound:quiet:'

let localHolds = 0
let holdSeq = 0

/** Keep alert sounds quiet, in every window, until the release runs. */
export function holdSoundQuiet(reason: string): () => void {
  localHolds++
  const releaseLock = holdLock(`${QUIET_LOCK_PREFIX}${reason}:${windowId()}:${++holdSeq}`)
  let released = false
  return () => {
    if (released) return
    released = true
    localHolds--
    releaseLock()
  }
}

/** A quiet hold while `active` is true. */
export function useSoundQuietWhile(active: boolean, reason: string): void {
  useEffect(() => {
    if (!active) return
    return holdSoundQuiet(reason)
  }, [active, reason])
}

/** Is the mic live, or a capture recording, in any window? Never rejects. */
export async function isSoundQuiet(): Promise<boolean> {
  if (localHolds > 0) return true
  return isLockHeld(QUIET_LOCK_PREFIX)
}

/** Tests only. */
export function __resetSoundQuietForTests(): void {
  localHolds = 0
}
