/**
 * One voice conversation per page: the composer's voice mode and a bot
 * bubble's mic (bots-v2.md decision 8) each run useVoiceMode, and starting
 * one ends whichever was running, here, at once.
 *
 * The desktop enforces it too (a second `voice_start` from the same webview
 * replaces the first; one from another webview is refused `busy`), but its
 * end for the replaced session arrives later, as an event, and would play the
 * end chime over the new session's start chime. Claiming here ends the old
 * one quietly first, the way ../read-aloud/reader hands the TTS queue over.
 *
 * Interactive mode's background session (components/read-aloud/
 * interactive-voice-host.tsx) is not a claimant: it YIELDS to a conversation.
 * It watches whether one is held (useVoiceSessionHeld), stops its own session
 * the moment one is claimed (the claim lands synchronously, before the
 * conversation's voice_start), and starts again once it is released.
 */

import { useSyncExternalStore } from 'react'

let holder: { owner: object; end: () => void } | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of [...listeners]) listener()
}

/** Take the page's voice conversation; another owner holding it is ended. */
export function claimVoiceSession(owner: object, end: () => void): void {
  const previous = holder
  holder = { owner, end }
  if (previous && previous.owner !== owner) previous.end()
  if (!previous) notify()
}

/** Let go of it (the session ended). A no-op unless `owner` holds it. */
export function releaseVoiceSession(owner: object): void {
  if (holder?.owner !== owner) return
  holder = null
  notify()
}

/** A voice conversation (the composer's, a bot bubble's) holds the page's voice. */
export function isVoiceSessionHeld(): boolean {
  return holder !== null
}

export function subscribeVoiceSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether a voice conversation holds the page's voice, live. */
export function useVoiceSessionHeld(): boolean {
  return useSyncExternalStore(subscribeVoiceSession, isVoiceSessionHeld, () => false)
}
