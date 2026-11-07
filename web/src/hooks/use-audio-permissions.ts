'use client'

/**
 * Live, truthful status for the two macOS permissions a meeting capture needs
 * — Microphone (your side) and System Audio Recording, the "Audio Capture" TCC
 * service behind the Core Audio tap (everyone else). Without the second one a
 * meeting silently records mic-only.
 *
 * Why it polls: once either permission is denied, macOS never shows the prompt
 * again — the ONLY fix is a toggle in System Settings, which happens outside
 * the app and emits nothing we can listen to. So while the page is visible the
 * hook re-reads both PASSIVE checks every `pollMs`, and re-reads immediately
 * when the user comes back (window focus, visibilitychange → visible): a toggle
 * flipped in Settings shows up within ~1.5s with no click. The passive checks
 * can never prompt. The request commands run only from requestMic /
 * requestSystem — i.e. an explicit click — never on mount or on a timer.
 *
 * Honesty rules (the old UI said "Granted" whenever the legacy probe did,
 * which on older desktop builds was always):
 *  • What a row shows comes ONLY from a passive check. A request's answer is
 *    handed back to the caller (for copy / telemetry) and followed by a fresh
 *    check — it is never written into state on its own say-so.
 *  • A check that REJECTS means the desktop build predates the command (the
 *    web app ships ahead of the binary): that permission becomes 'unknown'
 *    ("can't verify on this version") and stops being polled — it would reject
 *    forever. An explicit refresh() still retries it.
 *  • Latest-wins: every check takes a ticket and only the newest one's answer
 *    lands, so a poll read that started before the user answered the OS prompt
 *    can't resolve late and flip the row back (the flicker the onboarding mic
 *    card had to special-case).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { tauriBridge } from '@/lib/tauri-bridge'

export type MicPermissionState = 'checking' | 'granted' | 'not-determined' | 'denied' | 'unknown'
export type SystemAudioPermissionState =
  | 'checking'
  | 'granted'
  | 'not-determined'
  | 'denied'
  | 'unsupported'
  | 'unknown'

export interface AudioPermissions {
  mic: MicPermissionState
  system: SystemAudioPermissionState
  micBusy: boolean
  systemBusy: boolean
  /** request_mic_permission, then a fresh passive check. Resolves with the
   *  command's answer, 'error' if it rejected, or 'busy' (nothing invoked) if a
   *  mic request is already in flight. */
  requestMic: () => Promise<string>
  /** request_system_audio_permission — or, on a build without it, the legacy
   *  probe — then a fresh passive check. Resolves like requestMic. */
  requestSystem: () => Promise<string>
  /** Re-read both passive checks now (never prompts). */
  refresh: () => Promise<void>
}

/** check_mic_permission → row state. 'restricted' (MDM / parental controls)
 *  reads as denied — it's fixed the same way. Anything unrecognised
 *  ('not_applicable' off macOS, a future string) is 'unknown', not a guess. */
export function toMicState(status: string): MicPermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'denied'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unknown'
  }
}

/** check_system_audio_permission → row state. 'unavailable' (the private TCC
 *  query is missing on this macOS) reads as not-determined: we can't see the
 *  status, but the request command still reaches the prompt or the Settings
 *  pane, so the row keeps offering Allow. 'unsupported' is macOS < 14.4 (no
 *  Core Audio taps at all). Anything unrecognised is 'unknown'. */
export function toSystemState(status: string): SystemAudioPermissionState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'not-determined':
    case 'unavailable':
      return 'not-determined'
    case 'unsupported':
      return 'unsupported'
    default:
      return 'unknown'
  }
}

/**
 * request_system_audio_permission, falling back to the legacy
 * request_screen_capture_permission probe when it rejects — which is what an
 * older desktop build does for a command it doesn't register ("Command … not
 * found"). Any rejection falls back: on a build that has the new command it
 * only rejects if the command itself failed, and the probe is truthful there.
 *
 * `legacy: true` marks an answer from the probe. On the builds that need the
 * fallback it can never observe a denial (the tap is created even with the
 * permission off and just records silence), so callers must not present its
 * "granted" as verified. Rejects only if both commands do.
 */
export async function requestSystemAudioWithFallback(): Promise<{ result: string; legacy: boolean }> {
  try {
    return { result: await tauriBridge.requestSystemAudioPermission(), legacy: false }
  } catch {
    return { result: await tauriBridge.requestScreenCapturePermission(), legacy: true }
  }
}

type Perm = 'mic' | 'system'
const PERMS: readonly Perm[] = ['mic', 'system']

