'use client'

/**
 * Read-aloud for one ChatPanel (docs/plans/local-modules.md §3.6): the speaker
 * button on each assistant reply, and auto-read, which speaks a reply sentence
 * by sentence while it streams. The desktop's `local-tts` module does the
 * speaking; this hook decides what to say and when to stop.
 *
 * `supported` = the desktop app, the local-tts module enabled and Ready, no
 * capture recording, and no Voice ID enrollment recording (./mic-guard).
 * Otherwise there is no read-aloud at all (no system-voice fallback) and
 * nothing here touches the bridge.
 *
 * One "run" = one message being read. Sentences go to `tts_speak` one per
 * call, in order (the calls are chained), with ids
 * `${messageId}:${pageLoadId}:${n}` (unique across reloads, so a previous
 * page's leftover events never match). The run ends when its last sentence
 * reports `done` on `tts://state`, or on `cancelled` / `error`, a refused
 * speak (a `text_too_long` sentence is only skipped), a pause, or any of the
 * stop triggers: stop(), a new turn (sending a message), the message leaving
 * the chat (New chat / load conversation), a recording starting, the module
 * going away, unmount, or the page going away (pagehide).
 *
 * Pause and resume (@/lib/read-aloud/resume-points, keyed by message id):
 * pause() — the reply's button — cancels the desktop and keeps the sentence
 * the run stopped in (the one speaking, or the first not yet done; following a
 * reply that has said all it has so far, the next one to come). So do
 * speakMessage() of another message, and another reader taking the desktop (a
 * section, Listen, another panel): a click never throws a place away.
 * speakMessage() of a paused message resumes there: a finished reply from that
 * sentence (clamped to the sentences it has now), a reply still streaming by
 * skipping what was already spoken and following the rest. The index counts
 * the whole reply's sentences, so a pause while following a resumed turn
 * (which reads only the parts it adds) and a resume once it has finished
 * agree. A pause opts the turn out of auto-read, as stop() does: a paused
 * reply is not followed again on its own. The stop triggers keep no place, and
 * neither does a reply read to its end: the next tap starts from the top.
 *
 * Auto-read only follows a turn that STARTS while this panel is mounted (status
 * going from settled to submitted/streaming), so restored history and a
 * conversation loaded into the panel are never read on their own.
 *
 * Several ChatPanels can be mounted at once (tabs), and the desktop has one
 * queue, so the panel that starts reading takes over: the previous reader's
 * run is paused, without it calling cancel again (@/lib/read-aloud/reader,
 * which the markdown section player shares).
 *
 * Voice mode (docs/plans/chat-voice.md §3.4) rides this same pipeline:
 * `followNextTurn()` makes the turn about to be sent auto-read whatever the
 * setting (voice mode's own turns are always spoken), and `interrupt()` drops
 * the queued sentences after a barge-in the desktop already silenced. Voice
 * mode only ever stops (stop(), interrupt()), never pauses: a reply it cuts
 * off keeps no place.
 * `speakLine()` speaks a line that is no chat message (voice mode's greeting):
 * a run of its own, under an id no message has, that touches no turn state and
 * never leaves the chat, so it reads as the agent speaking (the desktop plays
 * it like any reply: barge-in, the canceller's reference, the glow) and a
 * stop, a new turn or another read ends it like any run. A line keeps no place.
 * It can also be sentences already split (a bot's reading, bots-v2.md Phase 4).
 *
 * `voice` speaks in that voice rather than the Read aloud setting's (a bot's
 * own, lib/bots/bot-voice.ts); null or absent, the setting's.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import type { TtsStatePayload } from '@/lib/tauri-bridge'
import { speechOutput, useSpeechOutput } from '@/lib/speech-output'
import { SentenceStream } from '@/lib/read-aloud/sentence-stream'
import { markdownToSentences } from '@/lib/read-aloud/speech-text'
import { messageSpeechMarkdown } from '@/lib/read-aloud/message-text'
import { getReadAloudAuto, getReadAloudVoice } from '@/lib/read-aloud/settings'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { claimReader, releaseReader } from '@/lib/read-aloud/reader'
import { setResumePoint, takeResumePoint } from '@/lib/read-aloud/resume-points'
import { noteSpoken } from '@/lib/read-aloud/recent-speech'

type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export interface ReadAloudHandle {
  /** Desktop + local-tts Ready + not recording. False → render no read-aloud UI. */
  supported: boolean
  /** The message being read aloud right now, or null. */
  speakingMessageId: string | null
  /** Read one message: from the sentence it was paused in, if it was, else
   *  from the start. Whatever this panel was reading is paused. Tapping the
   *  reply that is still streaming follows it to its end. */
  speakMessage: (messageId: string, markdown: string) => void
  /** Pause reading now, keeping the place: speakMessage() of that message
   *  resumes there. The reply button's Pause. */
  pause: () => void
  /** Stop reading now, keeping no place (voice mode, the composer's Stop,
   *  loading a conversation). */
  stop: () => void
  /** Voice mode is about to send a turn: read its reply aloud as it streams,
   *  even with auto-read off, and treat the next busy status as a new turn
   *  (the previous reply may have just been stopped mid-stream). */
  followNextTurn: () => void
  /** Barge-in: the desktop already cancelled the speech. Drop the queued
   *  sentences and stop following this turn's reply (it keeps streaming as
   *  text). */
  interrupt: () => void
  /** Speak a line that is not a chat message (voice mode's greeting), taking
   *  over whatever was playing: text, or sentences already split. Returns the
   *  id `speakingMessageId` carries while it plays, or null when nothing will
   *  be spoken. */
  speakLine: (text: string | readonly string[]) => string | null
}

