/**
 * User-facing copy for voice refusals and ends (dictation and voice mode).
 */

import type { VoiceEndReason, VoiceRefusal } from '@/lib/tauri-bridge'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

const REFUSALS: readonly VoiceRefusal[] = ['recording', 'busy', 'not_ready', 'mic_denied', 'unavailable']

/** A rejected voice_start → its refusal code (VoiceRefusedError carries one;
 *  anything else is `unavailable`). Duck-typed, so it holds wherever the
 *  bridge module is mocked. */
export function voiceRefusalCode(err: unknown): VoiceRefusal {
  const code = (err as { code?: unknown } | null)?.code
  return REFUSALS.includes(code as VoiceRefusal) ? (code as VoiceRefusal) : 'unavailable'
}

/** A refused voice_start: its code, and what the desktop said beyond it. */
export interface VoiceRefusalInfo {
  code: VoiceRefusal
  /** The desktop's words after the code (`unavailable: the audio thread could
   *  not start` → `the audio thread could not start`), or null. */
  detail: string | null
}

/** A rejected voice_start → its code and detail. The bridge's message is
 *  `code` or `code: <the desktop's text>`, and that text may repeat the code
 *  (`unavailable: unavailable: the microphone …`), so every leading copy of it
 *  is stripped. */
export function voiceRefusalInfo(err: unknown): VoiceRefusalInfo {
  const code = voiceRefusalCode(err)
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  let detail = message.trim()
  const prefix = `${code}:`
  while (detail.startsWith(prefix)) detail = detail.slice(prefix.length).trim()
  return { code, detail: detail && detail !== code ? detail : null }
}

/** The desktop's `unavailable: lid_closed`: the mic it would use is a
 *  MacBook's built-in one, and the lid is shut. */
const isLidClosed = (detail: string) => /^lid_closed\b/.test(detail)

/** An older desktop (or a stripped ACL): the command itself isn't there. */
const isMissingCommand = (detail: string) => /\bnot found\b|\bnot allowed\b|unknown command/i.test(detail)

const MAX_DETAIL = 160

/** Why voice_start was refused, for a toast. `not_ready` opens the set-up
 *  popover instead, so its line is only a fallback. An `unavailable` with a
 *  detail is a runtime failure (the mic or the audio thread didn't start),
 *  not a missing feature. */
export function voiceRefusalMessage(code: VoiceRefusal, detail?: string | null): string {
  switch (code) {
    case 'recording':
      return 'Voice is unavailable while a capture is recording.'
    case 'busy':
      return 'Voice is already in use in another Native Intelligence window.'
    case 'mic_denied':
      return `Native Intelligence can’t use the microphone. Allow ${APP_IN_SYSTEM_SETTINGS} in System Settings → Privacy & Security → Microphone.`
    case 'not_ready':
      return 'Voice needs its on-device modules. Set them up in Settings.'
    default: {
      const why = detail?.trim()
      if (!why || isMissingCommand(why)) return 'Voice isn’t available on this version of Native Intelligence.'
      if (isLidClosed(why)) return 'Your MacBook’s lid is closed, so its microphone is off. Connect a mic or open the lid.'
      const shown = why.length > MAX_DETAIL ? `${why.slice(0, MAX_DETAIL - 1)}…` : why.replace(/[.\s]+$/, '')
      return `Couldn’t start the microphone (${shown}).`
    }
  }
}

/** Why a session ended on its own, for a toast; null = say nothing (the user
 *  ended it, or the reason is self-evident). `replyPending`: voice mode ended
 *  while its last turn's reply was still coming. */
export function voiceEndedMessage(
  reason: VoiceEndReason,
  mode: 'dictation' | 'conversation',
  opts: { replyPending?: boolean } = {},
): string | null {
  const what = mode === 'dictation' ? 'Dictation' : 'Voice mode'
  switch (reason) {
    case 'recording':
      return `${what} ended: a capture started recording.`
    case 'idle':
      if (mode !== 'conversation') return null
      return opts.replyPending
        ? 'Voice mode ended while Native Intelligence was still working. The reply will appear in the chat.'
        : 'Voice mode ended after 5 minutes of silence.'
    case 'device':
      return `${what} ended: the microphone stopped working.`
    case 'error':
      return `${what} ended unexpectedly.`
    default:
      return null
  }
}

/** Show a toast without pulling sonner into the first paint (as ChatPanel does). */
export function voiceToast(message: string): void {
  void import('sonner').then(({ toast }) => toast.error(message)).catch(() => {})
}
