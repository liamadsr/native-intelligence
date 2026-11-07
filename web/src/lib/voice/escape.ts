/**
 * Esc ends dictation and voice mode, but only when nothing else claims it.
 * Both hooks listen on `document` in the bubble phase, so a dialog, popover,
 * menu or picker sees the key first: Radix's layers (document, capture phase)
 * and React handlers (the root, bubble phase) both run before, and both call
 * preventDefault() when they handle it.
 */

/** Open overlays that own Esc while focus is inside them. */
const OVERLAY = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
].join(',')

/** The voice controls (the mic, the waveform, voice mode's mute and tap): an
 *  overlay that holds them (a chat inside a dialog) still lets Esc reach voice. */
const VOICE_CONTROLS = '[data-voice-control]'

/** This keydown is an Esc that voice may act on. */
export function isVoiceEscape(e: KeyboardEvent): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return false
  const target = e.target instanceof Element ? e.target : null
  const overlay = target?.closest(OVERLAY)
  if (overlay && !overlay.querySelector(VOICE_CONTROLS)) return false
  return true
}
