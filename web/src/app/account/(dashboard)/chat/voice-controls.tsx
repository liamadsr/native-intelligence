'use client'

/**
 * The composer's voice controls (docs/plans/chat-voice.md §3.4), desktop only:
 *
 *  - DictationButton: the Mic left of send. Hold to talk, or click to latch.
 *    Like every voice control it only shows once the speech models it needs
 *    are ready (they download on their own, local-modules-keeper.ts): there
 *    is no set-up step to point at.
 *  - Voice mode has no bar of its own; it looks like a capture:
 *    - VoiceModeGlow: the capture's glow on the composer, driven by the mic
 *      and the agent's voice, the travelling beam while thinking.
 *    - VoiceTranscript: the words heard this turn, previewed in the field.
 *    - VoiceInterruptTap: the field, while the agent speaks, interrupts it.
 *    - VoiceMuteButton (the mic's spot) and VoiceEndButton (send's slot, an
 *      X on a neutral circle; the waveform only starts voice mode).
 *    - VoicePhaseAnnouncer: the state, for screen readers only.
 *  - DictationTail: the words being dictated (or heard in voice mode),
 *    previewed at the caret — the finalized part solid, the interim tail muted.
 *
 * ChatInput only renders these when useVoiceAvailability says `visible`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Mic, MicOff, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PromptInputAction } from '@/components/ui/prompt-input'
import { cn } from '@/lib/utils'
import { voiceBlockedLabel, type VoiceAvailability } from '@/hooks/use-voice-availability'
import type { DictationHandle } from '@/hooks/use-dictation'
import { VOICE_PHASE_LABEL, type VoiceModeHandle } from '@/hooks/use-voice-mode'
import { tailPrefix, tailSuffix, type DictationTranscript } from '@/lib/voice/dictation-text'
import { voiceRefusalMessage, voiceToast, type VoiceRefusalInfo } from '@/lib/voice/messages'
import { refreshVoiceStatus } from '@/lib/voice/status-store'

// ── Dictation (mic) button ───────────────────────────────────────────────────

/** A refused voice_start → a toast (and a fresh status when a module wasn't
 *  ready after all, so the control can offer set-up next time). Every composer
 *  with a mic (the chat's, the prep card's goal) reports a refusal this way. */
export function reportVoiceRefusal({ code, detail }: VoiceRefusalInfo) {
  if (code === 'not_ready') void refreshVoiceStatus()
  voiceToast(voiceRefusalMessage(code, detail))
}

const ICON_BUTTON = 'h-8 w-8 shrink-0 rounded-full'

export function DictationButton({
  availability,
  dictation,
}: {
  availability: VoiceAvailability
  dictation: DictationHandle
}) {
  // On-device transcription still downloading: no mic yet.
  if (!availability.dictation) return null

  const blocked = availability.blocked
  const listening = dictation.active
  const label = blocked ? voiceBlockedLabel(blocked) : listening ? 'Stop dictation' : 'Dictate (click, or hold to talk)'
  return (
    <PromptInputAction tooltip={label}>
      <Button
        type="button"
        variant={listening ? 'default' : 'ghost'}
        size="icon"
        className={cn(
          ICON_BUTTON,
          !listening && 'text-muted-foreground hover:text-foreground',
          dictation.phase === 'starting' && 'animate-pulse',
        )}
        aria-label={listening ? 'Stop dictation' : 'Dictate'}
        aria-pressed={listening}
        disabled={!!blocked}
        data-voice-control="dictation"
        data-dictation={dictation.phase}
        {...(blocked ? {} : dictation.buttonProps)}
      >
        <Mic className="h-4 w-4" />
      </Button>
    </PromptInputAction>
  )
}

// ── Voice mode ───────────────────────────────────────────────────────────────

// VoiceModeGlow (the composer's glow, driven by the mic and the agent's voice)
// lives in composer-voice-glow.tsx, free of the recording context, so the
// desktop overlay's bot bubble can wear it too.
export { VoiceModeGlow } from './composer-voice-glow'

