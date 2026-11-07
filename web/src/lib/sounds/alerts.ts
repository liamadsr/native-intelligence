/**
 * Alert sounds: `agent-alert`, `agent-complete`, `notification-alert`, and an
 * AI teammate's own three (`agent-alert-questions`, `agent-alert-hopful`,
 * `agent-alert-arivel`: ./triggers teammateArrivalSound), played for events
 * that reach every open window and tab at once. Every agent sound, the
 * teammate's included, goes through the same gates.
 *
 *   void playAlertSound({ sound: 'agent-alert', key: `attention-run:${runKey}` })
 *
 * The gates, in order (the first that fails decides the outcome):
 *
 *  1. off         — the Sound effects setting is off.
 *  2. (grace)     — a notification-alert waits NOTIFICATION_GRACE_MS first, so
 *                   an agent sound for the same happening can claim ahead of it.
 *  3. unavailable — this window can't make a sound now (a browser tab never
 *                   clicked or typed in: its AudioContext can't resume). It
 *                   takes no claim and writes no key, so a window that can
 *                   play gets the event.
 *  4. duplicate   — one sound per event key across windows: a Web Lock
 *                   `dial8-sound:event:<key>` (ifAvailable, held KEY_HOLD_MS)
 *                   picks one window; a small shared memory of recent keys
 *                   (localStorage, RECENT_KEY_TTL_MS) catches a late replay of
 *                   the same key (a window that got it seconds later). A
 *                   question's key (`ask:<hash of its text>`) stays out of
 *                   that memory: the same question asked again minutes later
 *                   is a new event, and the chat path guards its own replays
 *                   (./use-ask-arrival-sound). The lock still makes the
 *                   notification and the chat picker for one arrival one sound.
 *  5. superseded  — the most specific sound wins: a notification-alert within
 *                   AGENT_PRECEDENCE_MS of an agent event (any window, played
 *                   or not) is the same happening told twice.
 *  6. quiet       — the mic is live or a capture records (./quiet).
 *  7. coalesced   — at most one alert per COOLDOWN_MS across windows (a burst
 *                   of cards is one chime).
 *  8. played / unavailable — the engine played it, or couldn't.
 *
 * The event key belongs to the caller: the id of the real-world event, spelled
 * the same by every path that can see it (see ./triggers). The claim is taken
 * before the quiet check, so an event heard while quiet is spent, not replayed
 * by another window a moment later.
 */

import type { SoundName } from './catalog'
import { claimLock } from './cross-window'
import { canPlaySoundsNow, playSound } from './engine'
import { isSoundQuiet } from './quiet'
import { getSoundEffectsEnabled } from './settings'

export type AlertSound = Extract<
  SoundName,
  | 'agent-alert'
  | 'agent-complete'
  | 'notification-alert'
  | 'agent-alert-questions'
  | 'agent-alert-hopful'
  | 'agent-alert-arivel'
>

export interface AlertRequest {
  sound: AlertSound
  /** The real-world event's id, the same from every path that can see it. */
  key: string
}

export type AlertOutcome = 'off' | 'duplicate' | 'superseded' | 'quiet' | 'coalesced' | 'played' | 'unavailable'

export const ALERT_TIMING = {
  NOTIFICATION_GRACE_MS: 1200,
  KEY_HOLD_MS: 6000,
  RECENT_KEY_TTL_MS: 5 * 60_000,
  AGENT_PRECEDENCE_MS: 6000,
  COOLDOWN_MS: 4000,
}

const RECENT_KEYS_STORAGE = 'dial8:sounds:recent'
const RECENT_KEYS_MAX = 40
const AGENT_CHANNEL = 'dial8:sound-agent'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ── Recent keys: a tiny shared memory (bounded; every access wrapped) ────────

type RecentKeys = Array<[key: string, at: number]>

function readRecent(now: number): RecentKeys {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(RECENT_KEYS_STORAGE)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is [string, number] =>
        Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && now - e[1] < ALERT_TIMING.RECENT_KEY_TTL_MS,
    )
  } catch {
    return []
  }
}

/** Keys the recent-key memory skips: a question's text can come back as a new
 *  question (see gate 4 in the module doc). */
function isRemembered(key: string): boolean {
  return !key.startsWith('ask:')
}

/** Record `key`; false when it was already recorded (a replay). */
function rememberKey(key: string): boolean {
  const now = Date.now()
  const stored = key.slice(0, 200)
  const recent = readRecent(now)
  if (recent.some(([k]) => k === stored)) return false
  recent.push([stored, now])
  try {
    window.localStorage.setItem(RECENT_KEYS_STORAGE, JSON.stringify(recent.slice(-RECENT_KEYS_MAX)))
  } catch {
    // Full or blocked storage: the lock still dedupes live copies.
  }
  return true
}

// ── When an agent event last claimed a sound, in any window ──────────────────

let lastAgentEventAt = 0
let agentChannel: BroadcastChannel | null | undefined

function agentSoundChannel(): BroadcastChannel | null {
  if (agentChannel !== undefined) return agentChannel
  agentChannel = null
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    agentChannel = new BroadcastChannel(AGENT_CHANNEL)
    agentChannel.onmessage = (e: MessageEvent<{ at?: unknown }>) => {
      const at = e.data?.at
      if (typeof at === 'number' && at > lastAgentEventAt) lastAgentEventAt = at
    }
  } catch {
    agentChannel = null
  }
  return agentChannel
}

// Listen from the start: an agent event in another window before this one's
// first alert must still count.
if (typeof window !== 'undefined') agentSoundChannel()

/** An agent event won its claim (played or not: quiet and coalesced count
 *  too — the happening was heard, and a notification about it is a repeat). */
function markAgentEvent() {
  lastAgentEventAt = Date.now()
  try {
    agentSoundChannel()?.postMessage({ at: lastAgentEventAt })
  } catch {
    /* other windows miss it; their grace still applies */
  }
}

/** Play an alert sound for an event, once across every window. Never rejects. */
export async function playAlertSound({ sound, key }: AlertRequest): Promise<AlertOutcome> {
  try {
    if (!getSoundEffectsEnabled()) return 'off'
    if (sound === 'notification-alert') await sleep(ALERT_TIMING.NOTIFICATION_GRACE_MS)
    // Before any claim: a window that can't play must leave the event to one that can.
    if (!canPlaySoundsNow()) return 'unavailable'
    if (!(await claimLock(`dial8-sound:event:${key}`, ALERT_TIMING.KEY_HOLD_MS))) return 'duplicate'
    if (isRemembered(key) && !rememberKey(key)) return 'duplicate'
    if (sound !== 'notification-alert') markAgentEvent()
    else if (Date.now() - lastAgentEventAt < ALERT_TIMING.AGENT_PRECEDENCE_MS) return 'superseded'
    if (await isSoundQuiet()) return 'quiet'
    if (!getSoundEffectsEnabled()) return 'off'
    if (!(await claimLock('dial8-sound:cooldown', ALERT_TIMING.COOLDOWN_MS))) return 'coalesced'
    return (await playSound(sound).started) ? 'played' : 'unavailable'
  } catch (err) {
    console.warn('[sounds] alert failed:', err instanceof Error ? err.message : err)
    return 'unavailable'
  }
}

/** Tests only. */
export function __resetAlertsForTests(): void {
  lastAgentEventAt = 0
  try {
    agentChannel?.close()
  } catch {
    /* already closed */
  }
  agentChannel = undefined
  try {
    window.localStorage.removeItem(RECENT_KEYS_STORAGE)
  } catch {
    /* no storage */
  }
}
