/**
 * The voice bird, the one easter egg left of the persona (Liam, 2026-10-17):
 * five quick clicks on the main chat's composer and the agent's bot (drawn as
 * a bird until 10-23: bots/agent-bot.tsx) hatches in the app.
 * It is the main chat's voice mode (same conversation, same agent): it is
 * here while that voice mode runs, and gone once it ends, from any side.
 *
 *   - Summon: the main composer counts its presses (createClickBurst); the
 *     fifth inside SUMMON_WINDOW_MS calls toggleVoiceBird. Only on the
 *     desktop with voice mode ready (`canHatch`); on the web nothing happens.
 *   - Hatch: VOICE_BIRD_EVENT `start` reaches the main chat's host, which
 *     starts voice mode in the chat as it is (ChatPanelHandle.startVoiceMode,
 *     what the composer's waveform does: no thread switch, no wait). The bird
 *     is here once that started and the panel reports voice mode on
 *     (reportMainVoice). A refusal toasts there, and no bird. Each summon is
 *     its own call: the host asks `wanted()` before it starts, and a call
 *     sent away (or replaced by a newer one) is never acted on.
 *   - Leave: the five clicks again, a click on the bird (sendVoiceBirdAway:
 *     VOICE_BIRD_EVENT `end` ends voice mode), or voice mode ending any other
 *     way (the stop, Esc, a chat switch, a capture taking the mic).
 *
 * A module store: nothing listens and nothing runs while the bird is away
 * (EasterEggBird renders nothing then).
 *
 * The agent card's Call button (bots/agent-call-button.tsx, Liam 10-23: "the
 * call button ... should just start the voice mode") goes the same way to the
 * host, but hatches no bird: callMainVoice / endMainVoice, and useMainVoice
 * for whether the main chat's voice mode is on.
 */
import { useSyncExternalStore } from 'react'
import type { VoicePhase } from '@/hooks/use-voice-mode'

/** The main chat's host hears this (main-chat-host.tsx). */
export const VOICE_BIRD_EVENT = 'dial8:voice-bird'

export type VoiceBirdDetail =
  | {
      action: 'start'
      /** The host took it (no host: the summon is dropped). */
      take: () => void
      /** This summon still stands (not sent away, not replaced): checked
       *  before voice mode starts. */
      wanted: () => boolean
      /** Whether voice mode started. */
      onResult: (started: boolean) => void
    }
  | { action: 'end' }

export function parseVoiceBirdDetail(detail: unknown): VoiceBirdDetail | null {
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Record<string, unknown>
  if (d.action === 'end') return { action: 'end' }
  if (d.action === 'start' && typeof d.take === 'function' && typeof d.wanted === 'function' && typeof d.onResult === 'function') {
    return {
      action: 'start',
      take: d.take as () => void,
      wanted: d.wanted as () => boolean,
      onResult: d.onResult as (started: boolean) => void,
    }
  }
  return null
}

// ── Summon: five quick presses ───────────────────────────────────────────────

export const SUMMON_CLICKS = 5
export const SUMMON_WINDOW_MS = 1500

/**
 * Counts presses: `hit(now, clickCount)` is true once `count` presses fell
 * within `windowMs` AND the browser counts this one as the `count`th click in
 * a row in one spot (mousedown's `detail`), then starts over. A triple-click
 * (selecting a line) never hits, nor does a double-click then a triple-click.
 */
export function createClickBurst(count = SUMMON_CLICKS, windowMs = SUMMON_WINDOW_MS) {
  let times: number[] = []
  return {
    hit(now: number, clickCount: number): boolean {
      times = times.filter((t) => now - t <= windowMs)
      times.push(now)
      if (clickCount < count || times.length < count) return false
      times = []
      return true
    },
  }
}

// ── The store ────────────────────────────────────────────────────────────────

