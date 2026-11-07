'use client'

/**
 * The recording window's half of the HUD's goal line (lib/live-agent/hud-goal.ts):
 * save the call's goal ('' clears it) for the live capture. Run by the
 * recording window's publisher for the desktop's HUD window, and called
 * directly by the web HUD, which sits in the recording's own page.
 *
 *   1. The meeting: GET /api/account/meeting-goal?capture_id — the existing
 *      goal's, else the capture's calendar event at its start, else (an
 *      ad-hoc call) `capture:<captureId>` at the capture's start.
 *   2. The write: PUT with source 'hud' and the capture's link, or DELETE for
 *      a clear, through the prep card's cache (saveMeetingGoal), so a card
 *      showing the meeting agrees; quiet: the HUD shows a failure itself.
 *   3. On success the write says so on this window (MEETING_GOAL_CHANGED_EVENT
 *      with the capture): useCaptureBrief reads the brief again, and the
 *      publisher re-sends it to the HUD.
 *
 * Resolves false when the meeting can't be found or the write failed.
 */
import { saveMeetingGoal } from '@/hooks/use-meeting-goal'
import { fetchHudGoalMeeting } from '@/lib/live-agent/hud-goal'

export async function saveHudGoal(captureId: string, goal: string): Promise<boolean> {
  if (!captureId) return false
  const meeting = await fetchHudGoalMeeting(captureId)
  if (!meeting) return false
  return saveMeetingGoal({ ...meeting, captureId }, goal, 'hud', { quiet: true })
}