export interface UseReadAloudOptions {
  messages: UIMessage[]
  status: ChatStatus
  /** A capture is recording (or starting): no read-aloud, and stop speaking. */
  recording: boolean
  /** The panel is the visible one. Auto-read only starts in a visible panel. */
  active?: boolean
  /** Speak in this voice instead of the Read aloud setting's (a bot's own). */
  voice?: string | null
}

interface Follow {
  messageId: string
  /** Parts before this index were already on screen when the turn started. */
  fromPart: number
  stream: SentenceStream
  /** Sentences before this index were spoken before a pause: not sent again. */
  skipTo: number
}

/** Where a sentence sits: its message, and its index among all that message's
 *  sentences. */
interface Place {
  messageId: string
  index: number
}

interface Run {
  messageId: string
  /** Sent, and not yet done, in order: utterance id → where it sits. The
   *  first is where a pause resumes. */
  pending: Map<string, Place>
  /** Each sent sentence's text, by utterance id: noted as it starts speaking,
   *  for Interactive mode's echo guard (@/lib/read-aloud/recent-speech). */
  texts: Map<string, string>
  /** The index the next sentence gets (counting all of `messageId`'s). */
  next: number
  /** Every sentence has been sent (a finished message, or a flushed stream). */
  closed: boolean
  /** Set while auto-read follows a streaming reply. */
  follow: Follow | null
  /** Shown as speaking (a tap, or a sentence sent): only then does a pause
   *  keep a place. */
  announced: boolean
  /** A spoken line (speakLine): no message backs it. */
  line?: boolean
}

interface Turn {
  active: boolean
  /** Message id → part count when the turn started. */
  baseline: Map<string, number>
  /** The reply this turn is streaming into (the last assistant message). */
  replyId: string | null
  auto: boolean
  autoStarted: boolean
}

// ── Ids (cross-panel ownership: @/lib/read-aloud/reader) ────────────────────
let utteranceSeq = 0
let lineSeq = 0
/** Per page load: utteranceSeq restarts on a reload, the ids must not. */
const pageLoadId = Math.random().toString(36).slice(2, 8)

const isBusy = (s: ChatStatus) => s === 'submitted' || s === 'streaming'

/** The desktop refused one sentence as too long; the rest can still go. */
const isTooLong = (err: unknown) => (err as { code?: unknown } | null)?.code === 'text_too_long'

