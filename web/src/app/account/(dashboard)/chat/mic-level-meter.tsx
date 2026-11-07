'use client'

/**
 * The mic picker's header: a mic icon and a thin live input-level bar, for as
 * long as the picker is open (it unmounts with the popover).
 *
 * Where the level comes from:
 *  - Voice mode on in this panel: its own mic level (the desktop has the mic).
 *  - Another voice session or a meeting capture has the mic (`busy`): nothing
 *    is opened; the bar sits idle.
 *  - Otherwise: getUserMedia in the webview on the desktop's active device,
 *    matched by enumerateDevices() label as Voice ID enrollment does (see
 *    desktop-mic-device.ts), else the default. Echo cancellation, noise
 *    suppression and auto gain are off, so opening it neither ducks the Mac's
 *    other audio nor evens the level out. Every track is stopped and the
 *    AudioContext closed on unmount, and whenever the source changes.
 *
 * If the webview mic can't be opened the bar hides quietly ("Microphone"
 * shows in its place).
 */

import { useEffect, useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { matchInputDeviceId } from '@/lib/desktop-mic-device'
import type { VoiceLiveStore } from '@/hooks/use-voice-mode'

/** dBFS at the bar's empty and full ends: a quiet room reads near empty,
 *  normal speech on a built-in mic about 60–80%. */
const FLOOR_DB = -55
const CEILING_DB = -12

/** Linear RMS (0..1) → the bar's fill (0..1), on a dB scale. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)))
}

/** Rises almost at once, falls back over ~¼ s. */
const ATTACK = 0.6
const DECAY_MS = 220

export function smoothLevel(shown: number, target: number, dtMs: number): number {
  if (target >= shown) return shown + (target - shown) * ATTACK
  return shown + (target - shown) * (1 - Math.exp(-dtMs / DECAY_MS))
}

type MeterSource = 'voice' | 'idle' | 'webview'

/** Open the webview mic on `deviceName` (matched by label), else the default.
 *  WebKit hides labels until the document has been granted a mic, so a miss
 *  on hidden labels opens the default, looks again, and moves if it differs. */
async function openMeterStream(deviceName: string | null, isCancelled: () => boolean): Promise<MediaStream> {
  const md = navigator.mediaDevices
  if (!md?.getUserMedia) throw new Error('no getUserMedia')
  const open = (deviceId?: string) =>
    md.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  const openOrDefault = (deviceId: string) => open(deviceId).catch(() => open())
  const lookup = async (): Promise<{ id: string | undefined; labelsHidden: boolean }> => {
    if (!deviceName || !md.enumerateDevices) return { id: undefined, labelsHidden: false }
    try {
      const inputs = await md.enumerateDevices()
      return {
        id: matchInputDeviceId(deviceName, inputs),
        labelsHidden: !inputs.some((d) => d.kind === 'audioinput' && d.label),
      }
    } catch {
      return { id: undefined, labelsHidden: false }
    }
  }
  const stop = (s: MediaStream) => s.getTracks().forEach((t) => t.stop())

  const first = await lookup()
  if (first.id) return openOrDefault(first.id)
  const stream = await open()
  if (!first.labelsHidden || isCancelled()) return stream
  const again = await lookup()
  const openId = stream.getAudioTracks()[0]?.getSettings?.().deviceId
  if (!again.id || again.id === openId || isCancelled()) return stream
  stop(stream)
  return openOrDefault(again.id)
}

export function MicLevelMeter({
  deviceName,
  busy,
  voiceLive,
}: {
  /** The desktop's active (connected) device, or null. */
  deviceName: string | null
  /** Another voice session or a meeting capture has the mic. */
  busy: boolean
  /** Voice mode's live store while it runs in this panel. */
  voiceLive: VoiceLiveStore | null
}) {
  const source: MeterSource = voiceLive ? 'voice' : busy ? 'idle' : 'webview'
  const fillRef = useRef<HTMLDivElement>(null)
  // The device the webview mic wouldn't open on ('' = the default).
  const [failedOn, setFailedOn] = useState<string | null>(null)
  const failed = failedOn === (deviceName ?? '')

  useEffect(() => {
    const paint = (v: number) => {
      const fill = fillRef.current
      // Width, not a scaleX transform: the fill always grows from the left
      // edge, like a volume scale (Liam, 2026-09-26: it read as centre-out).
      if (fill) fill.style.width = `${Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10}%`
    }
    paint(0)
    if (source === 'idle') return

    let cancelled = false
    let raf = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    const hasRaf = typeof requestAnimationFrame === 'function'

    const run = (read: () => number) => {
      if (!hasRaf) return
      let shown = 0
      let last = performance.now()
      const frame = (now: number) => {
        const dt = Math.min(100, Math.max(0, now - last))
        last = now
        shown = smoothLevel(shown, read(), dt)
        paint(shown)
        raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    }

    if (source === 'voice' && voiceLive) {
      run(() => levelFromRms(voiceLive.get().mic))
    } else {
      void openMeterStream(deviceName, () => cancelled)
        .then((s) => {
          if (cancelled) {
            s.getTracks().forEach((t) => t.stop())
            return
          }
          stream = s
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          if (!Ctor) throw new Error('no AudioContext')
          ctx = new Ctor()
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 1024
          ctx.createMediaStreamSource(s).connect(analyser)
          void ctx.resume?.().catch(() => {})
          const buf = new Float32Array(analyser.fftSize)
          setFailedOn(null)
          run(() => {
            analyser.getFloatTimeDomainData(buf)
            let sum = 0
            for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
            return levelFromRms(Math.sqrt(sum / buf.length))
          })
        })
        .catch(() => {
          stream?.getTracks().forEach((t) => t.stop())
          stream = null
          void ctx?.close().catch(() => {})
          ctx = null
          if (!cancelled) setFailedOn(deviceName ?? '')
        })
    }

    return () => {
      cancelled = true
      if (hasRaf) cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      stream = null
      void ctx?.close().catch(() => {})
      ctx = null
    }
  }, [source, deviceName, voiceLive])

  const showBar = source !== 'webview' || !failed
  return (
    <div
      className="flex items-center gap-2.5 px-2.5 pb-2 pt-1.5"
      data-testid="mic-level"
      data-source={source}
      data-failed={failed ? 'true' : undefined}
    >
      <Mic className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      {showBar ? (
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden data-testid="mic-level-bar">
          <div
            ref={fillRef}
            className="h-full rounded-full bg-blue-500"
            style={{ width: '0%' }}
          />
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">Microphone</span>
      )}
    </div>
  )
}
