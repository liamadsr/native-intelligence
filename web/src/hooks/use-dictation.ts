'use client'

/**
 * Dictation into the chat composer (docs/plans/chat-voice.md §3.4): the mic
 * button left of send. The desktop records and transcribes on-device; this
 * hook decides when a session starts and stops, and hands the words back.
 *
 *  - pointerdown on the mic starts a session.
 *  - A pointerup within 300 ms latches it: it keeps listening until the next
 *    click. A later pointerup stops it (hold-to-talk).
 *  - Space / Enter on the focused button toggles (start latched / stop). An
 *    assistive-tech click (no pointer, `detail === 0`) does the same.
 *  - Esc cancels: nothing is inserted. Only an Esc nothing else claimed (an
 *    open dialog, popover, menu or picker keeps its own; see isVoiceEscape).
 *  - While listening, `transcript` is the words so far (the finalized part and
 *    the interim tail); the composer previews them at the caret. On stop the
 *    desktop finalizes and `voice://ended` carries the whole text, which goes
 *    to `onCommit` once.
 *  - Read-aloud is held off for the whole session (mic-guard): the desktop
 *    cancels speech when dictation starts, but a reply that starts reading
 *    later would play into the mic and be transcribed into the composer.
 *  - `stt-dictate-start` clicks once, when the transcriber is up and listening:
 *    voice_start has resolved AND the desktop has said local-stt is ready
 *    (`ready: true` on voice://state from a desktop with voice_status
 *    `readyFlag`; before that, a state past `starting`; see
 *    isVoiceReadyEvent), in either order. voice_start alone only
 *    means the mic opened: a cold start can take seconds more. Until then the
 *    phase stays `starting`; a session that ends first never clicks. The mic
 *    is open by then and page audio isn't in the canceller's reference, so
 *    the mic hears the click; it is short and wordless, so it should
 *    transcribe to nothing. (Muting around it, as voice mode does for its
 *    chime, would drop the first words of someone who talks as they press.)
 *  - `stt-dictate-end` clicks once when a session the user stopped (the mic
 *    clicked again or released, Space / Enter, stop(): Send while dictating)
 *    has ended: on voice://ended `stopped`, which the desktop sends only once
 *    it has let go of the mic, so the click can't land in the words it was
 *    finalizing. Only after the start click (a session stopped while still
 *    starting has neither). Never for Esc, an error or another end the user
 *    didn't ask for, a stop the desktop never answered (the words still
 *    commit after the timeout; a late click is worse than none), or when the
 *    mic went away mid-session, even after the user's stop (a capture would
 *    record the click).
 *
 * Every event is for this hook's own session id; a late event from an earlier
 * session is never seen (its listener is gone).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { tauriBridge, type VoiceEvent } from '@/lib/tauri-bridge'
import { isVoiceReadyEvent, newVoiceSessionId, splitTranscript, type DictationTranscript } from '@/lib/voice/dictation-text'
import { voiceEndedMessage, voiceRefusalInfo, voiceToast, type VoiceRefusalInfo } from '@/lib/voice/messages'
import { isVoiceEscape } from '@/lib/voice/escape'
import { VOICE_NOISE_PROFILE } from '@/lib/voice/settings'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'
import { playSound } from '@/lib/sounds/engine'
import { correctTranscriptText, primeVocabulary } from '@/lib/vocabulary/client'
import { getRemoveFillers, removeFillers } from '@/lib/voice/fillers'
import { finishSentence } from '@/lib/voice/punctuation'

/** A press shorter than this latches instead of holding. */
export const DICTATION_LATCH_MS = 300
/** After voice_stop is sent, how long to wait for `voice://ended` before
 *  committing what was heard. The desktop's worst case: a stop before
 *  local-stt is ready waits up to 3 s for it, then the finalize ack gets its
 *  own 1.5 s; plus IPC slack. */
export const DICTATION_STOP_TIMEOUT_MS = 5500

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'stopping'

