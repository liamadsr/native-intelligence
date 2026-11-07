'use client'

import { useEffect } from 'react'

/**
 * Poll fallback for the flagship live-notes surface (capture detail panel).
 *
 * INCIDENT: Realtime carries live proposals + summary during a recording, but
 * the desktop WKWebView's websocket can die silently on sleep and never recover,
 * freezing the notes mid-meeting while the app looks healthy. While a capture is
 * ACTIVELY recording, this polls as defense-in-depth so a dead socket can't
 * strand the live notes. The global watchdog (realtime-recovery.ts) independently
 * repairs the socket; this is the per-surface belt to its suspenders.
 *
 * `onTick` receives `deliveryDown` — whether live delivery for the caller's
 * surface is currently down — so the caller can decide whether it's safe to
 * mirror the polled summary into the editor (only when delivery is DOWN;
 * otherwise a poll racing an in-flight reveal animation, driven by the live
 * realtime UPDATE, would cancel it and snap the text).
 *
 * The liveness signal is supplied by the caller via `isDeliveryDown` rather than
 * computed here: the hook stays generic (it knows nothing about sockets or
 * channels), and the caller can fold in surface-specific liveness — e.g. its own
 * capture-stream channel's join state, not just the shared socket's connectivity
 * (a socket can be repaired while a specific channel is still dead).
 *
 * Convention (matches agent-run-detail.tsx): a plain interval gated on the
 * `active` liveness boolean, cleared on cleanup. No polling when not active.
 */
export function useRecordingPollFallback(
  active: boolean,
  onTick: (opts: { deliveryDown: boolean }) => void,
  isDeliveryDown: () => boolean,
  intervalMs = 25_000,
) {
  useEffect(() => {
    if (!active) return
    const tick = () => {
      let deliveryDown = false
      try {
        deliveryDown = isDeliveryDown()
      } catch {
        // If liveness can't be read, treat delivery as down (safe: prefer a
        // snap-in catch-up over silently stranding the notes).
        deliveryDown = true
      }
      onTick({ deliveryDown })
    }
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
    // onTick + isDeliveryDown are memoized by the caller per captureId, so
    // including them costs nothing and removes a stale-closure trap.
  }, [active, intervalMs, onTick, isDeliveryDown])
}
