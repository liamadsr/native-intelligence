'use client'

import { useEffect, useState } from 'react'
import { fetchHudSchedule, sameHudSchedule, type HudSchedule } from '@/lib/live-agent/hud-schedule'

/**
 * The capture's scheduled time, for the HUD header's time fill
 * (lib/live-agent/hud-schedule.ts): read once when the call's capture is
 * known, and again when its calendar event is re-linked mid-call (the tray's
 * re-link dispatches `ni:content-edited` for it). Null while unknown, and
 * for a capture with no scheduled end. Never a poll.
 */
export function useCaptureSchedule(captureId: string): HudSchedule | null {
  const [schedule, setSchedule] = useState<HudSchedule | null>(null)
  useEffect(() => {
    let ac: AbortController | null = null
    const load = () => {
      ac?.abort()
      const mine = (ac = new AbortController())
      void fetchHudSchedule(captureId, mine.signal).then((next) => {
        if (mine.signal.aborted) return
        setSchedule((prev) => (sameHudSchedule(prev, next) ? prev : next))
      })
    }
    setSchedule(null)
    load()
    const onEdited = (e: Event) => {
      if ((e as CustomEvent<{ entityId?: string } | undefined>).detail?.entityId === captureId) load()
    }
    window.addEventListener('ni:content-edited', onEdited)
    return () => {
      window.removeEventListener('ni:content-edited', onEdited)
      ac?.abort()
    }
  }, [captureId])
  return schedule
}