export interface VoiceBirdState {
  /** The bird is in the app. */
  here: boolean
  /** Asked the host to start voice mode; not answered yet. */
  calling: boolean
  /** The main chat's voice mode is on (ChatPanel reports it). */
  voiceActive: boolean
  /** Its phase while on, else null. */
  phase: VoicePhase | null
}

const AWAY: VoiceBirdState = Object.freeze({ here: false, calling: false, voiceActive: false, phase: null }) as VoiceBirdState

let state: VoiceBirdState = AWAY
const listeners = new Set<() => void>()
/** The summon now calling (0: none). Each call gets its own. */
let callToken = 0
let nextToken = 0

function set(patch: Partial<VoiceBirdState>) {
  const next = { ...state, ...patch }
  if (next.here === state.here && next.calling === state.calling && next.voiceActive === state.voiceActive && next.phase === state.phase) return
  state = next
  for (const l of [...listeners]) l()
}

export function subscribeVoiceBird(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function voiceBirdState(): VoiceBirdState {
  return state
}

export function isVoiceBirdHere(): boolean {
  return state.here
}

export function voiceBirdPhase(): VoicePhase | null {
  return state.phase
}

/**
 * The main chat's voice mode, as its ChatPanel reports it (the only
 * ChatPanel is the main chat's). Voice mode off: the bird leaves.
 */
export function reportMainVoice(active: boolean, phase: VoicePhase | null) {
  set(active ? { voiceActive: true, phase } : { voiceActive: false, phase: null, here: false })
}

function dispatch(detail: VoiceBirdDetail) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(VOICE_BIRD_EVENT, { detail }))
}

/** Ask the host to start voice mode; the bird hatches once it has. */
function callVoiceBird() {
  const token = ++nextToken
  callToken = token
  set({ calling: true })
  let taken = false
  const wanted = () => callToken === token
  const onResult = (started: boolean) => {
    // Sent away or replaced meanwhile: its leaving already ended what it
    // started (the panel opens a session at once), and a newer summon is
    // never touched.
    if (!wanted()) return
    callToken = 0
    set({ calling: false, here: started && state.voiceActive })
  }
  dispatch({ action: 'start', take: () => (taken = true), wanted, onResult })
  if (!taken && wanted()) {
    callToken = 0
    set({ calling: false })
  }
}

/**
 * The agent card's Call: start the main chat's voice mode as the composer's
 * waveform does, no bird. Resolves with whether it started (a refusal toasts
 * at the host; with no host, nothing starts).
 */
export function callMainVoice(): Promise<boolean> {
  return new Promise((resolve) => {
    let taken = false
    dispatch({ action: 'start', take: () => (taken = true), wanted: () => true, onResult: resolve })
    if (!taken) resolve(false)
  })
}

/** The agent card's End call: the main chat's voice mode ends (the bird with it, if it's out). */
export function endMainVoice() {
  dispatch({ action: 'end' })
}

export type MainVoice = 'off' | 'starting' | 'on'

/** The main chat's voice mode, live: off, starting (opening the mic: it reports itself on at once), or on. */
export function mainVoice(): MainVoice {
  return state.voiceActive ? (state.phase === 'starting' ? 'starting' : 'on') : 'off'
}

export function useMainVoice(): MainVoice {
  return useSyncExternalStore(subscribeVoiceBird, mainVoice, () => 'off' as const)
}

/** The bird leaves and its voice mode ends (a click on it, the five clicks again). */
export function sendVoiceBirdAway() {
  const out = state.here || state.calling
  callToken = 0
  set({ here: false, calling: false })
  if (out) dispatch({ action: 'end' })
}

/**
 * The five clicks: the bird away → it is called (only when `canHatch`: the
 * desktop with voice mode ready and the mic free); here (or on its way) → it
 * is sent away.
 */
export function toggleVoiceBird({ canHatch }: { canHatch: boolean }) {
  if (state.here || state.calling) sendVoiceBirdAway()
  else if (canHatch) callVoiceBird()
}

export function __resetVoiceBirdForTests() {
  state = AWAY
  callToken = 0
}