export interface DictationButtonProps {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  onKeyUp: (e: React.KeyboardEvent<HTMLElement>) => void
  onClick: (e: React.MouseEvent<HTMLElement>) => void
}

export interface DictationHandle {
  phase: DictationPhase
  /** A session is live (starting, listening or finishing). */
  active: boolean
  /** Latched: listening until the next click. */
  latched: boolean
  /** The words so far, or null before any arrive. */
  transcript: DictationTranscript | null
  buttonProps: DictationButtonProps
  /** Start latched, or stop (keyboard / programmatic). */
  toggle: () => void
  stop: () => void
  cancel: () => void
  /** The microphone's level right now (raw RMS, `voice://level`), 0 when idle.
   *  For a glow sampled every frame: reading it never re-renders. */
  level: () => number
}

export interface UseDictationOptions {
  /** Dictation can start (desktop, local-stt ready, the mic free). Going false
   *  mid-session stops it (the words so far are kept; no end click). */
  enabled: boolean
  /** The dictated text, once, when a session ends with words. */
  onCommit: (text: string) => void
  /** voice_start was refused. `not_ready` → the caller offers set-up. */
  onRefused?: (refusal: VoiceRefusalInfo) => void
  /** Every session end, after `onCommit` (if it ran). `cancelled`: Esc,
   *  cancel(), or the desktop cancelled it (a refused start is not a cancel). */
  onFinish?: (how: { cancelled: boolean }) => void
  /** How the vocabulary log names it: the chat box (default) or Dictate anywhere. */
  surface?: 'dictation' | 'anywhere'
  /** Its own start and end clicks (on by default). Off for a caller that cues
   *  them itself (Dictate anywhere: only once a press is known to be a tap). */
  cues?: boolean
}

interface Session {
  /** The last finalized text corrected for the preview, and what it was corrected from (re-corrected only when it changes). */
  correctedFinal?: string
  correctedFinalFor?: string
  id: string
  unlisten: () => void
  started: Promise<boolean>
  stopping: boolean
  stopTimer: ReturnType<typeof setTimeout> | null
  lastText: string
  lastFinal: string
  /** Lifts this session's read-aloud hold. */
  releaseReadAloud: () => void
  /** voice_start resolved: the mic is open. */
  opened: boolean
  /** The desktop reported the transcriber up and listening. */
  ready: boolean
  /** The start click has played. */
  cued: boolean
  /** The user stopped it: the end click plays once the desktop has ended it
   *  (dropped if the mic goes away first). */
  endCue: boolean
}

interface Press {
  /** This press started the session (vs. a press on a latched one). */
  startedSession: boolean
  at: number
}

const isToggleKey = (key: string) => key === ' ' || key === 'Enter' || key === 'Spacebar'

