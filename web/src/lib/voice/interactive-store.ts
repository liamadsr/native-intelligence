/**
 * Interactive mode's live state, for the top bar's mic button
 * (components/read-aloud/listen-mode-toggle.tsx): where the conversation is
 * (published by the engine, ./interactive-engine) and the user's mute.
 *
 * Phases:
 *   off        no session listening (starting, waiting for the mic, yielded
 *              to voice mode or dictation, or this desktop can't)
 *   listening  quiet: listening for the assistant's name
 *   heard      the name was heard: capturing what is asked
 *   thinking   sent to the chat, waiting on the reply
 *   answering  the reply is being read aloud (talking interrupts it)
 *   follow-up  the reply is over: a few seconds to answer without the name
 *
 * The mute is the user's (the mic button): it gates the mic at the desktop
 * and keeps the session, so the reading goes on. For this page load only, and
 * back to unmuted whenever Interactive turns off.
 */

import { useSyncExternalStore } from 'react'

export type InteractivePhase = 'off' | 'listening' | 'heard' | 'thinking' | 'answering' | 'follow-up'

export interface InteractiveVoiceState {
  phase: InteractivePhase
  muted: boolean
}

const INITIAL: InteractiveVoiceState = Object.freeze({ phase: 'off', muted: false }) as InteractiveVoiceState

let state: InteractiveVoiceState = INITIAL
const listeners = new Set<() => void>()

function set(next: InteractiveVoiceState) {
  if (next.phase === state.phase && next.muted === state.muted) return
  state = next
  for (const listener of [...listeners]) listener()
}

export function getInteractiveVoice(): InteractiveVoiceState {
  return state
}

export function subscribeInteractiveVoice(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Interactive mode's phase and mute, live. */
export function useInteractiveVoice(): InteractiveVoiceState {
  return useSyncExternalStore(subscribeInteractiveVoice, getInteractiveVoice, () => INITIAL)
}

/** The engine's phase. */
export function setInteractivePhase(phase: InteractivePhase): void {
  set({ ...state, phase })
}

export function setInteractiveMuted(muted: boolean): void {
  set({ ...state, muted })
}

/** The mic button. */
export function toggleInteractiveMute(): void {
  setInteractiveMuted(!state.muted)
}

/** Tests only: a fresh page. */
export function __resetInteractiveVoiceForTests(): void {
  set(INITIAL)
}
