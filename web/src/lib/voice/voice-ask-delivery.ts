/**
 * Interactive mode → the chat: how a spoken ask reaches the chat panel, and
 * how the panel reports back on its reply.
 *
 * Interactive mode's host (components/read-aloud/interactive-voice-host.tsx)
 * owns no chat. It fires this window event; the shell (dashboard-shell.tsx,
 * chat/route-voice-ask.ts routeVoiceAskHome) routes it to the person's HOME
 * thread (A3), opened in the BACKGROUND when no tab shows it, so the screen
 * stays where the person is. The one exception is a live meeting's tab on
 * screen, which answers with the meeting's context. The panel sends it
 * through its normal send path, with the delivery's snapshot (what was being
 * read when the person spoke: `voiceAsk`) as the turn's context, has the
 * reply read aloud even from a background tab (a spoken ask always is), and
 * reports back on the delivery:
 *
 *   accept()    the panel took it (synchronously, while the event is handled:
 *               no taker → deliverVoiceAsk returns null, and the host says it
 *               can't reach the chat);
 *   speaking()  the reply began being read aloud;
 *   settle()    it is over: read to its end (`spoken`), cut short
 *               (`interrupted`: a barge-in, another reader, a new turn), done
 *               with nothing read aloud (`silent`: no text, or read-aloud off),
 *               or it failed (`failed`). Once; later calls do nothing.
 *   onInterrupt the panel hands over how to cut the reply's speech short,
 *               which the host calls on a barge-in (`voice://interrupted`).
 *
 * The host then opens its follow-up window (or, on `failed`, goes back to
 * listening). The event carries functions, so it only ever crosses this page.
 *
 * PRIVACY: the text is what the user asked their assistant, sent as their chat
 * message. Never log it.
 */

import type { VoiceAskContext } from './voice-ask'

/** Window event name. Listened for in dashboard-shell.tsx. */
export const VOICE_ASK_EVENT = 'ni:voice-ask'

export type VoiceAskOutcome = 'spoken' | 'interrupted' | 'silent' | 'failed'

/** What the panel gets (the event's detail). */
export interface VoiceAskDelivery {
  /** The request, as the user's message. */
  readonly text: string
  /** The turn's systemContext.voiceAsk. */
  readonly voiceAsk: VoiceAskContext
  accept(): void
  speaking(): void
  settle(outcome: VoiceAskOutcome): void
  onInterrupt(cut: () => void): void
}

/** What the host keeps for an ask a panel took. */
export interface VoiceAskHandle {
  /** Cut the reply's speech short (a barge-in): the panel stops reading it. */
  interrupt(): void
  /** The host no longer cares: nothing more is reported (a newer ask, Interactive off). */
  cancel(): void
}

export interface VoiceAskListeners {
  onSpeaking?: () => void
  onSettled?: (outcome: VoiceAskOutcome) => void
}

/** Whether an event's detail is a delivery (it crossed only this page). */
export function isVoiceAskDelivery(value: unknown): value is VoiceAskDelivery {
  if (!value || typeof value !== 'object') return false
  const d = value as Partial<VoiceAskDelivery>
  return (
    typeof d.text === 'string' &&
    !!d.voiceAsk &&
    typeof d.accept === 'function' &&
    typeof d.speaking === 'function' &&
    typeof d.settle === 'function' &&
    typeof d.onInterrupt === 'function'
  )
}

/**
 * Hand a spoken ask to the chat. Returns its handle, or null when no chat
 * panel took it (none listening, or none could). Safe during SSR (null).
 */
export function deliverVoiceAsk(
  text: string,
  voiceAsk: VoiceAskContext,
  listeners: VoiceAskListeners = {},
): VoiceAskHandle | null {
  if (typeof window === 'undefined') return null
  let accepted = false
  let over = false
  let cut: (() => void) | null = null
  const delivery: VoiceAskDelivery = {
    text,
    voiceAsk,
    accept: () => {
      accepted = true
    },
    speaking: () => {
      if (!over) listeners.onSpeaking?.()
    },
    settle: (outcome) => {
      if (over) return
      over = true
      listeners.onSettled?.(outcome)
    },
    onInterrupt: (fn) => {
      cut = fn
    },
  }
  window.dispatchEvent(new CustomEvent<VoiceAskDelivery>(VOICE_ASK_EVENT, { detail: delivery }))
  if (!accepted) {
    over = true
    return null
  }
  return {
    interrupt: () => {
      if (!over) cut?.()
    },
    cancel: () => {
      over = true
    },
  }
}
