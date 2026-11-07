/**
 * What a recording's controls share between the two places they show: the
 * top bar's Capture pill (top-bar/capture-bar-button.tsx) and the live
 * agent's HUD header (components/live-hud/hud-recording-controls.tsx, run in
 * the recording's window): what its status reads as, and the way back to it.
 */
import { openTarget } from '@/lib/chat-cards/open-card'

/**
 * Back to the live capture: its card in the main chat (there is one chat:
 * docs/plans/one-chat.md), which docks a recording capture's card beside the
 * chat rather than opening it full screen (the one already there, if any).
 */
export function openActiveCapture(captureId: string): void {
  openTarget({ type: 'capture', id: captureId, title: 'Active capture' }, { from: 'capture', reuse: true })
}

/** "Recording", or the transcription's trouble. */
export function recordingStatusLabel(transcriptionStatus: string | null | undefined): string {
  return transcriptionStatus === 'disconnected' ? 'No Transcript' : transcriptionStatus === 'reconnecting' ? 'Reconnecting' : 'Recording'
}

/** The status dot's colour: red, or the transcription's trouble (`ping` = its halo's lighter shade). */
export function recordingDotClass(transcriptionStatus: string | null | undefined, ping = false): string {
  if (transcriptionStatus === 'disconnected') return ping ? 'bg-orange-400' : 'bg-orange-500'
  if (transcriptionStatus === 'reconnecting') return ping ? 'bg-yellow-400' : 'bg-yellow-500'
  return ping ? 'bg-red-400' : 'bg-red-500'
}