/** The user's words this turn, previewed in the field the way dictation's are
 *  (finalized solid, interim muted) while listening or waiting on the answer.
 *  Nothing is written into the field's value; the turn is sent on its own.
 *  With no words, a turn Voice focus just ignored is noted there, muted. */
export function VoiceTranscript({
  hostRef,
  value,
  voice,
}: {
  hostRef: React.RefObject<HTMLElement | null>
  value: string
  voice: VoiceModeHandle
}) {
  const { live } = voice
  const transcript = useSyncExternalStore(live.subscribe, () => live.get().transcript, () => null)
  const notice = useSyncExternalStore(live.subscribe, () => live.get().notice ?? null, () => null)
  const showing = voice.phase === 'listening' || voice.phase === 'thinking'
  if (!showing) return null
  if (transcript && (transcript.final || transcript.interim)) {
    return <DictationTail hostRef={hostRef} value={value} transcript={transcript} />
  }
  // A turn Voice focus ignored: said quietly, in the interim's muted ink.
  if (notice && voice.phase === 'listening') {
    return <DictationTail hostRef={hostRef} value={value} transcript={{ final: '', interim: notice }} />
  }
  return null
}

/** While the agent speaks the text field is one "tap to interrupt" target: talking
 *  over it only interrupts with echo cancelled (or headphones) and "Interrupt by
 *  talking" on, so the tap is always there. */
export function VoiceInterruptTap({ voice }: { voice: VoiceModeHandle }) {
  if (!voice.agentSpeaking) return null
  return (
    <button
      type="button"
      className="absolute inset-0 z-10 cursor-pointer rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Interrupt"
      data-voice-control="interrupt"
      onClick={voice.interrupt}
    />
  )
}

/** Mute, in the dictation mic's spot (dictation is off during voice mode).
 *  Muted it is a soft red circle with a red mic-off, so a muted mic reads
 *  clearly without shouting (Liam, 2026-10-09); unmuted, a plain mic glyph. */
export function VoiceMuteButton({ voice }: { voice: VoiceModeHandle }) {
  const label = voice.muted ? 'Unmute microphone' : 'Mute microphone'
  return (
    <PromptInputAction tooltip={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          ICON_BUTTON,
          voice.muted
            ? 'bg-red-500/15 text-red-600 shadow-none hover:bg-red-500/25 hover:text-red-600 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30 dark:hover:text-red-400'
            : 'text-muted-foreground hover:text-foreground',
        )}
        data-muted={voice.muted ? '' : undefined}
        aria-label={label}
        aria-pressed={voice.muted}
        data-voice-control="mute"
        onClick={voice.toggleMute}
      >
        {voice.muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </Button>
    </PromptInputAction>
  )
}

/** The composer's stop square: Stop generating's, and voice mode's end. */
export function StopSquareIcon() {
  return <Square className="h-3.5 w-3.5 fill-current text-white dark:text-primary-foreground" />
}

/** Send's slot while voice mode runs: an X on a neutral circle, the mute
 *  button's size and glyph size, so mute and end read as one calm set (Liam,
 *  2026-10-09); a click ends voice mode. While a reply generates it is the
 *  only stop there. */
export function VoiceEndButton({ voice }: { voice: VoiceModeHandle }) {
  return (
    <PromptInputAction tooltip="End voice mode">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(
          ICON_BUTTON,
          'bg-muted text-foreground shadow-none transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground motion-reduce:transition-none dark:bg-white/10 dark:hover:bg-white/15',
        )}
        aria-label="End voice mode"
        data-voice-control="conversation"
        onClick={voice.end}
      >
        <X className="h-4 w-4" />
      </Button>
    </PromptInputAction>
  )
}

/** The state (Starting… / Listening / Thinking… / Speaking… / Muted), for
 *  screen readers only: the glow carries it visually. Mounted with the
 *  composer so the region exists before it first changes (a region that
 *  appears with its text is often not read). `notice` (a refusal: another
 *  window has the voice, no mic) is said in its place while it shows: a bot
 *  bubble's chat (teammate-chat.tsx), whose visible line also carries the
 *  words heard, which are kept out of the region. */
