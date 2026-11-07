'use client'

import { useCallback, useEffect, useState } from 'react'
import type { VoiceProfileStatus } from '@/lib/voice-profile/types'

/**
 * Shared voice-profile status. Fetches GET /api/account/voice-profile and caches
 * the result at module scope so multiple consumers (dashboard nudge card,
 * settings view) share one hydrate. Re-fetches on window focus so completing
 * enrollment in the flow (or another tab) updates every consumer without a
 * reload.
 *
 * Tolerant by design: 401 (signed out) and network errors leave `status` at
 * null — never throws into render.
 */

interface VoiceProfileState {
  status: VoiceProfileStatus | null
  loading: boolean
  /** Force a re-fetch (e.g. after enrollment / removal). */
  refresh: () => void
}

let cache: VoiceProfileStatus | null = null
let hasFetched = false
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => fn())
}

function fetchStatus(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = fetch('/api/account/voice-profile')
    .then((r) => (r.ok ? r.json() : null))
    .then((data: VoiceProfileStatus | null) => {
      // Non-OK (401, 5xx) → data is null → leave status unset rather than throw.
      cache = data ?? null
      hasFetched = true
      notify()
    })
    .catch(() => {
      // Network failure — tolerate, keep status null.
      hasFetched = true
      notify()
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

export function useVoiceProfile(): VoiceProfileState {
  const [, forceRender] = useState(0)

  const refresh = useCallback(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    const onChange = () => forceRender((n) => n + 1)
    listeners.add(onChange)

    if (!hasFetched) fetchStatus()

    const onFocus = () => fetchStatus()
    window.addEventListener('focus', onFocus)

    return () => {
      listeners.delete(onChange)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return {
    status: cache,
    // True from the very first render (before the effect kicks off the fetch)
    // until the first fetch settles. Gating on `inFlight !== null` would report
    // `loading === false` on that first synchronous render — the fetch starts in
    // an effect, so nothing is in flight yet — and flash a not-enrolled hero at
    // an already-enrolled user before the status resolves.
    loading: !hasFetched,
    refresh,
  }
}
