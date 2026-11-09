'use client'

/**
 * Voice mode for one ChatPanel (docs/plans/chat-voice.md §3.4): a live spoken
 * conversation. The desktop listens, decides when the user's turn ends and
 * emits `voice://turn`; this hook sends that turn through the panel's own send
 * path and has the reply read aloud through the read-aloud pipeline.
 *
 *  - start(): a `conversation` session, with the Voice mode settings
 *    (pause before sending → endSilenceMs; bargeIn is always on).
 *  - voice://turn: if the previous reply is still submitted/streaming, stop()
 *    it first (a false barge-in never kills a reply: only a turn that is
 *    actually sent does), then read-aloud follows the next turn whatever the
 *    auto-read setting, and the text goes out via `sendTurn` (the same body
 *    as every other send).
 *  - voice://interrupted: the desktop already cancelled the speech; drop the
 *    queued sentences.
 *  - The session ends on end() (the stop square in send's slot), Esc (one
 *    nothing else claimed: an open dialog, popover or menu keeps its own),
 *    voice://ended, unmount,
 *    the panel going inactive (tab switch), a chat switch (`chatKey`), or the
 *    mic going to a capture / Voice ID enrollment.
 *  - interrupt() (a tap on the composer's field) works whenever the agent
 *    speaks: talking over it only works with echo cancelled (or headphones).
 *  - The intro means "the model is up, talk now", so it waits for both:
 *    voice_start resolved (the mic is open) AND the desktop said local-stt is
 *    ready (`ready: true` on voice://state from a desktop with voice_status
 *    `readyFlag`, even under `muted` or speech that began while loading;
 *    before that, a state past `starting`; see isVoiceReadyEvent), in either
 *    order. A cold start can take
 *    seconds after voice_start; meanwhile the phase stays Starting…, and a
 *    session that never gets there has no chime and no greeting. From then
 *    on the mic listens (nothing mutes it for the intro): the
 *    `voice-chat-start` chime plays, and a greeting is spoken through
 *    read-aloud (`speakLine`: agent speech, never a chat message or a turn)
 *    GREETING_LEAD_MS before the chime ends, over its quiet tail.
 *  - The user comes first: once they have started talking (a desktop state
 *    `user_speaking` or `processing`, a transcript, a turn, a barge-in) the
 *    greeting is skipped, and one already sent is stopped at once (that
 *    line only; a reply that took over is left alone). The greeting is
 *    marked an aside (voice_set_aside): on headphones the desktop lets the
 *    user talk over it before echo cancellation allows barge-in, and keeps
 *    their words from the first. On laptop speakers it plays out (its echo
 *    can't be told from the user), and the chime itself (page audio, not in
 *    the canceller's reference) may pass for speech there: then the
 *    greeting is skipped, and the chime, having no words, is never a turn.
 *    Either way the desktop gets the greeting's text with the aside: speech
 *    over it is kept from its onset (on speakers, when the user is still
 *    talking as it ends), less the greeting's own words heard back.
 *  - Sound effects off: no chime, the greeting speaks at once. No
 *    read-aloud: no greeting.
 *  - A mute before the model is up stays here until it is: on 0.2.45 the
 *    desktop's `muted` state would hide readiness (with `readyFlag` it
 *    wouldn't, but one path for both is simpler). The intro sends it, and
 *    the chime and greeting still play with the mic muted.
 *  - `voice-chat-end` plays when a session that went live (the intro began)
 *    ends (the stop, Esc, an error, the desktop ending it), except when a
 *    capture or Voice ID takes the mic (it would be recorded) or the page
 *    went away. Ending during the intro stops the chime and cancels the
 *    greeting. A session that ends while still starting has neither cue.
 *  - While a session lives, alert sounds stay quiet in every window
 *    (holdSoundQuiet: a Web Lock other windows see).
 *  - One conversation per page (../lib/voice/session-claim): starting one
 *    ends any other useVoiceMode's (the composer's, a bot bubble's) at once,
 *    with no end cue, before the desktop replaces it.
 *  - Voice focus (../lib/voice/voice-focus): with a desktop that sends speech
 *    audio and a trained voiceprint, the session asks for it. With Voice
 *    focus on, each turn waits (at most VOICE_FOCUS.VERDICT_WAIT_MS, then it
 *    goes anyway) on whose voice it was, in the turn chain, before anything
 *    else happens to it (interceptTurn included); a voice Native Intelligence doesn't know
 *    is dropped like an intercepted turn (nothing sent, no reply stopped,
 *    read-aloud follows nothing) and the field says so briefly
 *    (`live.notice`). Off, a turn goes exactly as without it (interceptTurn
 *    at once) and its score is only logged.
 *  - `greeting: false` plays the chime alone (a bot bubble: the bot has
 *    already said what it has). `interceptTurn` sees each spoken turn first:
 *    one it handles (a bubble's "yes" / "next") is never sent, stops no reply
 *    and makes read-aloud follow nothing.
 *
 * Mic/agent levels (~15 Hz) and the words heard this turn go to a small
 * external store (`live`) that only the composer's glow and transcript preview
 * subscribe to, so ChatPanel never re-renders at audio rate.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  tauriBridge,
  type VoiceEchoState,
  type VoiceEvent,
  type VoiceSessionState,
} from '@/lib/tauri-bridge'
import { speechOutput } from '@/lib/speech-output'
import type { ReadAloudHandle } from '@/hooks/use-read-aloud'
import { isVoiceReadyEvent, newVoiceSessionId, splitTranscript, type DictationTranscript } from '@/lib/voice/dictation-text'
import { voiceStartOptions } from '@/lib/voice/settings'
import { voiceEndedMessage, voiceRefusalInfo, voiceToast, type VoiceRefusalInfo } from '@/lib/voice/messages'
import { isVoiceEscape } from '@/lib/voice/escape'
import { pickGreeting } from '@/lib/voice/greeting'
import { playSound, type SoundHandle } from '@/lib/sounds/engine'
import { getSoundEffectsEnabled } from '@/lib/sounds/settings'
import { holdSoundQuiet } from '@/lib/sounds/quiet'
import { claimVoiceSession, releaseVoiceSession } from '@/lib/voice/session-claim'
import {
  openVoiceFocus,
  prepareVoiceFocus,
  VOICE_FOCUS_IGNORED,
  type VoiceFocusAction,
  type VoiceFocusGate,
} from '@/lib/voice/voice-focus'
import { correctTranscriptText, primeVocabulary } from '@/lib/vocabulary/client'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'
const isBusy = (s: ChatStatus) => s === 'submitted' || s === 'streaming'

/** The intro's timing (tune by ear; see the module doc). */
export const VOICE_INTRO_TIMING = {
  /** Send the greeting this long before the chime ends: the chime's last
   *  ~450 ms is a quiet tail, and the engine needs ~50 ms to first audio. */
  GREETING_LEAD_MS: 350,
}

