'use client'

/**
 * Whether the composer shows its voice controls (the dictation mic, the voice
 * mode waveform) and whether they can start now (docs/plans/chat-voice.md
 * §3.4, "Gating").
 *
 *  - `visible`: the desktop app, `voice_status` says this build has voice,
 *    and at least one mode is ready. False → render no voice control at all
 *    (the browser, older desktops, and a desktop still downloading its
 *    speech models in the background — local-modules-keeper.ts).
 *  - `dictation` / `conversation`: the modules that mode needs are ready.
 *    A mode that isn't ready has no control: it appears, unannounced, once
 *    its models finish (Liam, 2026-10-08: no set-up prompts, no choices).
 *  - `blocked`: the mic is someone else's right now: a meeting capture is
 *    recording (or starting), or Voice ID enrollment holds it
 *    (read-aloud's mic-guard). The controls render disabled.
 */

import { useMemo } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { useMicHeld } from '@/lib/read-aloud/mic-guard'
import { useVoiceStatus } from '@/lib/voice/status-store'
import type { VoiceStatus } from '@/lib/tauri-bridge'

export type VoiceBlockedReason = 'recording' | 'enrollment'

export interface VoiceAvailability {
  /** This desktop build has voice at all, ready or not. The mic picker
   *  follows this, not `visible`: it also picks the mic captures record
   *  from, which matters while the speech models are still downloading. */
  hasVoice: boolean
  visible: boolean
  dictation: boolean
  conversation: boolean
  blocked: VoiceBlockedReason | null
  status: VoiceStatus
}

export function useVoiceAvailability({ recording }: { recording: boolean }): VoiceAvailability {
  const status = useVoiceStatus()
  // Only a hold that claims the mic: dictation's own read-aloud hold must not
  // block dictation.
  const held = useMicHeld()
  const hasVoice = isDesktopApp() && status.available
  const dictation = hasVoice && status.dictation
  const conversation = hasVoice && status.conversation
  const visible = dictation || conversation
  const blocked: VoiceBlockedReason | null = recording ? 'recording' : held ? 'enrollment' : null
  return useMemo(
    () => ({ hasVoice, visible, dictation, conversation, blocked, status }),
    [hasVoice, visible, dictation, conversation, status, blocked],
  )
}

/** The tooltip for a disabled voice control. */
export function voiceBlockedLabel(reason: VoiceBlockedReason): string {
  return reason === 'recording' ? 'Unavailable while a capture is recording' : 'Unavailable while Voice ID is listening'
}
