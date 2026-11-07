'use client'

/**
 * Interactive mode's host: the voice half of the top bar's Interactive toggle
 * (./listen-mode-toggle). Listen mode keeps reading what the user opens, and
 * the mic listens in the background for the assistant's name (Liam,
 * 2026-10-02: "Joseph, can you look something up for me"): the question, and
 * a snapshot of what they were listening to, go to the chat, whose reply is
 * read aloud. The flow itself is the engine's (@/lib/voice/interactive-engine);
 * this mounts it once for the app, in the dashboard shell, never inside a
 * chat panel, whose voice mode ends on a tab switch. Renders nothing.
 *
 * It listens while all of these hold:
 *  - Interactive is on (@/lib/read-aloud/listen-mode), muted or not (the mute
 *    keeps the session; the mic button is ./listen-mode-toggle's);
 *  - this desktop runs it (voice_status `interactive`, with local-stt and
 *    local-tts ready). An older desktop, or a browser: nothing at all, and
 *    Interactive only reads;
 *  - the mic is free: no capture recording or starting, no dictation or Voice
 *    ID enrollment (read-aloud's mic-guard holds), and no voice conversation
 *    (the composer's voice mode, a bot bubble's talk: @/lib/voice/session-claim).
 *    It yields to those at once (their claim or hold lands before their
 *    voice_start, which would replace this session anyway) and starts again
 *    a moment after they end (RESUME_AFTER_MS);
 *  - the window is visible.
 *
 * What it hands the engine: the window in front's Listen target
 * (./listen-frame, getFrontListenTarget) for what the user is listening to
 * (its key, and the sentence the section player is reading, or for a browser
 * page its tab title and site) and for resuming its reading; the section
 * player to pause it; its own read-aloud for the short lines ("Yes?"); and the
 * chat, through the shell (@/lib/voice/voice-ask-delivery). A reading resumes
 * only if it is still the item in front, nothing else is reading (a chat
 * reply, a newer item: listen mode's latest reader wins) and it wasn't read to
 * its end.
 *
 * The echo guard: words that closely match what the desktop's voice just said
 * (@/lib/read-aloud/recent-speech, fed by the section player and every chat
 * read-aloud) are the agent's own speech on the mic, not the user's.
 *
 * PRIVACY: transcripts stay in memory; a turn without the assistant's name is
 * dropped as it arrives, never stored, logged or sent. Nothing here logs.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useReadAloud } from '@/hooks/use-read-aloud'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge } from '@/lib/tauri-bridge'
import { isListenModeOn, useListenMode } from '@/lib/read-aloud/listen-mode'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { isReaderBusy } from '@/lib/read-aloud/reader'
import { recentSpeech } from '@/lib/read-aloud/recent-speech'
import {
  getSectionPlayerSnapshot,
  getSectionPlayingSentence,
  pauseSection,
  wasReadToTheEnd,
} from '@/lib/read-aloud/section-player'
import { ensureAssistantNameLoaded, getAssistantName } from '@/lib/voice/assistant-name-store'
import { InteractiveEngine, type InteractiveDeps } from '@/lib/voice/interactive-engine'
import { setInteractiveMuted, setInteractivePhase, useInteractiveVoice } from '@/lib/voice/interactive-store'
import { useVoiceSessionHeld } from '@/lib/voice/session-claim'
import { interactiveStartOptions } from '@/lib/voice/settings'
import { useVoiceStatus } from '@/lib/voice/status-store'
import { snapshotFromListenKey } from '@/lib/voice/voice-ask'
import { deliverVoiceAsk } from '@/lib/voice/voice-ask-delivery'
import { openVoiceFocus, prepareVoiceFocus } from '@/lib/voice/voice-focus'
import { isEchoOf } from '@/lib/voice/wake-word'
import { getFrontListenTarget } from './listen-frame'

/** After whatever held the mic lets go (voice mode, dictation), wait this long
 *  before listening again: its own end lands at the desktop first. */
export const RESUME_AFTER_MS = 700

/** A short line not over within this long counts as over (it never showed). */
const LINE_TIMEOUT_MS = 8000

const NO_MESSAGES: UIMessage[] = []