/** How many sentences the parts before `fromPart` say: where a follow that
 *  starts at that part sits among all the message's sentences. */
function sentencesBefore(message: UIMessage, fromPart: number): number {
  if (fromPart <= 0) return 0
  return markdownToSentences(messageSpeechMarkdown({ parts: message.parts.slice(0, fromPart) })).length
}

/** Where `run` is: its first sentence not yet done, or, following a reply that
 *  has said all it has so far, the next one to come. */
function placeOf(run: Run): Place | null {
  for (const place of run.pending.values()) return place
  return run.closed ? null : { messageId: run.messageId, index: run.next }
}

/** Keep `run`'s place, so speakMessage() of its message resumes there. A line
 *  (nothing reads it again) and a run that never spoke keep none. */
function rememberPlace(run: Run) {
  if (run.line || !run.announced) return
  const place = placeOf(run)
  if (place) setResumePoint(place.messageId, place.index)
}

export function useReadAloud({ messages, status, recording, active = true, voice: ownVoice = null }: UseReadAloudOptions): ReadAloudHandle {
  const speech = useSpeechOutput()
  const held = useReadAloudHeld()
  const supported = speech.available && !recording && !held

  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null)

  const ownerRef = useRef<object>({})
  const runRef = useRef<Run | null>(null)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const inFlightRef = useRef(0)
  const supportedRef = useRef(supported)
  supportedRef.current = supported
  const activeRef = useRef(active)
  activeRef.current = active
  const voiceRef = useRef(ownVoice)
  voiceRef.current = ownVoice
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const prevStatusRef = useRef<ChatStatus>(status)
  const turnRef = useRef<Turn>({ active: false, baseline: new Map(), replyId: null, auto: false, autoStarted: false })
  /** Set by followNextTurn(): the next turn is auto-read regardless of the setting. */
  const forceNextRef = useRef(false)
  /** A run someone else took the desktop from (see the tts://state listener).
   *  `armed` once that cancel has been seen; `suspect`: a sentence of it
   *  `queued` after that cancel, not yet known to have survived it. */
  const lostRef = useRef<{ run: Run; armed: boolean; suspect: string | null } | null>(null)

  /** Stop the desktop's audio now. A speak still in flight could land after
   *  this cancel, so one more cancel follows it through the chain. */
  const cancelDesktop = useCallback(() => {
    void speechOutput.cancel()
    if (inFlightRef.current > 0) {
      chainRef.current = chainRef.current.then(() => speechOutput.cancel())
    }
  }, [])

  /** Clear the desktop's queue before a new run's first sentence: chained,
   *  so the cancel can never be handled after that sentence was queued. */
  const cancelBeforeNextSpeak = useCallback(() => {
    chainRef.current = chainRef.current.then(() => speechOutput.cancel())
  }, [])

  const endRun = useCallback(
    (cancel: boolean) => {
      if (!runRef.current) return
      runRef.current = null
      releaseReader(ownerRef.current)
      setSpeakingMessageId(null)
      if (cancel) cancelDesktop()
    },
    [cancelDesktop],
  )

  /** `announce`: show this message as speaking now (a tap), rather than once
   *  its first sentence is sent (auto-read, which may never send one). */
  const startRun = useCallback(
    (messageId: string, announce: boolean): Run => {
      // What this panel was reading is paused: it keeps its place, and the
      // cancel below clears what it had queued.
      if (runRef.current) rememberPlace(runRef.current)
      // Another panel may be reading: it loses the floor (its run is paused
      // there), and the cancel below silences it before our first sentence.
      claimReader(ownerRef.current, () => {
        const lost = runRef.current
        if (!lost) return
        // Another reader took the desktop: paused where it was.
        rememberPlace(lost)
        runRef.current = null
        lostRef.current = { run: lost, armed: false, suspect: null }
        setSpeakingMessageId(null)
      })
      // Our own leading cancel covers anything a lost run left behind.
      lostRef.current = null
      cancelBeforeNextSpeak()
      const run: Run = {
        messageId,
        pending: new Map(),
        texts: new Map(),
        next: 0,
        closed: false,
        follow: null,
        announced: announce,
      }
      runRef.current = run
      setSpeakingMessageId(announce ? messageId : null)
      return run
    },
    [cancelBeforeNextSpeak],
  )

  const maybeFinish = useCallback(
    (run: Run) => {
      if (runRef.current === run && run.closed && run.pending.size === 0) endRun(false)
    },
    [endRun],
  )

  /** Queue `run`'s next sentences (from index `run.next` of its message), in
   *  order, one tts_speak each. */
  const enqueue = useCallback(
    (run: Run, sentences: string[]) => {
      if (sentences.length === 0 || runRef.current !== run) return
      run.announced = true
      setSpeakingMessageId(run.messageId)
      // Each call reads the voice (its own, else the setting's), so a voice
      // picked in Settings applies from the next sentence.
      const voice = voiceRef.current ?? getReadAloudVoice() ?? undefined
      for (const text of sentences) {
        const id = `${run.messageId}:${pageLoadId}:${utteranceSeq++}`
        run.pending.set(id, { messageId: run.messageId, index: run.next++ })
        run.texts.set(id, text)
        chainRef.current = chainRef.current.then(async () => {
          if (runRef.current !== run || !supportedRef.current) {
            run.pending.delete(id)
            return
          }
          inFlightRef.current++
          try {
            await speechOutput.speak(voice ? { id, text, voice } : { id, text })
          } catch (err) {
            if (isTooLong(err)) {
              // Skip just this sentence and read on.
              run.pending.delete(id)
              maybeFinish(run)
            } else if (runRef.current === run) {
              // recording / not_ready / unavailable: this run can't go on.
              endRun(true)
            }
          } finally {
            inFlightRef.current--
          }
        })
      }
    },
    [endRun, maybeFinish],
  )

  /** Start a run that follows a streaming reply from part `fromPart` on, past
   *  what was spoken before, if it was paused. */
  const startFollow = useCallback(
    (message: UIMessage, fromPart: number, announce: boolean) => {
      const run = startRun(message.id, announce)
      run.next = sentencesBefore(message, fromPart)
      // After startRun, which keeps the place of a read of this same message.
      const skipTo = takeResumePoint(message.id) ?? 0
      run.follow = { messageId: message.id, fromPart, stream: new SentenceStream(), skipTo }
      return run
    },
    [startRun],
  )

  /** Send a followed reply's new sentences, less those spoken before a pause. */
  const sendFollowed = useCallback(
    (run: Run, sentences: string[]) => {
      const skip = Math.min(sentences.length, Math.max(0, (run.follow?.skipTo ?? 0) - run.next))
      run.next += skip
      enqueue(run, sentences.slice(skip))
    },
    [enqueue],
  )

  const feedFollow = useCallback(
    (run: Run, message: UIMessage, final: boolean) => {
      const follow = run.follow
      if (!follow) return
      const sentences = follow.stream.push(messageSpeechMarkdown(message, follow.fromPart))
      if (final) sentences.push(...follow.stream.flush())
      sendFollowed(run, sentences)
      if (final) {
        run.follow = null
        run.closed = true
        maybeFinish(run)
      }
    },
    [sendFollowed, maybeFinish],
  )

  const speakMessage = useCallback(
    (messageId: string, markdown: string) => {
      if (!supportedRef.current) return
      const turn = turnRef.current
      const streaming = turn.active ? messagesRef.current.find((m) => m.id === messageId) : undefined
      if (streaming && turn.replyId === messageId) {
        // The reply is still arriving: read what's there (past what was
        // spoken before a pause), then keep up with it.
        turn.autoStarted = true
        const run = startFollow(streaming, turn.baseline.get(messageId) ?? 0, true)
        feedFollow(run, streaming, false)
        return
      }
      const sentences = markdownToSentences(markdown)
      if (sentences.length === 0) return
      const run = startRun(messageId, true)
      // After startRun, which keeps the place of a read of this same message.
      const saved = takeResumePoint(messageId)
      run.next = saved === null ? 0 : Math.min(saved, sentences.length - 1)
      run.closed = true
      enqueue(run, sentences.slice(run.next))
    },
    [startFollow, feedFollow, startRun, enqueue],
  )

  const speakLine = useCallback(
    (text: string | readonly string[]): string | null => {
      if (!supportedRef.current) return null
      const sentences = typeof text === 'string' ? markdownToSentences(text) : text.map((t) => t.trim()).filter(Boolean)
      if (sentences.length === 0) return null
      // An id no message has (its own prefix), unique across reloads.
      const run = startRun(`line:${pageLoadId}:${lineSeq++}`, true)
      run.line = true
      run.closed = true
      enqueue(run, sentences)
      return run.messageId
    },
    [startRun, enqueue],
  )

  const pause = useCallback(() => {
    const run = runRef.current
    if (!run) return
    // Like stop(), opts the current turn out of auto-read: a paused reply is
    // not followed again on its own.
    turnRef.current.autoStarted = true
    rememberPlace(run)
    endRun(true)
  }, [endRun])

  const stop = useCallback(() => {
    // Also opts the current turn out of auto-read, so a reply stopped before
    // its first sentence finished isn't read when the stream settles.
    turnRef.current.autoStarted = true
    endRun(true)
  }, [endRun])

  const followNextTurn = useCallback(() => {
    forceNextRef.current = true
    const turn = turnRef.current
    if (turn.active) {
      // The previous turn was stopped for this one; its status may never be
      // seen settling (stop + send can land in one render).
      turn.active = false
      turn.replyId = null
    }
    prevStatusRef.current = 'ready'
  }, [])

  const interrupt = useCallback(() => {
    turnRef.current.autoStarted = true
    if (!runRef.current) return
    // No cancel of our own (the desktop already did it), except behind a speak
    // still in flight, which could land after the desktop's cancel.
    endRun(false)
    if (inFlightRef.current > 0) {
      chainRef.current = chainRef.current.then(() => speechOutput.cancel())
    }
  }, [endRun])

  // ── tts://state: speaking / done / cancelled / error for our sentences ─────
  useEffect(() => {
    if (!supported) return
    return speechOutput.onState((p: TtsStatePayload) => {
      // A run that lost the desktop to someone else's cancel. Events come in
      // order, so once that cancel has been seen, a sentence of ours that
      // starts speaking, or is `queued` and not cancelled by the very next
      // event, was sent after it and survived it: it would play in the middle
      // of the other read, so silence it. (A speak the desktop accepted just
      // before the cancel reports `queued` then `cancelled`, back to back.)
      const lost = lostRef.current
      if (lost) {
        const suspect = lost.suspect
        lost.suspect = null
        const survived = () => {
          lostRef.current = null
          void speechOutput.cancel()
        }
        if (suspect && !(p.id === suspect && p.state === 'cancelled')) return survived()
        if (lost.run.pending.has(p.id)) {
          if (p.state === 'queued' || p.state === 'speaking') {
            if (lost.armed) {
              if (p.state === 'speaking') return survived()
              lost.suspect = p.id
            }
            return
          }
          lost.run.pending.delete(p.id)
          if (p.state === 'cancelled') lost.armed = true
          if (lost.run.pending.size === 0) lostRef.current = null
          return
        }
      }

      const run = runRef.current
      if (!run || !run.pending.has(p.id)) return
      if (p.state === 'speaking') {
        // The queue plays in order: whatever was sent before this one is over.
        for (const id of run.pending.keys()) {
          if (id === p.id) break
          run.pending.delete(id)
        }
        // Interactive mode's echo guard (@/lib/read-aloud/recent-speech).
        const text = run.texts.get(p.id)
        if (text) noteSpoken(text)
      } else if (p.state === 'done' || (p.state === 'error' && p.error === 'text_too_long')) {
        // `text_too_long` here: the sentence grew past the engine's limit when
        // the desktop spelled out its numbers. Skipped, like a refused speak.
        run.pending.delete(p.id)
        maybeFinish(run)
      } else if (p.state === 'cancelled') {
        // Not our cancel (ours ends the run first): another window, the
        // Settings preview or the desktop cleared the queue.
        run.pending.delete(p.id)
        endRun(false)
        if (run.pending.size > 0) lostRef.current = { run, armed: true, suspect: null }
      } else if (p.state === 'error') {
        // Don't read on past a sentence that failed.
        endRun(true)
      }
    })
  }, [supported, endRun, maybeFinish])

  // ── Turns: auto-read, and "a new message cancels" ─────────────────────────
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    const turn = turnRef.current

    // A turn starts in this panel (a send, or an answer resuming a turn).
    if (isBusy(status) && !isBusy(prev) && !turn.active) {
      turn.active = true
      turn.baseline = new Map(messages.map((m) => [m.id, m.parts.length]))
      turn.replyId = null
      turn.autoStarted = false
      turn.auto = supportedRef.current && (forceNextRef.current || (activeRef.current && getReadAloudAuto()))
      forceNextRef.current = false
      endRun(true)
      if (turn.auto) void speechOutput.prepare()
    }

    const last = messages[messages.length - 1]
    const reply = turn.active && last?.role === 'assistant' ? last : null
    const run = runRef.current

    if (turn.active && reply) {
      turn.replyId = reply.id
      if (run?.follow && run.follow.messageId !== reply.id) {
        // The turn moved on to a new assistant message: finish the old one,
        // keep reading into the new one.
        feedFollow(run, messagesRef.current.find((m) => m.id === run.follow!.messageId) ?? reply, false)
        sendFollowed(run, run.follow.stream.flush())
        const fromPart = turn.baseline.get(reply.id) ?? 0
        run.messageId = reply.id
        run.next = sentencesBefore(reply, fromPart)
        run.follow = { messageId: reply.id, fromPart, stream: new SentenceStream(), skipTo: 0 }
      } else if (!run && turn.auto && !turn.autoStarted && supportedRef.current) {
        turn.autoStarted = true
        startFollow(reply, turn.baseline.get(reply.id) ?? 0, false)
      }
      const current = runRef.current
      if (current?.follow) feedFollow(current, reply, !isBusy(status))
    }

    if (!isBusy(status) && turn.active) {
      turn.active = false
      turn.replyId = null
      // Flush a followed reply whose last message wasn't the assistant's.
      const current = runRef.current
      if (current?.follow) {
        const msg = messages.find((m) => m.id === current.follow!.messageId)
        if (msg) feedFollow(current, msg, true)
        else endRun(true)
      }
    }

    // The message being read left the chat (New chat, a loaded conversation).
    // A spoken line was never in it.
    const reading = runRef.current
    if (reading && !reading.line && !messages.some((m) => m.id === reading.messageId)) endRun(true)
  }, [messages, status, endRun, sendFollowed, feedFollow, startFollow])

  // ── Recording started, or the module went away: silence ─────────────────
  useEffect(() => {
    if (!supported) endRun(true)
  }, [supported, endRun])

  // ── The page going away (reload, hard navigation, window closed) ─────────
  // React runs no cleanup then, so the desktop would read on with no Stop
  // button anywhere. Best effort: the desktop also cancels on page load.
  useEffect(() => {
    if (!speakingMessageId) return
    const onPageHide = () => {
      if (runRef.current) void speechOutput.cancel()
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [speakingMessageId])

  // ── Unmount (tab closed, panel remounted) ─────────────────────────────────
  useEffect(() => {
    const owner = ownerRef.current
    return () => {
      if (runRef.current) {
        runRef.current = null
        void speechOutput.cancel()
      }
      releaseReader(owner)
    }
  }, [])

  return useMemo(
    () => ({ supported, speakingMessageId, speakMessage, pause, stop, followNextTurn, interrupt, speakLine }),
    [supported, speakingMessageId, speakMessage, pause, stop, followNextTurn, interrupt, speakLine],
  )
}
