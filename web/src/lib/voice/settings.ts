/**
 * Voice mode settings — device-local, like read-aloud's (../read-aloud/settings).
 *
 * Tiny localStorage keys, written only when they differ from the default:
 *   dial8:voice:pause     "short" | "normal" (absent = long, 1.2 s): how long a pause
 *                         ends the user's turn (voice_start's endSilenceMs)
 *   dial8:voice:focus     "on" (absent = off): Voice focus, only the user and
 *                         voices Dial8 recognises are answered (./voice-focus)
 * Every access is wrapped: storage that throws or is full reads as defaults.
 *
 * There is no background-noise setting: every session asks for the quiet room
 * (VOICE_NOISE_PROFILE). A `dial8:voice:noise` left by an older build is not
 * read.
 * The voice itself is read-aloud's (dial8:read-aloud:voice).
 */

import type { VoiceNoiseProfile } from '@/lib/tauri-bridge'

export const VOICE_PAUSE_KEY = 'dial8:voice:pause'
export const VOICE_FOCUS_KEY = 'dial8:voice:focus'

export type VoicePause = 'short' | 'normal' | 'long'

/** The silence (ms) that ends a turn, per setting (docs/plans/chat-voice.md §3.1). */
export const VOICE_PAUSE_MS: Record<VoicePause, number> = { short: 500, normal: 700, long: 1200 }

/** Long by default: 0.7 s cut people off mid-thought (Liam, 2026-09-26). */
export const DEFAULT_VOICE_PAUSE: VoicePause = 'long'

export const VOICE_PAUSE_OPTIONS: ReadonlyArray<{ value: VoicePause; label: string }> = [
  { value: 'short', label: 'Short (0.5 s)' },
  { value: 'normal', label: 'Normal (0.7 s)' },
  { value: 'long', label: 'Long (1.2 s)' },
]

/**
 * Every voice session (voice mode, Interactive, dictation) asks for the quiet
 * room: the desktop hears a turn by speech alone, never by how loud it is.
 *
 * The level-gated rooms (auto, noisy) judged each sound against a learned
 * level of the user's voice. That level learned only from the turns that got
 * through, so it only climbed: a user who had to raise their voice raised it
 * further, and a normal-volume user was shut out until they yelled (Liam,
 * 2026-10-08). Other voices in the room are no longer told apart by loudness.
 */
export const VOICE_NOISE_PROFILE: VoiceNoiseProfile = 'quiet'

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

export function getVoicePause(): VoicePause {
  const v = read(VOICE_PAUSE_KEY)
  return v === 'short' || v === 'normal' || v === 'long' ? v : DEFAULT_VOICE_PAUSE
}

export function setVoicePause(pause: VoicePause): void {
  write(VOICE_PAUSE_KEY, pause === DEFAULT_VOICE_PAUSE ? null : pause)
}

/** Voice focus: turns in a voice Dial8 doesn't know are ignored (voice mode
 *  and Interactive; never dictation). Off by default; read at each turn, so
 *  a change applies to a session already running. */
export function getVoiceFocus(): boolean {
  return read(VOICE_FOCUS_KEY) === 'on'
}

export function setVoiceFocus(on: boolean): void {
  write(VOICE_FOCUS_KEY, on ? 'on' : null)
}

/** What voice mode's voice_start takes from these settings. Talking over the
 *  agent always stops it (Liam, 2026-09-26: not a setting), so bargeIn is
 *  always on. (Dictation sends the same noiseProfile: VOICE_NOISE_PROFILE.) */
export function voiceStartOptions(): { endSilenceMs: number; bargeIn: boolean; noiseProfile: VoiceNoiseProfile } {
  return { endSilenceMs: VOICE_PAUSE_MS[getVoicePause()], bargeIn: true, noiseProfile: VOICE_NOISE_PROFILE }
}

/** What Interactive mode's voice_start takes from these settings: the same
 *  pause and room as voice mode. No bargeIn: an interactive session starts
 *  with the barge policy `wake`, and Interactive mode moves it with
 *  voice_set_barge (components/read-aloud/interactive-voice-host.tsx). */
export function interactiveStartOptions(): { endSilenceMs: number; noiseProfile: VoiceNoiseProfile } {
  return { endSilenceMs: VOICE_PAUSE_MS[getVoicePause()], noiseProfile: VOICE_NOISE_PROFILE }
}