/** How long the field says a turn was ignored (Voice focus). */
export const VOICE_NOTICE_MS = 3000

/** Where the conversation is: the composer's glow shows it, and a hidden live
 *  region announces it (VOICE_PHASE_LABEL). */
export type VoicePhase = 'starting' | 'listening' | 'thinking' | 'speaking' | 'muted'

export const VOICE_PHASE_LABEL: Record<VoicePhase, string> = {
  starting: 'Starting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
  muted: 'Muted',
}

export interface VoiceLive {
  mic: number
  agent: number
  /** The user's words so far this turn, split like dictation's (the
   *  finalized part and the interim tail). Null once the turn ends. */
  transcript: DictationTranscript | null
  /** A quiet line for the field while no words are heard (a turn Voice
   *  focus ignored), or null. */
  notice?: string | null
}

/** A tiny external store for audio-rate data. */
export interface VoiceLiveStore {
  subscribe: (listener: () => void) => () => void
  get: () => VoiceLive
}

const IDLE_LIVE: VoiceLive = Object.freeze({ mic: 0, agent: 0, transcript: null }) as VoiceLive

function createLiveStore() {
  let value: VoiceLive = IDLE_LIVE
  const listeners = new Set<() => void>()
  const store: VoiceLiveStore & { set: (patch: Partial<VoiceLive>) => void; reset: () => void } = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => value,
    set: (patch) => {
      value = { ...value, ...patch }
      for (const l of [...listeners]) l()
    },
    reset: () => {
      if (value === IDLE_LIVE) return
      value = IDLE_LIVE
      for (const l of [...listeners]) l()
    },
  }
  return store
}

