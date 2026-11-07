/**
 * Interactive mode's engine: listen mode that also listens for the user's
 * assistant by name (Liam, 2026-10-02: "kind of like our existing [chat voice]
 * mode … and the listening mode combined in one"). The host
 * (components/read-aloud/interactive-voice-host.tsx) runs one, app-wide, and
 * says when it may listen (setActive); everything it touches outside the
 * desktop's voice session comes in as deps, so the flow is tested on its own
 * (./__tests__/interactive-engine.test.ts).
 *
 * THE SESSION. While active, one `voice_start({ mode: 'interactive' })`
 * session, with the voice mode settings (pause; the quiet room). The
 * desktop never idle-ends it, emits every end of turn as `voice://turn` and
 * goes straight back to listening. An end the engine didn't ask for (the mic
 * stalled, an error, a capture taking the mic, the window closed to the tray
 * or reloaded, another session replacing it) starts it again after a back-off
 * (INTERACTIVE_TIMING.RESTART_*), as does a refused start, except
 * `mic_denied` (that needs the user); by then the host has usually made it
 * inactive (a capture, a hidden window), which cancels the restart. Inactive (the
 * host's call: Interactive off, voice mode or dictation running, a capture,
 * the window hidden), it is cancelled. The user's mute (setMuted) gates the
 * mic at the desktop and keeps the session.
 *
 * THE FLOW (stages; the mic button shows them, ./interactive-store):
 *   listening  The name heard in a partial transcript (./wake-word) → what
 *              listen mode reads is paused at once, keeping its place, and
 *              what the user is listening to is noted (deps.snapshot) →
 *              heard. A turn with the name → its request is sent (thinking),
 *              or, when it is only the name ("Joseph?"), "Yes?" is said and
 *              the next turn within REQUEST_WAIT_MS is the request
 *              (awaiting). A turn WITHOUT the name is dropped.
 *   heard      Its turn ends with the name: as above. Without it after all
 *              (the recogniser revised it), or no turn within HEARD_WAIT_MS:
 *              back to listening, and the reading resumes.
 *   thinking   Sent to the chat (deps.ask: the active chat panel, which reads
 *              the reply aloud). The reply starting to be read → answering;
 *              no word within REPLY_WAIT_MS → back to listening. No chat to
 *              take it: "I can't reach the chat right now", and back.
 *   answering  Barge policy `speech`: talking over the reply cuts it short
 *              (`voice://interrupted` → the panel stops reading it). The
 *              reply over (read to its end, cut short, or nothing to read) →
 *              follow-up. It failed → "Sorry, I couldn't get an answer.", and
 *              back to listening.
 *   follow-up  FOLLOW_UP_MS (each word heard extends it) in which a turn is
 *              sent WITHOUT the name, as it is while answering. Then barge
 *              policy `wake` again, back to listening, and the paused reading
 *              resumes where it stopped, unless the user has moved on to
 *              another item (or something else reads): listen mode's latest
 *              reader wins.
 *
 * THE ECHO GUARD: on laptop speakers, before the echo canceller converges,
 * the mic can carry the agent's own speech. Words that closely match what was
 * just said (deps.isEcho: the reading's sentences, the reply's) never wake it,
 * and never count as a follow-up turn: they are dropped like any other turn
 * that isn't the user's request.
 *
 * VOICE FOCUS (./voice-focus, deps.openFocus): with a desktop that sends
 * speech audio and a trained voiceprint, the session asks for it. With Voice
 * focus on, each turn waits (at most VOICE_FOCUS.VERDICT_WAIT_MS, then it
 * counts anyway) on whose voice it was before the flow sees it; turns stay in
 * order, and one whose session ends during the wait goes with it. A voice
 * Dial8 doesn't know is dropped like a turn without the name: the name in it
 * included (a partial that woke the flow goes back to listening, and the
 * reading resumes). Off, a turn is handled at once, exactly as without it,
 * and its score is only logged.
 *
 * PRIVACY: transcripts stay in memory, in this call only: a turn without the
 * name is dropped on the spot (never stored, logged or sent), and only a
 * request goes anywhere (to the user's own chat). Nothing here logs (Voice
 * focus logs ids and numbers, never words).
 */

import type { tauriBridge as TauriBridge, VoiceBargePolicy, VoiceEvent, VoiceNoiseProfile } from '@/lib/tauri-bridge'
import type { VoiceFocusGate } from './voice-focus'
import { newVoiceSessionId } from './dictation-text'
import { voiceRefusalCode } from './messages'
import { matchWakeWord } from './wake-word'
import type { InteractivePhase } from './interactive-store'
import type { VoiceAskContext, VoiceAskSnapshot } from './voice-ask'
import type { VoiceAskHandle, VoiceAskListeners, VoiceAskOutcome } from './voice-ask-delivery'

