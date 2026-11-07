'use client'

/**
 * The desktop's input-device priority list (the chat composer's mic picker):
 * load it, follow `audio://input-devices-changed`, and write order changes
 * optimistically.
 *
 * - `status: 'unsupported'` when `list()` rejects — a desktop without the
 *   commands (0.2.45) or the browser. The picker renders nothing.
 * - `enabled: false` (the chat composer while it shows no voice control):
 *   no call, no subscription, `unsupported` until it turns true.
 * - Setters apply locally first and revert when the desktop refuses.
 * - `setOverride` ("use this mic for now") never reorders. On a desktop
 *   without `set_input_override` it answers 'unsupported' (the caller falls
 *   back to moving the mic to #1), and every later call answers that at once
 *   for the rest of the session, without asking.
 * - Live events are held while a drag is in progress or a write is in flight
 *   (an event from before the write would flash the old order back). A held
 *   event is applied when the drag ends with no write, or when a write fails;
 *   a successful write's own answer supersedes it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopApp } from '@/lib/platform'
import {
  InputDevicesCommandMissingError,
  tauriBridge,
  type InputDevice,
  type InputDevicesSnapshot,
} from '@/lib/tauri-bridge'

export type InputDevicesStatus = 'loading' | 'ready' | 'unsupported'

/** How a setOverride went: done, refused (reverted), or this desktop has no
 *  `set_input_override` (nothing changed). */
export type InputOverrideResult = 'ok' | 'refused' | 'unsupported'

// Once set_input_override is found missing, it stays missing for the rest of
// the session (the desktop doesn't change under a loaded page).
let overrideUnsupported = false

export function __resetInputOverrideSupportForTests(): void {
  overrideUnsupported = false
}

export interface UseInputDevices {
  status: InputDevicesStatus
  snapshot: InputDevicesSnapshot | null
  /** Save `ids` (highest first) as the order. Resolves false when refused. */
  setPriority: (ids: string[]) => Promise<boolean>
  /** Use `id` for now without changing the order; null goes back to the
   *  order. Never saved. */
  setOverride: (id: string | null) => Promise<InputOverrideResult>
  /** Back to the Mac's default input. Resolves false when refused. */
  reset: () => Promise<boolean>
  /** Drop a disconnected device. Resolves false when refused. */
  forget: (id: string) => Promise<boolean>
  /** Hold live events while true; apply the latest one when it goes false. */
  setDragging: (dragging: boolean) => void
}

/** `snap` reordered to `ids` (unknown ids ignored, the rest kept after them,
 *  as the desktop does) and marked customised. */
export function applyPriority(snap: InputDevicesSnapshot, ids: string[]): InputDevicesSnapshot {
  const byId = new Map(snap.devices.map((d) => [d.id, d]))
  const picked = new Set<string>()
  const devices = []
  for (const id of ids) {
    const d = byId.get(id)
    if (d && !picked.has(id)) {
      picked.add(id)
      devices.push(d)
    }
  }
  for (const d of snap.devices) if (!picked.has(d.id)) devices.push(d)
  return { ...snap, customised: true, devices }
}

/** The mic the saved order picks, ignoring any override: the highest
 *  usable one when customised, else the Mac's default input (a MacBook's
 *  mic with the lid shut is skipped, as the desktop skips it). */
export function priorityPick(snap: InputDevicesSnapshot): InputDevice | null {
  if (snap.customised) return snap.devices.find(usable) ?? null
  return snap.devices.find((d) => d.isDefault && usable(d)) ?? snap.devices.find(usable) ?? null
}

/** Connected and able to hear (not a MacBook's mic with the lid shut). */
export function usable(d: InputDevice): boolean {
  return d.available && !d.unavailableReason
}

/** `snap` with `id` in use for now (null, or a mic that isn't usable: back
 *  to the order's pick). The order is untouched; a running stream moves with
 *  the check, as the desktop switches it live. */
export function applyOverride(snap: InputDevicesSnapshot, id: string | null): InputDevicesSnapshot {
  const target = id ? (snap.devices.find((d) => d.id === id && usable(d)) ?? null) : null
  const inUse = target ?? priorityPick(snap)
  const streaming = snap.devices.some((d) => d.live)
  return {
    ...snap,
    overrideId: target?.id ?? null,
    devices: snap.devices.map((d) => {
      const active = d.id === inUse?.id
      return { ...d, active, live: active && streaming }
    }),
  }
}

