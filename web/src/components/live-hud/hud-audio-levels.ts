/**
 * The call's audio level, for the HUD chat box's glow
 * (components/live-chat/call-glow.tsx). Each host hands the HUD one:
 *   - web (./web-hud.tsx): the recording context's own level store, the one
 *     the capture's waveform reads (the browser capture's mic, ~10 Hz);
 *   - desktop (app/hud/agent): the native capture's `audio-level` event,
 *     which Rust broadcasts to every window (~10 Hz, audio/session.rs), so the
 *     HUD window hears it directly: no relay through the recording window.
 *
 * A source is a getter plus a subscription: the glow samples the getter each
 * frame without re-rendering, and listens only to learn whether audio is
 * flowing. Nothing listens while nobody subscribes.
 */
import { CAPTURE_LEVEL_GAIN } from '@/app/account/(dashboard)/chat/composer-voice-glow'

export interface HudAudioLevels {
  /** The level now, 0–1, gained the way the main composer's glow was (raw RMS × CAPTURE_LEVEL_GAIN). */
  get: () => number
  /** Called on each new level; returns the unsubscribe. */
  subscribe: (onLevel: () => void) => () => void
}

/** A capture's raw RMS levels as the glow's 0–1: the louder of mic and system, gained. */
export function gainedCaptureLevel(levels: { micLevel: number; systemLevel: number } | null | undefined): number {
  if (!levels) return 0
  const mic = Number.isFinite(levels.micLevel) ? levels.micLevel : 0
  const system = Number.isFinite(levels.systemLevel) ? levels.systemLevel : 0
  return Math.min(1, Math.max(0, Math.max(mic, system) * CAPTURE_LEVEL_GAIN))
}

/** A level event's payload (`audio-level`: { micLevel, systemLevel, timestamp }), or null. */
export function readAudioLevelPayload(payload: unknown): { micLevel: number; systemLevel: number } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { micLevel?: unknown; systemLevel?: unknown }
  if (typeof p.micLevel !== 'number' && typeof p.systemLevel !== 'number') return null
  return {
    micLevel: typeof p.micLevel === 'number' ? p.micLevel : 0,
    systemLevel: typeof p.systemLevel === 'number' ? p.systemLevel : 0,
  }
}

/**
 * A source fed by something you attach on demand (the desktop's Tauri event):
 * `attach(push)` starts listening and returns the stop. Attached on the first
 * subscriber, stopped with the last, and the level drops to 0 then, so a
 * stale reading never lights the next call.
 */
export function createAttachedLevels(
  attach: (push: (levels: { micLevel: number; systemLevel: number }) => void) => () => void,
): HudAudioLevels {
  let level = 0
  let stop: (() => void) | null = null
  const listeners = new Set<() => void>()
  const push = (levels: { micLevel: number; systemLevel: number }) => {
    level = gainedCaptureLevel(levels)
    for (const listener of [...listeners]) listener()
  }
  return {
    get: () => level,
    subscribe: (onLevel) => {
      listeners.add(onLevel)
      if (!stop) stop = attach(push)
      return () => {
        listeners.delete(onLevel)
        if (listeners.size === 0 && stop) {
          const s = stop
          stop = null
          level = 0
          s()
        }
      }
    },
  }
}
