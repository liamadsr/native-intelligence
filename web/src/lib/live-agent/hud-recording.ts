/**
 * The recording's controls in the live agent's HUD (Liam, 10-15: "move this
 * capture controls to the HUD at the top header where you see the
 * assistant's name, on the right-hand side"): the red dot, "Recording", the
 * elapsed time, the way back to the capture (←), pause / resume and stop,
 * which used to be the top bar's Capture pill while a capture recorded.
 *
 * The web HUD sits in the recording's own page and reads the recording
 * context directly (components/live-hud/in-page-hud-feed.tsx). The desktop's
 * HUD is a window of its own with no RecordingProvider, so the recording
 * window's HUD publisher (components/capture/voice-id-hud-publisher.tsx)
 * passes the state on and runs the clicks, like Voice ID's:
 *   - HUD_RECORDING_STATE_EVENT (recording window → HUD, Tauri emitTo): a
 *     HudRecordingState whenever it changes (pause, resume, finalizing, the
 *     transcription's health) and again when the HUD says it's listening.
 *     Never a tick: the elapsed time rides as a reading (`elapsedSec` at
 *     `at`) the HUD counts on from by itself;
 *   - HUD_RECORDING_ACTION_EVENT (HUD → every window): a HudRecordingAction,
 *     run by the window recording that capture.
 *
 * The top bar steps aside while a HUD shows the controls for the recording
 * capture (hudShowsRecordingControls below): on web while the panel is up,
 * on desktop once the HUD window has said it's listening. Until then (or if
 * the HUD never comes up) the top bar keeps its pill, so a recording can
 * always be stopped.
 *
 * Client-safe: no server imports. Everything that crosses a window is
 * checked, not trusted.
 */

/** Recording window → the HUD (Tauri, emitTo): a HudRecordingState, or `{ captureId: null }` when it stops. */
export const HUD_RECORDING_STATE_EVENT = 'live-hud:recording'
/** HUD → every window (Tauri): a HudRecordingAction. */
export const HUD_RECORDING_ACTION_EVENT = 'live-hud:recording-action'

/** The transcription's health, as the pill shows it. */
export type HudTranscription = 'connected' | 'reconnecting' | 'disconnected'

/** What the HUD's controls draw. JSON: it crosses windows. */
export interface HudRecordingState {
  captureId: string
  paused: boolean
  /** The agent is finishing up after a stop: pause and stop are disabled. */
  finalizing: boolean
  transcription: HudTranscription
  /** The elapsed seconds, as read at `at` (ms since the epoch). Paused, it holds. */
  elapsedSec: number
  at: number
}

export type HudRecordingActionType = 'pause' | 'resume' | 'stop' | 'open'

/** A click on the HUD's controls, for the window recording `captureId`. */
export interface HudRecordingAction {
  captureId: string
  type: HudRecordingActionType
}

/** What runs a HudRecordingAction: the recording's own handlers (the top bar pill's). */
export interface HudRecordingHandlers {
  pauseRecording: () => void
  resumeRecording: () => void
  stopRecording: () => unknown
  /** Back to the capture: its card in the main chat. */
  openCapture: (captureId: string) => void
}

const ACTIONS: readonly HudRecordingActionType[] = ['pause', 'resume', 'stop', 'open']
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The state from the recording's own values. */
export function hudRecordingState(input: {
  captureId: string
  isPaused: boolean
  isAgentFinalizing: boolean
  transcriptionStatus: string | null | undefined
  elapsedSec: number
  at: number
}): HudRecordingState {
  return {
    captureId: input.captureId,
    paused: input.isPaused,
    finalizing: input.isAgentFinalizing,
    transcription: transcriptionOf(input.transcriptionStatus),
    elapsedSec: Math.max(0, Math.floor(input.elapsedSec || 0)),
    at: input.at,
  }
}

function transcriptionOf(v: unknown): HudTranscription {
  return v === 'reconnecting' || v === 'disconnected' ? v : 'connected'
}

/** `payload` as a state, or null if it isn't one (a stop sends `{ captureId: null }`). */
export function readHudRecordingState(payload: unknown): HudRecordingState | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.captureId)) return null
  const elapsed = typeof p.elapsedSec === 'number' && Number.isFinite(p.elapsedSec) ? p.elapsedSec : 0
  const at = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : 0
  return {
    captureId: p.captureId,
    paused: p.paused === true,
    finalizing: p.finalizing === true,
    transcription: transcriptionOf(p.transcription),
    elapsedSec: Math.max(0, Math.floor(elapsed)),
    at,
  }
}

/** `payload` as an action, or null. */
export function readHudRecordingAction(payload: unknown): HudRecordingAction | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.captureId) || !ACTIONS.includes(p.type as HudRecordingActionType)) return null
  return { captureId: p.captureId, type: p.type as HudRecordingActionType }
}

/** Run a HUD click through `handlers`, if it's for `captureId`. Returns whether it ran. */
export function runHudRecordingAction(payload: unknown, captureId: string, handlers: HudRecordingHandlers): boolean {
  const action = readHudRecordingAction(payload)
  if (!action || action.captureId !== captureId) return false
  switch (action.type) {
    case 'pause':
      handlers.pauseRecording()
      break
    case 'resume':
      handlers.resumeRecording()
      break
    case 'stop':
      void Promise.resolve(handlers.stopRecording()).catch(() => {})
      break
    case 'open':
      handlers.openCapture(captureId)
      break
  }
  return true
}

/** Two states that draw the same (the reading may differ: the count goes on from either). */
export function sameHudRecording(a: HudRecordingState | null, b: HudRecordingState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.captureId === b.captureId &&
    a.paused === b.paused &&
    a.finalizing === b.finalizing &&
    a.transcription === b.transcription &&
    a.elapsedSec === b.elapsedSec &&
    a.at === b.at
  )
}

// ── Who shows the controls (the top bar steps aside) ───────────────────────

const hosts = new Map<symbol, string>()
const hostListeners = new Set<() => void>()
const notifyHosts = () => {
  for (const l of [...hostListeners]) l()
}

/**
 * A HUD showing the recording's controls for `captureId` says so (the web
 * panel while it's up; the desktop's recording window once its HUD listens).
 * Returns the release.
 */
export function claimHudRecordingControls(captureId: string): () => void {
  const key = Symbol(captureId)
  hosts.set(key, captureId)
  notifyHosts()
  return () => {
    if (hosts.delete(key)) notifyHosts()
  }
}

/** Does a HUD show the recording's controls for `captureId` right now? */
export function hudShowsRecordingControls(captureId: string | null): boolean {
  if (!captureId) return false
  for (const id of hosts.values()) if (id === captureId) return true
  return false
}

export function subscribeHudRecordingControls(listener: () => void): () => void {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}

/** Tests only. */
export function __resetHudRecordingControlsForTests(): void {
  hosts.clear()
}
