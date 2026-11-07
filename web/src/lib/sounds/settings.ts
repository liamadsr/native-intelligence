/**
 * The "Sound effects" setting — device-local, like read-aloud's and voice
 * mode's (../read-aloud/settings, ../voice/settings).
 *
 * One tiny localStorage key, written only when it differs from the default:
 *   dial8:sounds:effects  "0" when sound effects are off (absent = on)
 * Every access is wrapped: storage that throws or is full reads as the default.
 * Every window of the app shares it (same origin), and a change in one window
 * reaches the others' toggles through the `storage` event.
 */

import { useSyncExternalStore } from 'react'

export const SOUND_EFFECTS_KEY = 'dial8:sounds:effects'

const listeners = new Set<() => void>()

function notify() {
  for (const listener of [...listeners]) listener()
}

function read(): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(SOUND_EFFECTS_KEY)
  } catch {
    return null
  }
}

/** UI sounds play. On by default. */
export function getSoundEffectsEnabled(): boolean {
  return read() !== '0'
}

export function setSoundEffectsEnabled(on: boolean): void {
  try {
    if (typeof window !== 'undefined') {
      if (on) window.localStorage.removeItem(SOUND_EFFECTS_KEY)
      else window.localStorage.setItem(SOUND_EFFECTS_KEY, '0')
    }
  } catch {
    // Quota or privacy mode: the setting just doesn't stick on this device.
  }
  notify()
}

function onStorage(e: StorageEvent) {
  if (e.key === SOUND_EFFECTS_KEY || e.key === null) notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** The setting, live (this window's changes and other windows'). */
export function useSoundEffectsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSoundEffectsEnabled, () => true)
}