export function useInputDevices({ enabled = true }: { enabled?: boolean } = {}): UseInputDevices {
  const [status, setStatus] = useState<InputDevicesStatus>('loading')
  const [snapshot, setSnapshotState] = useState<InputDevicesSnapshot | null>(null)

  // Mirrors for async callbacks.
  const snapshotRef = useRef<InputDevicesSnapshot | null>(null)
  const draggingRef = useRef(false)
  const pendingRef = useRef(0)
  const heldRef = useRef<InputDevicesSnapshot | null>(null)
  // Bumped per write, so an older write's answer never lands over a newer one.
  const opSeqRef = useRef(0)
  const mountedRef = useRef(true)

  const commit = useCallback((snap: InputDevicesSnapshot) => {
    snapshotRef.current = snap
    if (mountedRef.current) setSnapshotState(snap)
  }, [])

  const flushHeld = useCallback(() => {
    const held = heldRef.current
    heldRef.current = null
    if (held) commit(held)
  }, [commit])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled || !isDesktopApp()) {
      setStatus('unsupported')
      return () => { mountedRef.current = false }
    }
    setStatus('loading')
    let cancelled = false
    let gotEvent = false
    const off = tauriBridge.inputDevices.onChanged((snap) => {
      if (cancelled) return
      gotEvent = true
      if (draggingRef.current || pendingRef.current > 0) {
        heldRef.current = snap
        return
      }
      commit(snap)
      setStatus('ready')
    })
    Promise.resolve()
      .then(() => tauriBridge.inputDevices.list())
      .then((snap) => {
        if (cancelled) return
        // An event that arrived first is at least as new as this answer.
        if (!gotEvent) commit(snap)
        setStatus('ready')
      })
      .catch(() => {
        if (cancelled) return
        // No device priority on this desktop build: hide the section.
        off()
        setStatus('unsupported')
      })
    return () => {
      cancelled = true
      mountedRef.current = false
      off()
    }
  }, [commit, enabled])

  /** Run one write: apply `optimistic`, then the desktop's answer (or revert).
   *  Resolves the refusal, or null when it went through. */
  const run = useCallback(
    async (
      optimistic: InputDevicesSnapshot | null,
      call: () => Promise<InputDevicesSnapshot>,
    ): Promise<{ refused: unknown } | null> => {
      const before = snapshotRef.current
      const seq = ++opSeqRef.current
      pendingRef.current++
      if (optimistic) commit(optimistic)
      try {
        const answer = await call()
        if (seq === opSeqRef.current) {
          // The answer is at least as new as anything held during the write.
          heldRef.current = null
          if (!draggingRef.current) commit(answer)
          else heldRef.current = answer
        }
        return null
      } catch (e) {
        console.warn('[input-devices] write refused:', e)
        if (seq === opSeqRef.current) {
          if (before) commit(before)
          if (!draggingRef.current) flushHeld()
        }
        return { refused: e }
      } finally {
        pendingRef.current--
      }
    },
    [commit, flushHeld],
  )

  const write = useCallback(
    async (optimistic: InputDevicesSnapshot | null, call: () => Promise<InputDevicesSnapshot>) =>
      (await run(optimistic, call)) === null,
    [run],
  )

  const setPriority = useCallback(
    (ids: string[]) => {
      const cur = snapshotRef.current
      return write(cur ? applyPriority(cur, ids) : null, () => tauriBridge.inputDevices.setPriority(ids))
    },
    [write],
  )

  const setOverride = useCallback(
    async (id: string | null): Promise<InputOverrideResult> => {
      if (overrideUnsupported) return 'unsupported'
      const cur = snapshotRef.current
      const outcome = await run(cur ? applyOverride(cur, id) : null, () => tauriBridge.inputDevices.setOverride(id))
      if (!outcome) return 'ok'
      if (outcome.refused instanceof InputDevicesCommandMissingError) {
        overrideUnsupported = true
        return 'unsupported'
      }
      return 'refused'
    },
    [run],
  )

  const reset = useCallback(() => {
    const cur = snapshotRef.current
    return write(cur ? { ...cur, customised: false } : null, () => tauriBridge.inputDevices.reset())
  }, [write])

  const forget = useCallback(
    (id: string) => {
      const cur = snapshotRef.current
      return write(
        cur ? { ...cur, devices: cur.devices.filter((d) => d.id !== id) } : null,
        () => tauriBridge.inputDevices.forget(id),
      )
    },
    [write],
  )

  const setDragging = useCallback(
    (dragging: boolean) => {
      draggingRef.current = dragging
      if (!dragging && pendingRef.current === 0) flushHeld()
    },
    [flushHeld],
  )

  return { status, snapshot, setPriority, setOverride, reset, forget, setDragging }
}