export interface VoiceModeHandle {
  /** A voice mode session is live in this panel. */
  active: boolean
  phase: VoicePhase
  /** The desktop's echo state (whether talking can interrupt the agent). */
  echo: VoiceEchoState
  muted: boolean
  /** The agent is speaking a reply (desktop state or read-aloud). */
  agentSpeaking: boolean
  live: VoiceLiveStore
  /** Start voice mode. Resolves null once started, or the refusal. */
  start: () => Promise<VoiceRefusalInfo | null>
  /** End voice mode (the stop in send's slot, Esc). */
  end: () => void
  toggleMute: () => void
  /** Tap to interrupt: stop the agent's speech and drop its queued sentences. */
  interrupt: () => void
}

export interface UseVoiceModeOptions {
  /** Voice mode can start (desktop, both modules ready, the mic free). */
  canStart: boolean
  /** The mic belongs to a capture or Voice ID now: end any session. */
  blocked: boolean
  /** The panel is the visible one; going false ends the session. */
  active: boolean
  /** The chat this panel shows; a change ends the session. */
  chatKey: string
  status: ChatStatus
  /** useChat's stop(). */
  stop: () => Promise<void> | void
  /** The panel's send path, with the spoken text. */
  sendTurn: (text: string) => Promise<void> | void
  readAloud: ReadAloudHandle
  /** Speak a greeting once the session is live (default true); false: the chime alone. */
  greeting?: boolean
  /** A spoken turn, before anything else: true when it was handled here and must not be sent. */
  interceptTurn?: (text: string) => boolean
}

interface Session {
  id: string
  unlisten: () => void
  started: Promise<boolean>
  /** The turn the transcript belongs to, and its last `final: true` text. */
  turnId: string
  lastFinal: string
  /** voice_start resolved while this was the session: the mic is open. */
  opened: boolean
  /** The desktop reported the transcriber up and listening. */
  ready: boolean
  /** Opened and ready: the intro began, and the end cue plays for it (a
   *  refused, abandoned or never-ready start has none). */
  live: boolean
  /** Lifts this session's quiet hold on alert sounds. */
  releaseQuiet: () => void
  intro: Intro | null
  /** The user started talking once the session was live (no greeting). */
  userSpoke: boolean
  /** voice_set_muted calls, one after another: two in flight could land in
   *  either order and leave the mic muted. */
  muteChain: Promise<void>
  /** Voice focus for this session (null: it doesn't ask for speech audio). */
  focus: VoiceFocusGate | null
  /** Clears `live.notice`. */
  noticeTimer: ReturnType<typeof setTimeout> | null
}

/** Mute or unmute the session at the desktop, in call order. */
function setDesktopMuted(s: Session, muted: boolean) {
  s.muteChain = s.muteChain.then(() => tauriBridge.voiceSetMuted(s.id, muted)).catch(() => {})
}

/** The start chime and the greeting. */
interface Intro {
  chime: SoundHandle | null
  greeted: boolean
  /** The greeting's read-aloud id while it may be playing. */
  greetingId: string | null
  /** Read-aloud has shown the greeting as speaking: once it no longer does,
   *  the greeting is over. */
  greetingShown: boolean
  cancelled: boolean
}

interface SessionView {
  id: string
  state: VoiceSessionState
  echo: VoiceEchoState
  /** The user's mute. */
  muted: boolean
  /** The session went live (mic open, model ready): Starting… until then. */
  live: boolean
}

