/**
 * The call's goal, set or edited from the live agent's HUD (live sidekick
 * plan, Phase 5): the HUD's goal line (components/live-hud/hud-goal-line.tsx)
 * shows the person's goal for the meeting and lets them change it mid-call;
 * with none, a quiet "Set a goal" while the call is live.
 *
 * The write runs in the window recording the call, never in the HUD
 * (components/live-hud/save-hud-goal.ts): it asks for the capture's meeting
 * (GET /api/account/meeting-goal?capture_id), saves the goal there with source
 * 'hud' and the capture's link, and says so on its window
 * (MEETING_GOAL_CHANGED_EVENT), so the brief is read again and re-sent to the
 * HUD. The web HUD sits in the recording's own page and calls it directly.
 * The desktop's HUD is a window of its own, so it asks the recording window
 * over Tauri, like the recording's controls (lib/live-agent/hud-recording.ts),
 * and waits for the answer like a flush (lib/live-agent/live-hud.ts):
 *   - HUD_GOAL_ACTION_EVENT (HUD → every window): a HudGoalAction, run by the
 *     window recording that capture;
 *   - HUD_GOAL_RESULT_EVENT (recording window → HUD, emitTo): `{ id, ok }`,
 *     so the HUD keeps the new goal or puts the old one back. No answer within
 *     HUD_GOAL_ACK_CAP_MS counts as a failure.
 *
 * Client-safe: no server imports. Everything that crosses a window is
 * checked, not trusted.
 */
import { MEETING_GOAL_MAX_CHARS, normalizeEventId, normalizeStartsAt } from '@/lib/meetings/meeting-goal'

/** HUD → every window (Tauri): a HudGoalAction. */
export const HUD_GOAL_ACTION_EVENT = 'live-hud:goal-action'
/** Recording window → the HUD (Tauri, emitTo): a HudGoalResult. */
export const HUD_GOAL_RESULT_EVENT = 'live-hud:goal-result'
/** How long the HUD waits for the recording window's answer before it puts the old goal back. */
export const HUD_GOAL_ACK_CAP_MS = 10_000

/** Set (with the words) or clear the goal for the call `captureId`. JSON: it crosses windows. */
export interface HudGoalAction {
  captureId: string
  /** The HUD's id for this write: the answer names it. */
  id: string
  type: 'set' | 'clear'
  /** The goal, trimmed; '' for a clear. */
  goal: string
}

export interface HudGoalResult {
  id: string
  ok: boolean
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The action for saving `goal` ('' clears), or null when it's too long or has no capture. Pure. */
export function hudGoalAction(captureId: string, id: string, goal: string): HudGoalAction | null {
  if (!isText(captureId) || !isText(id) || typeof goal !== 'string') return null
  const text = goal.trim()
  if (text.length > MEETING_GOAL_MAX_CHARS) return null
  return text ? { captureId, id, type: 'set', goal: text } : { captureId, id, type: 'clear', goal: '' }
}

/** `payload` as an action, or null: a set needs words (at most the goal's cap), a clear none. */
export function readHudGoalAction(payload: unknown): HudGoalAction | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.captureId) || !isText(p.id)) return null
  if (p.type === 'clear') return { captureId: p.captureId, id: p.id, type: 'clear', goal: '' }
  if (p.type !== 'set' || typeof p.goal !== 'string') return null
  const goal = p.goal.trim()
  if (!goal || goal.length > MEETING_GOAL_MAX_CHARS) return null
  return { captureId: p.captureId, id: p.id, type: 'set', goal }
}

/** `payload` as an answer, or null. */
export function readHudGoalResult(payload: unknown): HudGoalResult | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.id) || typeof p.ok !== 'boolean') return null
  return { id: p.id, ok: p.ok }
}

/**
 * Run a HUD's goal write through `save` (the goal, '' to clear), if it's for
 * `captureId`: the answer to send back, or null when it isn't this window's
 * to run (another capture's, or not an action). A save that throws is a
 * failed one.
 */
export async function runHudGoalAction(
  payload: unknown,
  captureId: string,
  save: (goal: string) => Promise<boolean>,
): Promise<HudGoalResult | null> {
  const action = readHudGoalAction(payload)
  if (!action || action.captureId !== captureId) return null
  let ok = false
  try {
    ok = (await save(action.type === 'clear' ? '' : action.goal)) === true
  } catch {
    ok = false
  }
  return { id: action.id, ok }
}

/** The meeting a capture's goal is written under (the route's answer), checked. */
export interface HudGoalMeeting {
  calendarEventId: string
  startsAt: string
}

/** The route's `meeting`, or null when it isn't one. Pure. */
export function readHudGoalMeeting(value: unknown): HudGoalMeeting | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const calendarEventId = normalizeEventId(v.calendarEventId)
  const startsAt = normalizeStartsAt(v.startsAt)
  return calendarEventId && startsAt ? { calendarEventId, startsAt } : null
}

/**
 * The meeting to write the capture's goal under: the existing goal's, else
 * the capture's calendar event at its start, else (an ad-hoc call) its own
 * synthetic meeting (lib/meetings/meeting-goal.ts meetingKeyForCapture).
 * Null on any failure.
 */
export async function fetchHudGoalMeeting(captureId: string): Promise<HudGoalMeeting | null> {
  try {
    const res = await fetch(`/api/account/meeting-goal?capture_id=${encodeURIComponent(captureId)}`)
    if (!res.ok) return null
    const json = (await res.json()) as { meeting?: unknown } | null
    return readHudGoalMeeting(json?.meeting)
  } catch {
    return null
  }
}