/** The flow's timing (tune by ear). */
export const INTERACTIVE_TIMING = {
  /** After the reply: this long to answer without the name. */
  FOLLOW_UP_MS: 8000,
  /** After "Yes?": the next turn within this long is the request. */
  REQUEST_WAIT_MS: 8000,
  /** The name heard in a partial: its turn within this long (since the last words), else it was nothing. */
  HEARD_WAIT_MS: 10_000,
  /** Sent, or being read: no word from the chat within this long → back to listening. */
  REPLY_WAIT_MS: 180_000,
  /** A session that ended on its own (or a refused start) starts again after this, doubling. */
  RESTART_MIN_MS: 1000,
  RESTART_MAX_MS: 30_000,
  /** A session that lasted this long ended for a new reason: the back-off starts over. */
  RESTART_RESET_MS: 30_000,
}

/** What the engine says out loud. */
export const INTERACTIVE_LINES = {
  ack: 'Yes?',
  unreachable: 'I can’t reach the chat right now.',
  failed: 'Sorry, I couldn’t get an answer.',
} as const

/** A reading the engine paused, to resume later. */
export interface PausedReading {
  key: string
}

export interface InteractiveDeps {
  bridge: Pick<typeof TauriBridge, 'voiceStart' | 'voiceCancel' | 'voiceSetMuted' | 'voiceSetBarge' | 'onVoiceEvent'>
  /** The assistant's name: the wake word (read each time). */
  getName: () => string
  /** The echo guard: is this the agent's own speech (the reading, a reply)
   *  coming back through the mic? (isEchoOf against recent speech.) */
  isEcho: (text: string) => boolean
  /** voice_start's settings. */
  startOptions: () => { endSilenceMs: number; noiseProfile: VoiceNoiseProfile }
  /** What the user is listening to now (the window in front's Listen item), or null. */
  snapshot: () => VoiceAskSnapshot | null
  /** Pause what listen mode reads now, keeping its place; what was paused, or null. */
  pauseReading: () => PausedReading | null
  /** Pick a paused reading up again, if it is still the item in front and nothing else reads. */
  resumeReading: (paused: PausedReading) => void
  /** Say a short line; resolves once it is over (or couldn't be said). */
  say: (text: string) => Promise<void>
  /** Hand a request to the chat; null when no chat took it. */
  ask: (text: string, voiceAsk: VoiceAskContext, listeners: VoiceAskListeners) => VoiceAskHandle | null
  /** Where the conversation is, for the mic button. */
  publish: (phase: InteractivePhase) => void
  /** Voice focus for a session about to start (openVoiceFocus), or null:
   *  then it asks for no speech audio and every turn counts. */
  openFocus?: (
    sessionId: string,
  ) => Pick<VoiceFocusGate, 'onSpeech' | 'focusOn' | 'judge' | 'observe' | 'skip' | 'dispose'> | null
}

type Stage = 'listening' | 'heard' | 'awaiting' | 'thinking' | 'answering' | 'follow-up'

