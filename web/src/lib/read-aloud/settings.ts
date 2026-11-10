/**
 * Read-aloud settings — device-local, like the local-tts module itself.
 *
 * Two tiny localStorage keys, written only when they differ from the default
 * (a full storage bucket has bitten this app before, so nothing here grows):
 *   ni:read-aloud:auto   "1" when auto-read is on (absent = off)
 *   ni:read-aloud:voice  a voice id (absent = the catalogue default)
 * Every access is wrapped: storage that throws or is full reads as defaults.
 */

export const READ_ALOUD_AUTO_KEY = 'ni:read-aloud:auto'
export const READ_ALOUD_VOICE_KEY = 'ni:read-aloud:voice'

function read(key: string): string | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (typeof window === 'undefined') return
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Quota or privacy mode: the setting just doesn't stick on this device.
  }
}

/** Speak each reply as it streams. Off by default. */
export function getReadAloudAuto(): boolean {
  return read(READ_ALOUD_AUTO_KEY) === '1'
}

export function setReadAloudAuto(on: boolean): void {
  write(READ_ALOUD_AUTO_KEY, on ? '1' : null)
}

/** The chosen voice id, or null for the desktop's default voice. */
export function getReadAloudVoice(): string | null {
  const id = read(READ_ALOUD_VOICE_KEY)
  return id && id.length <= 64 ? id : null
}

/** Pass null (or the catalogue default's id) to fall back to the default. */
export function setReadAloudVoice(id: string | null): void {
  write(READ_ALOUD_VOICE_KEY, id && id.length <= 64 ? id : null)
}
