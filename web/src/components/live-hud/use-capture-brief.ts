'use client'

import { useEffect, useState } from 'react'
import { fetchHudBrief, sameHudBrief, type HudBrief } from '@/lib/live-agent/hud-brief'
import { MEETING_GOAL_CHANGED_EVENT, goalChangeMayConcernCapture } from '@/lib/meetings/meeting-goal'

/**
 * The person's pre-call brief for the call's capture, for the HUD's Briefing
 * line (lib/live-agent/hud-brief.ts): read once when the call's capture is
 * known, again when the capture is edited (`ni:content-edited` for it),
 * and when a goal that may be this meeting's is saved on this page
 * (MEETING_GOAL_CHANGED_EVENT: the prep card's composer, set_meeting_goal's
 * result). On desktop this runs in the recording window's publisher, which
 * re-sends the brief to the HUD window. Null while unknown, and when there
 * is no brief. Never a poll.
 */
export function useCaptureBrief(captureId: string): HudBrief | null {
  const [brief, setBrief] = useState<HudBrief | null>(null)
  useEffect(() => {
    let ac: AbortController | null = null
    const load = () => {
      ac?.abort()
      const mine = (ac = new AbortController())
      void fetchHudBrief(captureId, mine.signal).then((next) => {
        if (mine.signal.aborted) return
        setBrief((prev) => (sameHudBrief(prev, next) ? prev : next))
      })
    }
    setBrief(null)
    load()
    const onEdited = (e: Event) => {
      if ((e as CustomEvent<{ entityId?: string } | undefined>).detail?.entityId === captureId) load()
    }
    const onGoal = (e: Event) => {
      if (goalChangeMayConcernCapture((e as CustomEvent).detail, captureId)) load()
    }
    window.addEventListener('ni:content-edited', onEdited)
    window.addEventListener(MEETING_GOAL_CHANGED_EVENT, onGoal)
    return () => {
      window.removeEventListener('ni:content-edited', onEdited)
      window.removeEventListener(MEETING_GOAL_CHANGED_EVENT, onGoal)
      ac?.abort()
    }
  }, [captureId])
  return brief
}