interface Session {
  id: string
  unlisten: () => void
  /** voice_start resolved (true) or was refused (false). */
  started: Promise<boolean>
  opened: boolean
  /** When voice_start resolved (Date.now()). */
  openedAt: number
  /** The barge policy the desktop has (an interactive session starts with `wake`). */
  barge: VoiceBargePolicy
  /** voice_set_muted / voice_set_barge calls, in call order. */
  chain: Promise<void>
  /** Voice focus (null: none asked for). */
  focus: ReturnType<NonNullable<InteractiveDeps['openFocus']>>
  /** Turns waiting on their verdict, in order, and how many. */
  turns: Promise<void>
  waiting: number
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text)
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export class InteractiveEngine {
  private readonly deps: InteractiveDeps
  private active = false
  private muted = false
  private session: Session | null = null
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** Ended for the window going away: waits for windowReturned, no timer. */
  private awaitingReturn = false

  private stage: Stage = 'listening'
  private stageTimer: ReturnType<typeof setTimeout> | null = null
  /** The barge policy the flow wants now. */
  private policy: VoiceBargePolicy = 'wake'
  /** The reading paused by the name, to resume once the flow is over. */
  private paused: PausedReading | null = null
  /** A reading waiting to resume until a line being said is over. */
  private pendingResume: PausedReading | null = null
  /** What the user was listening to when they said the name. */
  private wokeOn: VoiceAskSnapshot | null = null
  /** The ask in the chat now, and its token (outcomes of an older one are ignored). */
  private ask: VoiceAskHandle | null = null
  private askToken: object | null = null

  constructor(deps: InteractiveDeps) {
    this.deps = deps
  }

  /** May it listen now (the host's conditions)? */
  setActive(active: boolean): void {
    if (active === this.active) return
    this.active = active
    this.awaitingReturn = false
    if (active) {
      this.failures = 0
      this.start()
      return
    }
    this.clearRestart()
    this.stopSession()
    this.resetFlow()
    this.publish()
  }

  /** The window came back to the user (focused, shown): a session the
   *  desktop ended for the window going away starts again. */
  windowReturned(): void {
    if (!this.awaitingReturn || !this.active || this.session) return
    this.awaitingReturn = false
    this.failures = 0
    this.start()
  }

  /** The user's mute: the mic gated at the desktop, the session kept. */
  setMuted(muted: boolean): void {
    if (muted === this.muted) return
    this.muted = muted
    const s = this.session
    if (s?.opened) this.queue(s, () => this.deps.bridge.voiceSetMuted(s.id, muted))
  }

  dispose(): void {
    this.setActive(false)
  }

  // ── The session ──────────────────────────────────────────────────────────

  private start(): void {
    if (!this.active || this.session) return
    this.clearRestart()
    const { bridge } = this.deps
    const id = newVoiceSessionId('interactive')
    const s: Session = {
      id,
      unlisten: () => {},
      started: Promise.resolve(false),
      opened: false,
      openedAt: 0,
      barge: 'wake',
      chain: Promise.resolve(),
      focus: this.deps.openFocus?.(id) ?? null,
      turns: Promise.resolve(),
      waiting: 0,
    }
    this.session = s
    // Listen first: the desktop may emit before voice_start resolves.
    s.unlisten = bridge.onVoiceEvent(id, (ev) => this.onEvent(s, ev))
    const speech = s.focus ? { speechAudio: true } : {}
    s.started = bridge.voiceStart({ sessionId: id, mode: 'interactive', ...this.deps.startOptions(), ...speech }).then(
      () => true,
      (err: unknown) => {
        if (this.session !== s) return false
        this.drop(s)
        // Microphone access needs the user; anything else may pass (another
        // window holding the voice, a capture, the modules still loading).
        if (voiceRefusalCode(err) !== 'mic_denied') this.scheduleRestart()
        this.publish()
        return false
      },
    )
    void s.started.then((ok) => {
      if (!ok || this.session !== s) return
      s.opened = true
      s.openedAt = Date.now()
      if (this.muted) this.queue(s, () => this.deps.bridge.voiceSetMuted(s.id, true))
      this.applyBarge()
      this.publish()
    })
    this.publish()
  }

  /** Forget the session here (the desktop side is the caller's). */
  private drop(s: Session): void {
    if (this.session !== s) return
    this.session = null
    s.unlisten()
    s.focus?.dispose()
  }

  private stopSession(): void {
    const s = this.session
    if (!s) return
    this.drop(s)
    // Cancelled, not stopped: nothing it heard is kept. A start still in
    // flight is cancelled once it lands.
    void s.started.then((ok) => {
      if (ok) void this.deps.bridge.voiceCancel(s.id)
    })
  }

  private scheduleRestart(): void {
    if (!this.active || this.restartTimer) return
    const { RESTART_MIN_MS, RESTART_MAX_MS } = INTERACTIVE_TIMING
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** this.failures)
    this.failures++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
  }

  private clearRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  /** One desktop call after another, so two never land out of order. */
  private queue(s: Session, call: () => Promise<void>): void {
    s.chain = s.chain.then(call).catch(() => {})
  }

  private setBarge(policy: VoiceBargePolicy): void {
    this.policy = policy
    this.applyBarge()
  }

  private applyBarge(): void {
    const s = this.session
    const policy = this.policy
    if (!s?.opened || s.barge === policy) return
    s.barge = policy
    this.queue(s, () => this.deps.bridge.voiceSetBarge(s.id, policy))
  }

  private onEvent(s: Session, ev: VoiceEvent): void {
    if (this.session !== s) return
    switch (ev.type) {
      case 'transcript':
        this.onWords(ev.text)
        return
      case 'speech':
        s.focus?.onSpeech(ev)
        return
      case 'turn': {
        const focus = s.focus
        const words = hasWords(ev.text)
        // Voice focus off (or none), nothing still waiting on a verdict:
        // exactly as without it; the turn's score is only logged.
        if (!focus || (!focus.focusOn() && s.waiting === 0)) {
          if (focus) {
            if (words) focus.observe(ev.turnId)
            else focus.skip(ev.turnId)
          }
          this.onTurn(ev.text)
          return
        }
        // In its place in the order. Nothing to judge without words; off
        // (turned off while one still waits), only logged.
        let verdict: Promise<'send' | 'drop'> = Promise.resolve('send')
        if (!words) focus.skip(ev.turnId)
        else if (focus.focusOn()) verdict = focus.judge(ev.turnId)
        else focus.observe(ev.turnId)
        s.waiting++
        s.turns = s.turns
          .then(async () => {
            const action = await verdict
            if (this.session !== s) return
            if (action === 'drop') this.onIgnoredTurn()
            else this.onTurn(ev.text)
          })
          .catch(() => {})
          .finally(() => {
            s.waiting--
          })
        return
      }
      case 'interrupted':
        this.onInterrupted()
        return
      case 'ended':
        this.drop(s)
        // It ran a good while: a new failure, the back-off starts over. (One
        // that ends straight after starting keeps doubling it.)
        if (s.opened && Date.now() - s.openedAt >= INTERACTIVE_TIMING.RESTART_RESET_MS) this.failures = 0
        // A turn being captured is lost with the session.
        if (this.stage === 'heard' || this.stage === 'awaiting') this.backToListening()
        // The desktop ended it because this window went away (closed to the
        // tray, hidden): no restart on a timer, which could reopen the mic
        // while Dial8 sits in the tray if the page never reports itself
        // hidden. It starts again when the user comes back (windowReturned).
        if (ev.reason === 'page') {
          this.awaitingReturn = true
          this.publish()
          return
        }
        // Started again unless the host makes it inactive meanwhile (a
        // capture, the window hidden; a page going away takes the timer with it).
        this.scheduleRestart()
        this.publish()
        return
      default:
        return
    }
  }

  // ── The flow ─────────────────────────────────────────────────────────────

  /** Words of a turn still being said (partial, or a finalized part). */
  private onWords(text: string): void {
    if (!hasWords(text)) return
    switch (this.stage) {
      case 'listening':
        if (matchWakeWord(text, this.deps.getName()).matched && !this.deps.isEcho(text)) {
          this.noteAndPause()
          this.enter('heard', INTERACTIVE_TIMING.HEARD_WAIT_MS, () => this.backToListening())
        }
        return
      case 'heard':
        this.enter('heard', INTERACTIVE_TIMING.HEARD_WAIT_MS, () => this.backToListening())
        return
      case 'awaiting':
        this.enter('awaiting', INTERACTIVE_TIMING.REQUEST_WAIT_MS, () => this.backToListening())
        return
      case 'follow-up':
        this.enter('follow-up', INTERACTIVE_TIMING.FOLLOW_UP_MS, () => this.backToListening())
        return
      default:
        return
    }
  }

  /** A whole turn (the desktop decided it ended). */
  private onTurn(text: string): void {
    const words = text.trim()
    // The agent's own voice through the mic (the reading, the reply): as if
    // nothing was said to it.
    const echo = hasWords(words) && this.deps.isEcho(words)
    const heard = echo ? { matched: false, request: '' } : matchWakeWord(words, this.deps.getName())
    switch (this.stage) {
      case 'answering':
      case 'follow-up':
      case 'awaiting': {
        if (echo) return
        // No name needed now; said anyway, it is taken out.
        const request = heard.matched ? heard.request : capitalized(words)
        if (hasWords(request)) this.send(request)
        else if (heard.matched && this.stage !== 'awaiting') this.acknowledge()
        return
      }
      case 'heard':
        // The recogniser took the name back: it was nothing. Dropped.
        if (!heard.matched) {
          this.backToListening()
          return
        }
        if (heard.request) this.send(heard.request)
        else this.acknowledge()
        return
      case 'listening':
      case 'thinking':
        // Not addressed to the assistant: dropped, never kept or sent.
        if (!heard.matched) return
        if (this.stage === 'listening') this.noteAndPause()
        if (heard.request) this.send(heard.request)
        else this.acknowledge()
        return
    }
  }

  /** A turn in a voice Dial8 doesn't know (Voice focus): as if nothing was
   *  said to it. The name heard in its partials woke the flow for nothing:
   *  back to listening, and the reading resumes. */
  private onIgnoredTurn(): void {
    if (this.stage === 'heard') this.backToListening()
  }

  /** The name: note what the user is listening to, and pause the reading. */
  private noteAndPause(): void {
    this.wokeOn = this.deps.snapshot()
    // A reading still waiting to resume (a line was being said) stays the one
    // to resume, unless something else reads now.
    const waiting = this.pendingResume
    this.pendingResume = null
    this.paused ??= this.deps.pauseReading() ?? waiting
  }

  /** Only the name: "Yes?", and the next turn is the request. */
  private acknowledge(): void {
    void this.deps.say(INTERACTIVE_LINES.ack)
    this.setBarge('wake')
    this.enter('awaiting', INTERACTIVE_TIMING.REQUEST_WAIT_MS, () => this.backToListening())
  }

  /** What the user is listening to, for the ask: now, or (keeping the
   *  sentence being read) when they said the name. */
  private snapshotForAsk(): VoiceAskSnapshot | null {
    const now = this.deps.snapshot()
    const then = this.wokeOn
    if (!now) return then
    if (then && now.kind === then.kind && now.id === then.id && !now.readingAt) return then
    return now
  }

  private send(request: string): void {
    this.ask?.cancel()
    const token = {}
    this.askToken = token
    const snapshot = this.snapshotForAsk()
    // Thinking first: a chat that fails at once reports back inside ask().
    this.setBarge('wake')
    this.enter('thinking', INTERACTIVE_TIMING.REPLY_WAIT_MS, () => this.giveUp())
    const handle = this.deps.ask(request, snapshot ? { snapshot } : {}, {
      onSpeaking: () => {
        if (this.askToken === token) this.onAnswering()
      },
      onSettled: (outcome) => {
        if (this.askToken === token) this.onSettled(outcome)
      },
    })
    if (this.askToken !== token) return
    if (!handle) {
      this.askToken = null
      this.backToListening(this.deps.say(INTERACTIVE_LINES.unreachable))
      return
    }
    this.ask = handle
  }

  private onAnswering(): void {
    this.setBarge('speech')
    this.enter('answering', INTERACTIVE_TIMING.REPLY_WAIT_MS, () => this.giveUp())
  }

  private onSettled(outcome: VoiceAskOutcome): void {
    this.ask = null
    this.askToken = null
    if (outcome === 'failed') {
      this.backToListening(this.deps.say(INTERACTIVE_LINES.failed))
      return
    }
    this.setBarge('speech')
    this.enter('follow-up', INTERACTIVE_TIMING.FOLLOW_UP_MS, () => this.backToListening())
  }

  /** Talked over the reply (barge policy `speech`): the desktop has silenced it. */
  private onInterrupted(): void {
    if (this.stage !== 'answering') return
    this.ask?.interrupt()
    // The panel reports `interrupted`; should it not, the reply is over anyway.
    if (this.stage === 'answering') this.onSettled('interrupted')
  }

  /** No word from the chat for too long. */
  private giveUp(): void {
    this.backToListening()
  }

  /** The flow is over: listening for the name again, and the paused reading
   *  resumes (once `after`, a line being said, is over). */
  private backToListening(after?: Promise<void>): void {
    const paused = this.paused
    this.ask?.cancel()
    this.ask = null
    this.askToken = null
    this.paused = null
    this.wokeOn = null
    this.setBarge('wake')
    this.enter('listening')
    if (!paused) return
    if (!after) {
      this.deps.resumeReading(paused)
      return
    }
    this.pendingResume = paused
    const resume = () => {
      // Not if a new flow took it over (or Interactive went off) meanwhile.
      if (this.pendingResume !== paused) return
      this.pendingResume = null
      if (this.active && this.stage === 'listening') this.deps.resumeReading(paused)
    }
    void after.then(resume, resume)
  }

  private enter(stage: Stage, ms?: number, onTimeout?: () => void): void {
    if (this.stageTimer) clearTimeout(this.stageTimer)
    this.stageTimer = ms !== undefined && onTimeout ? setTimeout(onTimeout, ms) : null
    if (stage === this.stage) return
    this.stage = stage
    this.publish()
  }

  private resetFlow(): void {
    if (this.stageTimer) clearTimeout(this.stageTimer)
    this.stageTimer = null
    this.ask?.cancel()
    this.ask = null
    this.askToken = null
    this.paused = null
    this.pendingResume = null
    this.wokeOn = null
    this.policy = 'wake'
    this.stage = 'listening'
  }

  private publish(): void {
    const live = this.session?.opened === true
    let phase: InteractivePhase
    switch (this.stage) {
      case 'listening':
        phase = live ? 'listening' : 'off'
        break
      case 'heard':
      case 'awaiting':
        phase = 'heard'
        break
      default:
        phase = this.stage
    }
    this.deps.publish(phase)
  }
}