export function useDictation({ enabled, onCommit, onRefused, onFinish, surface = 'dictation', cues = true }: UseDictationOptions): DictationHandle {
  const cuesRef = useRef(cues)
  cuesRef.current = cues
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [latched, setLatched] = useState(false)
  const [transcript, setTranscript] = useState<DictationTranscript | null>(null)

  const sessionRef = useRef<Session | null>(null)
  const pressRef = useRef<Press | null>(null)
  const lastKeyToggleRef = useRef(0)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const levelRef = useRef(0)
  const level = useCallback(() => (sessionRef.current ? levelRef.current : 0), [])
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const onRefusedRef = useRef(onRefused)
  onRefusedRef.current = onRefused
  const onFinishRef = useRef(onFinish)
  onFinishRef.current = onFinish
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  /** End the session locally; commit `text` when it has words. */
  const finish = useCallback((s: Session, text: string | null, cancelled = text === null) => {
    if (sessionRef.current !== s) return
    sessionRef.current = null
    pressRef.current = null
    s.unlisten()
    if (s.stopTimer) clearTimeout(s.stopTimer)
    s.releaseReadAloud()
    setPhase('idle')
    setLatched(false)
    setTranscript(null)
    // Custom vocabulary: the committed text is corrected by sound ("Superbase" → Supabase).
    let words = text?.trim() ? correctTranscriptText(text.trim(), { surface: surfaceRef.current, sessionId: s.id }) : ''
    // Settings → Dictation → Remove filler words (on unless turned off).
    if (words && getRemoveFillers()) words = removeFillers(words)
    // The engine never ends a dictation with a full stop (@/lib/voice/punctuation).
    if (words) words = finishSentence(words)
    if (words) onCommitRef.current(words)
    onFinishRef.current?.({ cancelled })
  }, [])

  /** Listening once the mic is open and the transcriber ready, whichever
   *  lands last (once: the click). */
  const goLive = useCallback((s: Session) => {
    if (sessionRef.current !== s || s.stopping || !s.opened || !s.ready) return
    setPhase('listening')
    if (!s.cued) {
      s.cued = true
      if (cuesRef.current) playSound('stt-dictate-start')
    }
  }, [])

  const onEvent = useCallback(
    (s: Session, ev: VoiceEvent) => {
      if (sessionRef.current !== s) return
      if (ev.type === 'level') {
        levelRef.current = ev.mic
        return
      }
      if (ev.type === 'transcript') {
        s.lastText = ev.text
        if (ev.final) s.lastFinal = ev.text
        const split = splitTranscript(ev.text, s.lastFinal)
        if (s.correctedFinalFor !== split.final) {
          s.correctedFinalFor = split.final
          const corrected = correctTranscriptText(split.final)
          s.correctedFinal = getRemoveFillers() ? removeFillers(corrected) : corrected
        }
        setTranscript({ final: s.correctedFinal ?? split.final, interim: getRemoveFillers() ? removeFillers(split.interim) : split.interim })
      } else if (ev.type === 'state') {
        if (isVoiceReadyEvent(ev)) {
          s.ready = true
          goLive(s)
        }
      } else if (ev.type === 'ended') {
        if (ev.reason === 'cancelled') return finish(s, null)
        if (ev.reason !== 'stopped') {
          const message = voiceEndedMessage(ev.reason, 'dictation')
          if (message) voiceToast(message)
        }
        // A stop hands back the whole text; any other end keeps what was
        // already final (the interim tail was never confirmed).
        finish(s, ev.text ?? (ev.reason === 'stopped' ? s.lastText : s.lastFinal))
        // The desktop has let go of the mic by now: it can't hear the click.
        if (ev.reason === 'stopped' && s.endCue && s.cued && cuesRef.current) playSound('stt-dictate-end')
      }
    },
    [finish, goLive],
  )

  const start = useCallback(
    (latch: boolean) => {
      if (sessionRef.current || !enabledRef.current) return
      void primeVocabulary()
      const id = newVoiceSessionId('dictation')
      const s: Session = {
        id,
        unlisten: () => {},
        started: Promise.resolve(false),
        stopping: false,
        stopTimer: null,
        lastText: '',
        lastFinal: '',
        // Silence read-aloud now and keep it off until this session ends. Not a
        // mic claim: that would block dictation itself (useVoiceAvailability).
        releaseReadAloud: holdReadAloud({ mic: false }),
        opened: false,
        ready: false,
        cued: false,
        endCue: false,
      }
      sessionRef.current = s
      setPhase('starting')
      setLatched(latch)
      setTranscript(null)
      // Listen first: the desktop may emit before voice_start resolves.
      s.unlisten = tauriBridge.onVoiceEvent(id, (ev) => onEvent(s, ev))
      // The same room as voice mode: turns by speech alone, never by level.
      s.started = tauriBridge.voiceStart({ sessionId: id, mode: 'dictation', noiseProfile: VOICE_NOISE_PROFILE }).then(
        () => {
          s.opened = true
          goLive(s)
          return true
        },
        (err: unknown) => {
          finish(s, null, false)
          onRefusedRef.current?.(voiceRefusalInfo(err))
          return false
        },
      )
    },
    [finish, onEvent, goLive],
  )

  const stop = useCallback(() => {
    const s = sessionRef.current
    if (!s || s.stopping) return
    s.stopping = true
    s.endCue = true
    pressRef.current = null
    setPhase('stopping')
    setLatched(false)
    void s.started.then((ok) => {
      // A refused start already finished the session; a cancel may have too.
      if (!ok || sessionRef.current !== s) return
      void tauriBridge.voiceStop(s.id)
      // The desktop answers with voice://ended; if it never does, keep the
      // words. Armed only now: the desktop's worst case counts from voice_stop.
      s.stopTimer = setTimeout(() => finish(s, s.lastText), DICTATION_STOP_TIMEOUT_MS)
    })
  }, [finish])

  const cancel = useCallback(() => {
    const s = sessionRef.current
    if (!s) return
    finish(s, null)
    // After voice_start settles, so a start still in flight can't outlive it.
    void s.started.then((ok) => {
      if (ok) void tauriBridge.voiceCancel(s.id)
    })
  }, [finish])

  const toggle = useCallback(() => {
    if (sessionRef.current) stop()
    else start(true)
  }, [start, stop])

  // ── Pointer: hold-to-talk or click-to-latch ──────────────────────────────
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {
        /* capture is best effort (the pointerup still reaches us on the button) */
      }
      if (sessionRef.current) {
        pressRef.current = { startedSession: false, at: Date.now() }
        return
      }
      if (!enabledRef.current) return
      pressRef.current = { startedSession: true, at: Date.now() }
      start(false)
    },
    [start],
  )

  const onPointerUp = useCallback(() => {
    const press = pressRef.current
    pressRef.current = null
    if (!press || !sessionRef.current) return
    if (press.startedSession && Date.now() - press.at < DICTATION_LATCH_MS) {
      setLatched(true)
      return
    }
    stop()
  }, [stop])

  // Keep focus where it is (the field keeps the caret while you dictate).
  const onMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => e.preventDefault(), [])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (!isToggleKey(e.key)) return
      e.preventDefault()
      if (e.repeat) return
      lastKeyToggleRef.current = Date.now()
      toggle()
    },
    [toggle],
  )

  // Space activates a button on keyup; the keydown already toggled.
  const onKeyUp = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (isToggleKey(e.key)) e.preventDefault()
  }, [])

  // A click without a pointer (VoiceOver, a synthetic click) toggles; pointer
  // clicks were already handled by pointerdown/up.
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.detail !== 0) return
      if (Date.now() - lastKeyToggleRef.current < 500) return
      toggle()
    },
    [toggle],
  )

  // ── Esc cancels ──────────────────────────────────────────────────────────
  const active = phase !== 'idle'
  // Bubble phase on document, so a dialog, popover or picker handles its own
  // Esc first (see isVoiceEscape); the event goes on to others untouched.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceEscape(e)) return
      e.preventDefault()
      cancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, cancel])

  // ── The mic went away (a capture started, Voice ID enrolling): stop ──────
  // Without the end click, even for a stop of the user's still finishing: a
  // capture would record it.
  useEffect(() => {
    const s = sessionRef.current
    if (enabled || !s) return
    stop()
    s.endCue = false
  }, [enabled, stop])

  // ── Unmount: cancel ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      const s = sessionRef.current
      if (!s) return
      sessionRef.current = null
      s.unlisten()
      if (s.stopTimer) clearTimeout(s.stopTimer)
      s.releaseReadAloud()
      void s.started.then((ok) => {
        if (ok) void tauriBridge.voiceCancel(s.id)
      })
    }
  }, [])

  const buttonProps = useMemo<DictationButtonProps>(
    () => ({ onPointerDown, onPointerUp, onPointerCancel: onPointerUp, onMouseDown, onKeyDown, onKeyUp, onClick }),
    [onPointerDown, onPointerUp, onMouseDown, onKeyDown, onKeyUp, onClick],
  )

  return useMemo(
    () => ({ phase, active, latched, transcript, buttonProps, toggle, stop, cancel, level }),
    [phase, active, latched, transcript, buttonProps, toggle, stop, cancel, level],
  )
}