export function useVoiceMode(opts: UseVoiceModeOptions): VoiceModeHandle {
  const { canStart, blocked, active, chatKey, status, readAloud } = opts
  const [view, setView] = useState<SessionView | null>(null)
  /** This hook's identity in the page's one voice conversation (session-claim). */
  const ownerRef = useRef<object>({})

  const liveRef = useRef<ReturnType<typeof createLiveStore> | null>(null)
  if (!liveRef.current) liveRef.current = createLiveStore()
  const live = liveRef.current

  const sessionRef = useRef<Session | null>(null)
  const turnChainRef = useRef<Promise<void>>(Promise.resolve())
  const statusRef = useRef(status)
  statusRef.current = status
  const stopRef = useRef(opts.stop)
  stopRef.current = opts.stop
  const sendTurnRef = useRef(opts.sendTurn)
  sendTurnRef.current = opts.sendTurn
  const readAloudRef = useRef(readAloud)
  readAloudRef.current = readAloud
  const canStartRef = useRef(canStart)
  canStartRef.current = canStart
  const viewRef = useRef(view)
  viewRef.current = view
  const greetingRef = useRef(opts.greeting ?? true)
  greetingRef.current = opts.greeting ?? true
  const interceptRef = useRef(opts.interceptTurn)
  interceptRef.current = opts.interceptTurn

  /** Forget the session here (the desktop side is ended by the caller).
   *  `cue: false` when the end cue would be recorded (a capture or Voice ID
   *  took the mic) or nobody is left to hear it. */
  const endLocal = useCallback(
    (s: Session, { cue = true }: { cue?: boolean } = {}) => {
      if (sessionRef.current !== s) return false
      sessionRef.current = null
      releaseVoiceSession(ownerRef.current)
      s.unlisten()
      s.focus?.dispose()
      if (s.noticeTimer) clearTimeout(s.noticeTimer)
      s.releaseQuiet()
      const intro = s.intro
      if (intro) {
        intro.cancelled = true
        intro.chime?.stop()
        // The greeting goes with the session.
        if (intro.greetingId && readAloudRef.current.speakingMessageId === intro.greetingId) {
          readAloudRef.current.stop()
        }
      }
      setView(null)
      live.reset()
      if (s.live && cue) playSound('voice-chat-end')
      return true
    },
    [live],
  )

  /** A user-side end: silence the reply too, and tell the desktop. */
  const endSession = useCallback(
    (how: 'stop' | 'cancel', opts: { cue?: boolean } = {}) => {
      const s = sessionRef.current
      if (!s || !endLocal(s, opts)) return
      readAloudRef.current.stop()
      void s.started.then((ok) => {
        if (!ok) return
        if (how === 'stop') void tauriBridge.voiceStop(s.id)
        else void tauriBridge.voiceCancel(s.id)
      })
    },
    [endLocal],
  )
  const endSessionRef = useRef(endSession)
  endSessionRef.current = endSession

  /** The field says, for a moment, that a turn was ignored (words of the
   *  next turn, already coming, show instead: they clear it). */
  const showNotice = useCallback(
    (s: Session, notice: string) => {
      if (s.noticeTimer) clearTimeout(s.noticeTimer)
      if (live.get().transcript) return
      live.set({ notice })
      s.noticeTimer = setTimeout(() => {
        s.noticeTimer = null
        if (sessionRef.current === s && live.get().notice === notice) live.set({ notice: null })
      }, VOICE_NOTICE_MS)
    },
    [live],
  )

  /** A turn the desktop ended. With Voice focus, `verdict` says (in the
   *  chain, so turns stay in order) whether it goes at all; a dropped one is
   *  never offered to interceptTurn, stops nothing and is followed by nothing. */
  const sendSpokenTurn = useCallback(
    (s: Session, text: string, verdict: Promise<VoiceFocusAction> | null = null) => {
      // The turn is over: the field is clean for the next one.
      s.lastFinal = ''
      live.set({ transcript: null })
      // Custom vocabulary: the spoken turn is corrected by sound before it is sent.
      const words = correctTranscriptText(text.trim(), { surface: 'voice', sessionId: s.id })
      if (!words) return
      turnChainRef.current = turnChainRef.current
        .then(async () => {
          if (verdict) {
            const action = await verdict
            if (sessionRef.current !== s) return
            if (action === 'drop') {
              showNotice(s, VOICE_FOCUS_IGNORED)
              return
            }
            // Handled where it was said (a bubble's "yes"): never sent.
            if (interceptRef.current?.(words)) return
          }
          if (sessionRef.current !== s) return
          // The previous reply is still generating: this turn replaces it.
          if (isBusy(statusRef.current)) await stopRef.current()
          if (sessionRef.current !== s) return
          readAloudRef.current.followNextTurn()
          await sendTurnRef.current(words)
        })
        .catch((err: unknown) => {
          console.error('[voice] sending a spoken turn failed:', err)
        })
    },
    [live, showNotice],
  )

  /** The chime, then the greeting (unless the user got in first). The mic
   *  listens throughout. */
  const beginIntro = useCallback((s: Session) => {
    const intro: Intro = {
      chime: null,
      greeted: false,
      greetingId: null,
      greetingShown: false,
      cancelled: false,
    }
    s.intro = intro
    // A mute the user tapped before the model was up reaches the desktop now.
    if (viewRef.current?.muted) setDesktopMuted(s, true)

    const greet = () => {
      if (intro.greeted || intro.cancelled || sessionRef.current !== s) return
      intro.greeted = true
      // No greeting asked for, or the user is already talking: they come first.
      if (!greetingRef.current || s.userSpoke) return
      const readAloud = readAloudRef.current
      // No TTS: no greeting. A reply being generated or read is the agent's
      // voice already.
      if (!readAloud.supported || readAloud.speakingMessageId !== null || isBusy(statusRef.current)) return
      // An aside: the user may talk over it (the desktop, on headphones),
      // and its words heard back on the mic are never part of their turn.
      const line = pickGreeting()
      void tauriBridge.voiceSetAside(s.id, true, line)
      intro.greetingId = readAloud.speakLine(line)
      if (!intro.greetingId) void tauriBridge.voiceSetAside(s.id, false)
    }

    // Sound effects off: no chime, the greeting at once.
    if (!getSoundEffectsEnabled()) {
      greet()
      return
    }
    const chime = playSound('voice-chat-start')
    intro.chime = chime
    // No chime after all (audio unavailable): the greeting at once.
    void chime.started.then((playing) => {
      if (!playing) greet()
    })
    void chime.nearEnd(VOICE_INTRO_TIMING.GREETING_LEAD_MS).then(greet)
    void chime.ended.then(greet)
  }, [])

  /** The user started talking: no greeting from now, and one already sent
   *  stops now (that line only, never a reply that took over). */
  const userStarted = useCallback((s: Session) => {
    s.userSpoke = true
    const intro = s.intro
    const id = intro?.greetingId
    if (!intro || !id) return
    intro.greetingId = null
    const readAloud = readAloudRef.current
    // Showing the greeting, or not yet showing anything (it was just sent).
    if (readAloud.speakingMessageId === id || (readAloud.speakingMessageId === null && !intro.greetingShown)) {
      readAloud.stop()
    }
    void tauriBridge.voiceSetAside(s.id, false)
  }, [])

  /** Read-aloud shows `speakingId` as speaking: the greeting shown, or over. */
  const trackGreeting = useCallback((s: Session, speakingId: string | null) => {
    const intro = s.intro
    if (!intro?.greetingId) return
    if (speakingId === intro.greetingId) intro.greetingShown = true
    else if (intro.greetingShown) intro.greetingId = null
  }, [])

  /** The mic is open and the model ready, whichever lands last: the intro. */
  const goLive = useCallback(
    (s: Session) => {
      if (s.live || !s.opened || !s.ready || sessionRef.current !== s) return
      s.live = true
      setView((v) => (v && v.id === s.id ? { ...v, live: true } : v))
      beginIntro(s)
    },
    [beginIntro],
  )

  const onEvent = useCallback(
    (s: Session, ev: VoiceEvent) => {
      if (sessionRef.current !== s) return
      switch (ev.type) {
        case 'state': {
          setView((v) => (v && v.id === s.id ? { ...v, state: ev.state, echo: ev.echo } : v))
          const talking = ev.state === 'user_speaking' || ev.state === 'processing'
          if (!s.ready && isVoiceReadyEvent(ev)) {
            s.ready = true
            // Already talking as the model comes up: no greeting (with no
            // chime it would go out right now).
            if (talking) s.userSpoke = true
            goLive(s)
          }
          if (s.live && talking) userStarted(s)
          return
        }
        case 'level':
          live.set({ mic: ev.mic, agent: ev.agent })
          return
        case 'transcript':
          if (ev.turnId !== s.turnId) {
            s.turnId = ev.turnId
            s.lastFinal = ''
          }
          if (ev.final) s.lastFinal = ev.text
          live.set({ transcript: splitTranscript(ev.text, s.lastFinal), notice: null })
          if (s.live && ev.text.trim()) userStarted(s)
          return
        case 'speech':
          s.focus?.onSpeech(ev)
          return
        case 'turn': {
          userStarted(s)
          const words = ev.text.trim()
          const focus = s.focus
          if (focus && words && focus.focusOn()) {
            // Whose voice first; interceptTurn then sees it in the chain.
            sendSpokenTurn(s, ev.text, focus.judge(ev.turnId))
            return
          }
          // Voice focus off (or none): exactly as without it; the turn's
          // score is only logged.
          if (focus) {
            if (words) focus.observe(ev.turnId)
            else focus.skip(ev.turnId)
          }
          // Handled where it was said (a bubble's "yes"): never sent.
          if (words && interceptRef.current?.(words)) {
            s.lastFinal = ''
            live.set({ transcript: null })
            return
          }
          sendSpokenTurn(s, ev.text)
          return
        }
        case 'interrupted': {
          // The desktop already cancelled the speech (the greeting too).
          if (s.intro) s.intro.greetingId = null
          readAloudRef.current.interrupt()
          if (s.live) userStarted(s)
          return
        }
        case 'ended': {
          // A capture took the mic (the cue would be recorded) or the page left.
          endLocal(s, { cue: ev.reason !== 'recording' && ev.reason !== 'page' })
          if (ev.reason === 'stopped' || ev.reason === 'cancelled') return
          // An idle end while a reply is still coming: the desktop can't see
          // the web waiting on the agent (a long tool-calling turn).
          const message = voiceEndedMessage(ev.reason, 'conversation', { replyPending: isBusy(statusRef.current) })
          if (message) voiceToast(message)
          return
        }
      }
    },
    [endLocal, goLive, live, sendSpokenTurn, userStarted],
  )

  const start = useCallback(async (): Promise<VoiceRefusalInfo | null> => {
    void primeVocabulary()
    if (sessionRef.current) return null
    if (!canStartRef.current) return { code: 'not_ready', detail: null }
    const id = newVoiceSessionId('conversation')
    const s: Session = {
      id,
      unlisten: () => {},
      started: Promise.resolve(false),
      turnId: '',
      lastFinal: '',
      opened: false,
      ready: false,
      live: false,
      // From now: the mic is opening.
      releaseQuiet: holdSoundQuiet('voice-mode'),
      intro: null,
      userSpoke: false,
      muteChain: Promise.resolve(),
      // A gate when the desktop sends speech audio and the user has a
      // voiceprint: the session asks for it.
      focus: openVoiceFocus(id),
      noticeTimer: null,
    }
    sessionRef.current = s
    // Any other conversation on this page ends now, quietly (its end cue would
    // play over this one's start).
    claimVoiceSession(ownerRef.current, () => endSessionRef.current('cancel', { cue: false }))
    setView({ id, state: 'starting', echo: 'converging', muted: false, live: false })
    // Listen first: the desktop may emit before voice_start resolves.
    s.unlisten = tauriBridge.onVoiceEvent(id, (ev) => onEvent(s, ev))
    let refusal: VoiceRefusalInfo | null = null
    const speech = s.focus ? { speechAudio: true } : {}
    s.started = tauriBridge.voiceStart({ sessionId: id, mode: 'conversation', ...voiceStartOptions(), ...speech }).then(
      () => true,
      (err: unknown) => {
        refusal = voiceRefusalInfo(err)
        endLocal(s)
        return false
      },
    )
    // The engine will be needed for the greeting and the first reply.
    void speechOutput.prepare()
    const ok = await s.started
    if (ok && sessionRef.current === s) {
      s.opened = true
      goLive(s)
    }
    return refusal
  }, [endLocal, onEvent, goLive])

  const end = useCallback(() => endSession('stop'), [endSession])

  const toggleMute = useCallback(() => {
    const s = sessionRef.current
    const v = viewRef.current
    if (!s || !v || v.id !== s.id) return
    const muted = !v.muted
    viewRef.current = { ...v, muted }
    setView((cur) => (cur && cur.id === s.id ? { ...cur, muted } : cur))
    void s.started.then((ok) => {
      // Before the model is up the desktop hears no mute (its muted state
      // would hide readiness): the intro sends the user's choice then.
      if (ok && s.live) setDesktopMuted(s, muted)
    })
  }, [])

  const interrupt = useCallback(() => {
    if (!sessionRef.current) return
    // Stops the sound now and drops the queue; the desktop sees the TTS
    // cancel and goes back to listening.
    readAloudRef.current.stop()
  }, [])

  // Voice focus: know the voiceprint before a start asks whether to want speech.
  useEffect(() => {
    if (canStart) prepareVoiceFocus()
  }, [canStart])

  // ── Ends: Esc, the panel going inactive, a chat switch, the mic taken ─────
  // Bubble phase on document, so a dialog, popover or menu handles its own
  // Esc first (see isVoiceEscape); the event goes on to others untouched.
  const isOn = view !== null
  useEffect(() => {
    if (!isOn) return
    const onKey = (e: KeyboardEvent) => {
      if (!isVoiceEscape(e)) return
      e.preventDefault()
      endSession('cancel')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOn, endSession])

  useEffect(() => {
    // The mic going to a capture / Voice ID: no end cue, it would be recorded.
    if (blocked) endSession('cancel', { cue: false })
    else if (!active) endSession('cancel')
  }, [active, blocked, endSession])

  const chatKeyRef = useRef(chatKey)
  useEffect(() => {
    if (chatKeyRef.current === chatKey) return
    chatKeyRef.current = chatKey
    endSession('cancel')
  }, [chatKey, endSession])

  useEffect(() => {
    return () => endSession('cancel')
  }, [endSession])

  // The greeting is over once read-aloud stops showing it.
  const speakingId = readAloud.speakingMessageId
  useEffect(() => {
    const s = sessionRef.current
    if (s) trackGreeting(s, speakingId)
  }, [speakingId, trackGreeting])

  // ── What the bar says ─────────────────────────────────────────────────────
  const busy = isBusy(status)
  const readingAloud = readAloud.speakingMessageId !== null
  const agentSpeaking = !!view && (view.state === 'agent_speaking' || (readingAloud && view.state !== 'user_speaking'))
  let phase: VoicePhase = 'listening'
  if (view) {
    if (view.muted) phase = 'muted'
    else if (view.state === 'muted') phase = 'muted'
    else if (!view.live || view.state === 'starting') phase = 'starting'
    else if (agentSpeaking) phase = 'speaking'
    else if (view.state === 'processing') phase = 'thinking'
    else if (view.state === 'user_speaking') phase = 'listening'
    else if (busy) phase = 'thinking'
  }

  return useMemo(
    () => ({
      active: !!view,
      phase,
      echo: view?.echo ?? 'converging',
      muted: !!view?.muted,
      agentSpeaking,
      live,
      start,
      end,
      toggleMute,
      interrupt,
    }),
    [view, phase, agentSpeaking, live, start, end, toggleMute, interrupt],
  )
}
