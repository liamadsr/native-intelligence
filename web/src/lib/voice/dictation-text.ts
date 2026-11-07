/**
 * Text helpers for dictation into the chat composer (docs/plans/chat-voice.md
 * §3.4). Pure, so the caret/space rules are unit-tested without a DOM.
 */

import type { VoiceSessionState } from '@/lib/tauri-bridge'

/** The words so far, split into what the recogniser has finalized and the
 *  interim tail still being revised. */
export interface DictationTranscript {
  final: string
  interim: string
}

/**
 * `voice://transcript` always carries the WHOLE text so far plus one flag.
 * `lastFinal` is the text of the last `final: true` event: when the current
 * text extends it, that prefix is solid and only the rest is interim.
 */
export function splitTranscript(text: string, lastFinal: string): DictationTranscript {
  if (lastFinal && text.startsWith(lastFinal)) return { final: lastFinal, interim: text.slice(lastFinal.length) }
  return { final: '', interim: text }
}

const needsSpaceBefore = (before: string) => before.length > 0 && !/\s$/.test(before)
const needsSpaceAfter = (after: string) => after.length > 0 && !/^[\s.,!?;:)]/.test(after)

/**
 * Insert dictated `text` over the selection [start, end) of `value`, with a
 * separating space on either side where the neighbouring text would otherwise
 * run into it. Returns the new value and the caret (just after the insert).
 */
export function insertDictation(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const words = text.trim()
  const s = clamp(start, 0, value.length)
  const e = clamp(Math.max(end, s), s, value.length)
  if (!words) return { value, caret: e }
  const before = value.slice(0, s)
  const after = value.slice(e)
  const insert = (needsSpaceBefore(before) ? ' ' : '') + words + (needsSpaceAfter(after) ? ' ' : '')
  return { value: before + insert + after, caret: before.length + insert.length }
}

/** How the tail previews at the caret: the same leading space the insert will get. */
export function tailPrefix(value: string, caret: number): string {
  return needsSpaceBefore(value.slice(0, clamp(caret, 0, value.length))) ? ' ' : ''
}

/** The space the insert will put before the text after the caret, if any. */
export function tailSuffix(after: string): string {
  return needsSpaceAfter(after) ? ' ' : ''
}

function clamp(n: number, lo: number, hi: number) {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi
}

/** A fresh session id (the web picks it; every voice event carries it). */
export function newVoiceSessionId(mode: 'dictation' | 'conversation' | 'interactive'): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const prefix = mode === 'dictation' ? 'dict' : mode === 'interactive' ? 'intr' : 'conv'
  return `${prefix}-${rand}`
}

/** A `voice://state` that means the transcriber is up and listening. The
 *  desktop's turn machine reports `starting` until local-stt is ready, and
 *  voice_start can resolve before that (a cold start takes seconds). `muted`
 *  hides the phase, so it says nothing either way. */
export function isVoiceReadyState(state: VoiceSessionState): boolean {
  return state !== 'starting' && state !== 'muted'
}

/** Whether a `voice://state` says the model is up and listening. A desktop
 *  whose voice_status has `readyFlag` (0.2.46+) sends `ready` on every state
 *  event, re-sent when it flips under an unchanged state: that is the answer,
 *  so a session muted, or already hearing speech, before local-stt is ready
 *  still waits for it. Without it (0.2.45), infer it (isVoiceReadyState). */
export function isVoiceReadyEvent(ev: { state: VoiceSessionState; ready?: boolean }): boolean {
  return typeof ev.ready === 'boolean' ? ev.ready : isVoiceReadyState(ev.state)
}