function subscribeVisibility(listener: () => void) {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const isVisible = () => document.visibilityState !== 'hidden'
const serverVisible = () => false

/** `value`, except that turning true only shows once it has stayed true for `ms`. */
function useSettledTrue(value: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (!value) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value && settled
}

/** What the engine knows of the reading and the window in front. */
const readingDeps: Pick<InteractiveDeps, 'snapshot' | 'pauseReading' | 'resumeReading'> = {
  snapshot: () => {
    const front = getFrontListenTarget()
    if (!front) return null
    const playing = getSectionPlayingSentence()
    const readingAt = playing && playing.key === front.key ? playing.text : null
    return snapshotFromListenKey(front.key, front.describe?.() ?? null, readingAt)
  },
  pauseReading: () => {
    const key = getSectionPlayerSnapshot().playingKey
    if (key === null) return null
    pauseSection(key)
    return { key }
  },
  resumeReading: (paused) => {
    if (!isListenModeOn() || isReaderBusy() || getSectionPlayerSnapshot().playingKey !== null) return
    const front = getFrontListenTarget()
    if (!front || front.key !== paused.key || wasReadToTheEnd(paused.key)) return
    front.resume()
  },
}

export function InteractiveVoiceHost() {
  if (!isDesktopApp()) return null
  return <Host />
}

function Host() {
  const listenMode = useListenMode()
  const status = useVoiceStatus()
  const recording = useOptionalRecordingStable()
  const capturing = !!(recording?.isRecording || recording?.isStarting)
  const held = useReadAloudHeld()
  const conversation = useVoiceSessionHeld()
  const visible = useSyncExternalStore(subscribeVisibility, isVisible, serverVisible)
  const { muted } = useInteractiveVoice()

  const supported = status.available && status.interactive === true && status.conversation
  const free = !capturing && !held && !conversation
  const active = useSettledTrue(listenMode && supported && free && visible, RESUME_AFTER_MS)

  // The short lines ("Yes?"), in the read-aloud voice.
  const speaker = useReadAloud({ messages: NO_MESSAGES, status: 'ready', recording: capturing, active: false })
  const speakerRef = useRef(speaker)
  speakerRef.current = speaker
  /** The line being said, and how to tell its caller it is over. */
  const lineRef = useRef<{ id: string; shown: boolean; done: () => void } | null>(null)
  const speakingId = speaker.speakingMessageId
  useEffect(() => {
    const line = lineRef.current
    if (!line) return
    if (speakingId === line.id) line.shown = true
    else if (line.shown) line.done()
  }, [speakingId])

  const engine = useMemo(
    () =>
      new InteractiveEngine({
        bridge: tauriBridge,
        getName: getAssistantName,
        // The echo guard: what the reading and the replies just said.
        isEcho: (text) => isEchoOf(text, recentSpeech()),
        startOptions: interactiveStartOptions,
        ...readingDeps,
        say: (text) =>
          new Promise<void>((resolve) => {
            lineRef.current?.done()
            const id = speakerRef.current.speakLine(text)
            if (!id) {
              resolve()
              return
            }
            let timer: ReturnType<typeof setTimeout> | undefined
            const line = {
              id,
              shown: false,
              done: () => {
                clearTimeout(timer)
                if (lineRef.current === line) lineRef.current = null
                resolve()
              },
            }
            timer = setTimeout(line.done, LINE_TIMEOUT_MS)
            lineRef.current = line
          }),
        ask: deliverVoiceAsk,
        publish: setInteractivePhase,
        // Voice focus: only the user and voices Dial8 knows are heard.
        openFocus: openVoiceFocus,
      }),
    [],
  )

  // Voice focus: know the voiceprint before a session asks whether to want speech.
  useEffect(() => {
    if (supported && status.speechAudio) prepareVoiceFocus()
  }, [supported, status.speechAudio])
  useEffect(() => () => engine.dispose(), [engine])

  useEffect(() => {
    ensureAssistantNameLoaded()
  }, [])

  useEffect(() => engine.setActive(active), [engine, active])

  // Back from the tray (or any hide the page didn't report): a session the
  // desktop ended for the window going away starts again (engine.windowReturned).
  useEffect(() => {
    const back = () => {
      if (document.visibilityState !== 'hidden') engine.windowReturned()
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [engine])
  useEffect(() => engine.setMuted(muted), [engine, muted])

  // Interactive off: the mute goes with it (on again, it listens).
  useEffect(() => {
    if (!listenMode) setInteractiveMuted(false)
  }, [listenMode])

  return null
}