// Looked up per call rather than captured at module load, so a method swapped
// on tauriBridge after import (vi.spyOn) is the one invoked — and a bridge
// without the method throws inside runCheck's try, landing on 'unknown'.
const PASSIVE_CHECK: Record<Perm, () => Promise<string>> = {
  mic: () => tauriBridge.checkMicPermission(),
  system: () => tauriBridge.checkSystemAudioPermission(),
}

export function useAudioPermissions(
  opts: { pollMs?: number; enabled?: boolean } = {},
): AudioPermissions {
  const { pollMs = 1500, enabled = true } = opts
  const [mic, setMic] = useState<MicPermissionState>('checking')
  const [system, setSystem] = useState<SystemAudioPermissionState>('checking')
  const [micBusy, setMicBusy] = useState(false)
  const [systemBusy, setSystemBusy] = useState(false)

  const mountedRef = useRef(false)
  // Latest-wins tickets, one counter per permission (see the header).
  const seqRef = useRef<Record<Perm, number>>({ mic: 0, system: 0 })
  // A poll skips a permission whose previous read hasn't settled instead of
  // stacking IPC calls behind a slow one. Post-request / refresh() reads
  // bypass this — their newer ticket supersedes whatever was in flight.
  const inFlightRef = useRef<Record<Perm, boolean>>({ mic: false, system: false })
  // The last read REJECTED: this build lacks the command → 'unknown', unpolled.
  const missingRef = useRef<Record<Perm, boolean>>({ mic: false, system: false })
  // Synchronous re-entry guard for the requests — the busy STATE only lands a
  // render later, too late to stop a second click in the same tick.
  const busyRef = useRef<Record<Perm, boolean>>({ mic: false, system: false })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runCheck = useCallback(async (perm: Perm): Promise<void> => {
    const ticket = ++seqRef.current[perm]
    inFlightRef.current[perm] = true
    const isLatest = () => ticket === seqRef.current[perm]
    try {
      const status = await PASSIVE_CHECK[perm]()
      if (!isLatest()) return
      missingRef.current[perm] = false
      if (!mountedRef.current) return
      if (perm === 'mic') setMic(toMicState(status))
      else setSystem(toSystemState(status))
    } catch {
      // Stale rejections are ignored: a newer read already answered.
      if (!isLatest()) return
      missingRef.current[perm] = true
      if (!mountedRef.current) return
      if (perm === 'mic') setMic('unknown')
      else setSystem('unknown')
    } finally {
      if (isLatest()) inFlightRef.current[perm] = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    const poll = () => {
      for (const perm of PERMS) {
        if (!missingRef.current[perm] && !inFlightRef.current[perm]) void runCheck(perm)
      }
    }
    // Seed right away, even on a hidden page: the reads are passive, and the
    // rows shouldn't sit on "Checking…" until the next visibility flip.
    poll()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') poll()
    }, pollMs)
    // Coming back from System Settings: re-read now, not up to pollMs later.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', poll)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', poll)
    }
  }, [enabled, pollMs, runCheck])

  const requestMic = useCallback(async (): Promise<string> => {
    if (busyRef.current.mic) return 'busy'
    busyRef.current.mic = true
    setMicBusy(true)
    let result: string
    try {
      // not-determined → the real OS prompt (resolves once answered);
      // denied → macOS never re-prompts, so the command opens the Settings
      // mic pane and the poll picks up the toggle.
      result = await tauriBridge.requestMicPermission()
    } catch {
      result = 'error'
    }
    // Stay busy through the re-read so the button doesn't flash back to
    // "Allow" before the fresh status lands.
    await runCheck('mic')
    busyRef.current.mic = false
    if (mountedRef.current) setMicBusy(false)
    return result
  }, [runCheck])

  const requestSystem = useCallback(async (): Promise<string> => {
    if (busyRef.current.system) return 'busy'
    busyRef.current.system = true
    setSystemBusy(true)
    let result: string
    try {
      // On an old build this is the legacy probe (see the helper), whose
      // "granted" can't be trusted there. The row doesn't need to care: it
      // follows the passive check below, which on such a build keeps it at
      // 'unknown' whatever the probe said.
      result = (await requestSystemAudioWithFallback()).result
    } catch {
      result = 'error'
    }
    await runCheck('system')
    busyRef.current.system = false
    if (mountedRef.current) setSystemBusy(false)
    return result
  }, [runCheck])

  const refresh = useCallback(async () => {
    await Promise.all(PERMS.map((perm) => runCheck(perm)))
  }, [runCheck])

  return { mic, system, micBusy, systemBusy, requestMic, requestSystem, refresh }
}