export function VoicePhaseAnnouncer({
  voice,
  notice = null,
}: {
  voice: Pick<VoiceModeHandle, 'active' | 'phase'>
  notice?: string | null
}) {
  return (
    <span
      className="sr-only"
      aria-live="polite"
      aria-atomic="true"
      data-voice-phase={voice.active ? voice.phase : undefined}
    >
      {notice || (voice.active ? VOICE_PHASE_LABEL[voice.phase] : '')}
    </span>
  )
}

// ── Dictation tail (preview at the caret) ────────────────────────────────────

/** Computed textarea styles the mirror copies so its text lines up exactly. */
const MIRRORED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textIndent',
  'textTransform',
  'tabSize',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxSizing',
] as const

/**
 * Lays the textarea's text out again in a mirror over it, with the dictated
 * words at the caret: the finalized part solid, the interim tail muted. While
 * the tail shows, the textarea's own glyphs are transparent (its caret stays),
 * so text after the caret flows around the tail instead of under it, and the
 * textarea grows to fit.
 */
export function DictationTail({
  hostRef,
  value,
  transcript,
}: {
  hostRef: React.RefObject<HTMLElement | null>
  value: string
  transcript: DictationTranscript
}) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<React.CSSProperties | null>(null)
  const [caret, setCaret] = useState(value.length)
  const [color, setColor] = useState<string | undefined>(undefined)

  const textarea = useCallback(() => hostRef.current?.querySelector('textarea') ?? null, [hostRef])

  // Copy the textarea's metrics (again whenever it resizes, e.g. the panel
  // narrowing); hide its glyphs (not its caret) meanwhile.
  useLayoutEffect(() => {
    const ta = textarea()
    if (!ta) return
    const cs = window.getComputedStyle(ta)
    const measure = () => {
      const style: Record<string, string | number> = {
        top: ta.offsetTop,
        left: ta.offsetLeft,
        width: ta.offsetWidth,
      }
      for (const key of MIRRORED) style[key] = cs[key]
      setBox(style as React.CSSProperties)
    }
    measure()
    setColor(cs.color || undefined)
    const prev = { color: ta.style.color, caretColor: ta.style.caretColor, minHeight: ta.style.minHeight }
    ta.style.caretColor = cs.color
    ta.style.color = 'transparent'
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(ta)
    return () => {
      ro?.disconnect()
      ta.style.color = prev.color
      ta.style.caretColor = prev.caretColor
      ta.style.minHeight = prev.minHeight
    }
  }, [textarea])

  // Follow the caret.
  useEffect(() => {
    const ta = textarea()
    if (!ta) return
    const sync = () => setCaret(ta.selectionStart ?? ta.value.length)
    sync()
    const events = ['select', 'keyup', 'click', 'input', 'focus'] as const
    for (const ev of events) ta.addEventListener(ev, sync)
    document.addEventListener('selectionchange', sync)
    return () => {
      for (const ev of events) ta.removeEventListener(ev, sync)
      document.removeEventListener('selectionchange', sync)
    }
  }, [textarea, value])

  // Grow the textarea to the mirror's height, and keep the tail in view.
  useLayoutEffect(() => {
    const ta = textarea()
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    const needed = Math.min(mirror.scrollHeight, 240)
    if (needed > 0) ta.style.minHeight = `${needed}px`
    mirror.scrollTop = mirror.scrollHeight
  })

  const at = Math.min(caret, value.length)
  const before = value.slice(0, at)
  const after = value.slice(at)
  const lead = tailPrefix(value, at)
  return (
    <div
      ref={mirrorRef}
      aria-hidden
      data-dictation-tail
      className="pointer-events-none absolute overflow-hidden whitespace-pre-wrap break-words border-transparent"
      style={{ ...box, maxHeight: 240, color, borderStyle: 'solid' }}
    >
      {before}
      <span data-dictation-final>
        {lead}
        {transcript.final}
      </span>
      <span data-dictation-interim className="text-muted-foreground">
        {transcript.interim}
      </span>
      {tailSuffix(after)}
      {after}
    </div>
  )
}
