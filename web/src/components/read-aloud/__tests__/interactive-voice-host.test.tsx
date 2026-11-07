// @vitest-environment jsdom
/**
 * Interactive mode's host (../interactive-voice-host), mounted once for the
 * app, with the real listen mode store, section player, session claim,
 * mic-guard and Interactive store, and the desktop bridge mocked:
 *  - it listens (an `interactive` session with the voice settings) only while
 *    Interactive is on, on a desktop whose voice_status has `interactive` and
 *    `conversation`, the mic free and the window visible; an older desktop, or
 *    one whose modules aren't ready: no session at all;
 *  - it yields to a voice conversation (the composer's voice mode) and to
 *    dictation at once, and listens again a moment after they end;
 *  - Interactive off: the session is cancelled, the mute reset; the mute
 *    button's choice reaches the desktop, the session kept;
 *  - the flow end to end: the name heard while a document reads pauses it
 *    (the section player keeps its place), the request goes to the chat (the
 *    window event) with what the user was listening to; the reply over, the
 *    follow-up window, then the document resumes through its target;
 *  - the echo guard: the reading itself heard back, naming the assistant,
 *    doesn't wake it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { TtsStatePayload, VoiceEvent } from '@/lib/tauri-bridge'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  recording: { isRecording: false, isStarting: false },
  calls: [] as Array<[string, ...unknown[]]>,
  voiceListeners: new Map<string, (e: VoiceEvent) => void>(),
  ttsListeners: new Set<(p: TtsStatePayload) => void>(),
  lines: [] as string[],
}))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/voice/status-store', () => ({ useVoiceStatus: () => hoisted.status, getVoiceStatus: () => hoisted.status }))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => hoisted.recording }))
vi.mock('@/lib/voice/assistant-name-store', () => ({
  getAssistantName: () => 'Joseph',
  ensureAssistantNameLoaded: () => {},
}))
vi.mock('@/hooks/use-read-aloud', () => ({
  useReadAloud: () => ({
    supported: true,
    speakingMessageId: null,
    speakLine: (text: string) => {
      hoisted.lines.push(text)
      return null
    },
  }),
}))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: {
    voiceStart: async (args: { sessionId: string }) => void hoisted.calls.push(['voiceStart', args]),
    voiceCancel: async (id: string) => void hoisted.calls.push(['voiceCancel', id]),
    voiceSetMuted: async (id: string, muted: boolean) => void hoisted.calls.push(['voiceSetMuted', id, muted]),
    voiceSetBarge: async (id: string, policy: string) => void hoisted.calls.push(['voiceSetBarge', id, policy]),
    onVoiceEvent: (id: string, cb: (e: VoiceEvent) => void) => {
      hoisted.voiceListeners.set(id, cb)
      return () => hoisted.voiceListeners.delete(id)
    },
    ttsSpeak: async (args: { id: string; text: string }) => void hoisted.calls.push(['ttsSpeak', args]),
    ttsCancel: async () => void hoisted.calls.push(['ttsCancel']),
    ttsPrepare: async () => {},
    onTtsState: (cb: (p: TtsStatePayload) => void) => {
      hoisted.ttsListeners.add(cb)
      return () => hoisted.ttsListeners.delete(cb)
    },
  },
}))

import { InteractiveVoiceHost, RESUME_AFTER_MS } from '../interactive-voice-host'
import { __setFrontListenTargetForTests } from '../listen-frame'
import { __resetListenModeForTests, setListenMode } from '@/lib/read-aloud/listen-mode'
import {
  __resetSectionPlayerForTests,
  getSectionPlayerSnapshot,
  playSection,
  setSectionPlayerSupported,
} from '@/lib/read-aloud/section-player'
import { __resetResumePointsForTests, getResumePoint } from '@/lib/read-aloud/resume-points'
import { __resetRecentSpeechForTests } from '@/lib/read-aloud/recent-speech'
import { holdReadAloud } from '@/lib/read-aloud/mic-guard'
import { claimVoiceSession, releaseVoiceSession } from '@/lib/voice/session-claim'
import { __resetInteractiveVoiceForTests, getInteractiveVoice, setInteractiveMuted } from '@/lib/voice/interactive-store'
import { INTERACTIVE_LINES, INTERACTIVE_TIMING } from '@/lib/voice/interactive-engine'
import { VOICE_ASK_EVENT, type VoiceAskDelivery } from '@/lib/voice/voice-ask-delivery'

const READY = { available: true, dictation: true, conversation: true, stt: 'ready', tts: 'ready', interactive: true }

let container: HTMLDivElement
let root: Root

const starts = () => hoisted.calls.filter((c) => c[0] === 'voiceStart').map((c) => c[1] as { sessionId: string; mode: string })
const cancels = () => hoisted.calls.filter((c) => c[0] === 'voiceCancel').map((c) => c[1])
const sessionId = () => starts()[starts().length - 1]?.sessionId
const emit = async (ev: VoiceEvent) => {
  await act(async () => hoisted.voiceListeners.get(sessionId())?.(ev))
}
const tts = async (p: TtsStatePayload) => {
  await act(async () => {
    for (const cb of [...hoisted.ttsListeners]) cb(p)
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function render() {
  await act(async () => root.render(h(InteractiveVoiceHost)))
  await advance(0)
}

/** Interactive on, and the host settled into listening. */
async function listening() {
  await act(async () => setListenMode(true))
  await advance(RESUME_AFTER_MS + 10)
}

beforeEach(() => {
  vi.useFakeTimers()
  hoisted.status = { ...READY }
  hoisted.recording = { isRecording: false, isStarting: false }
  hoisted.calls = []
  hoisted.voiceListeners.clear()
  hoisted.ttsListeners.clear()
  hoisted.lines = []
  __resetListenModeForTests()
  __resetSectionPlayerForTests()
  __resetResumePointsForTests()
  __resetRecentSpeechForTests()
  __resetInteractiveVoiceForTests()
  __setFrontListenTargetForTests(undefined)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  __resetListenModeForTests()
  __resetSectionPlayerForTests()
  __setFrontListenTargetForTests(undefined)
  vi.useRealTimers()
})

describe('InteractiveVoiceHost: when it listens', () => {
  it('Interactive on, on a desktop that runs it: an interactive session with the voice settings', async () => {
    await render()
    expect(starts()).toEqual([])
    await listening()
    expect(starts()).toEqual([expect.objectContaining({ mode: 'interactive', endSilenceMs: 1200, noiseProfile: 'quiet' })])
    expect(starts()[0]).not.toHaveProperty('bargeIn')
    expect(getInteractiveVoice().phase).toBe('listening')
  })

  it('an older desktop (no `interactive`), or modules not ready: no session, Interactive only reads', async () => {
    hoisted.status = { ...READY, interactive: undefined }
    await render()
    await listening()
    expect(starts()).toEqual([])
    hoisted.status = { ...READY, conversation: false }
    await render()
    await advance(RESUME_AFTER_MS + 10)
    expect(starts()).toEqual([])
    expect(getInteractiveVoice().phase).toBe('off')
  })

  it('a capture recording: none, and it starts once the capture is over', async () => {
    hoisted.recording = { isRecording: true, isStarting: false }
    await render()
    await listening()
    expect(starts()).toEqual([])
    hoisted.recording = { isRecording: false, isStarting: false }
    await render()
    await advance(RESUME_AFTER_MS + 10)
    expect(starts()).toHaveLength(1)
  })

  it('yields to a voice conversation at once, and listens again a moment after it ends', async () => {
    await render()
    await listening()
    const first = sessionId()
    const owner = {}
    await act(async () => claimVoiceSession(owner, () => {}))
    await advance(0)
    expect(cancels()).toEqual([first])
    expect(getInteractiveVoice().phase).toBe('off')

    await act(async () => releaseVoiceSession(owner))
    await advance(RESUME_AFTER_MS - 50)
    expect(starts()).toHaveLength(1)
    await advance(100)
    expect(starts()).toHaveLength(2)
  })

  it('yields to dictation (its read-aloud hold) too', async () => {
    await render()
    await listening()
    let release: () => void = () => {}
    await act(async () => {
      release = holdReadAloud({ mic: false })
    })
    await advance(0)
    expect(cancels()).toEqual([starts()[0].sessionId])
    await act(async () => release())
    await advance(RESUME_AFTER_MS + 10)
    expect(starts()).toHaveLength(2)
  })

  it('the mute reaches the desktop and keeps the session; Interactive off cancels it and unmutes', async () => {
    await render()
    await listening()
    await act(async () => setInteractiveMuted(true))
    await advance(0)
    expect(hoisted.calls).toContainEqual(['voiceSetMuted', sessionId(), true])
    expect(cancels()).toEqual([])

    await act(async () => setListenMode(false))
    await advance(0)
    expect(cancels()).toEqual([sessionId()])
    expect(getInteractiveVoice()).toEqual({ phase: 'off', muted: false })
  })
})

describe('InteractiveVoiceHost: the flow', () => {
  function frontDocument() {
    const resume = vi.fn(() => playSection('doc:d1', ['One.', 'Two.', 'Three.']))
    __setFrontListenTargetForTests({ key: 'doc:d1', resume, describe: () => null })
    return resume
  }

  function chat() {
    const asks: VoiceAskDelivery[] = []
    const listener = (e: Event) => {
      const d = (e as CustomEvent).detail as VoiceAskDelivery
      d.accept()
      asks.push(d)
    }
    window.addEventListener(VOICE_ASK_EVENT, listener)
    return { asks, stop: () => window.removeEventListener(VOICE_ASK_EVENT, listener) }
  }

  it('the name pauses the reading, the request goes to the chat with what was being read, and the reading resumes after the follow-up window', async () => {
    setSectionPlayerSupported(true)
    const resume = frontDocument()
    const { asks, stop } = chat()
    try {
      await render()
      await listening()
      await act(async () => playSection('doc:d1', ['One.', 'Two.', 'Three.']))
      await advance(0)
      const second = hoisted.calls.filter((c) => c[0] === 'ttsSpeak').map((c) => c[1] as { id: string })[1]
      await tts({ id: second.id, state: 'speaking' })

      await emit({ type: 'transcript', turnId: 't1', text: 'Joseph', final: false })
      // Paused at once, keeping its place.
      expect(getSectionPlayerSnapshot().playingKey).toBeNull()
      expect(getResumePoint('doc:d1')).toBe(1)
      expect(getInteractiveVoice().phase).toBe('heard')

      await emit({ type: 'turn', turnId: 't1', text: 'Joseph, what does this mean?' })
      expect(asks).toHaveLength(1)
      expect(asks[0].text).toBe('What does this mean?')
      expect(asks[0].voiceAsk).toEqual({ snapshot: { kind: 'document', id: 'd1', readingAt: 'Two.' } })
      expect(getInteractiveVoice().phase).toBe('thinking')

      await act(async () => asks[0].speaking())
      await advance(0)
      expect(getInteractiveVoice().phase).toBe('answering')
      expect(hoisted.calls).toContainEqual(['voiceSetBarge', sessionId(), 'speech'])

      await act(async () => asks[0].settle('spoken'))
      expect(getInteractiveVoice().phase).toBe('follow-up')
      await advance(INTERACTIVE_TIMING.FOLLOW_UP_MS)
      expect(getInteractiveVoice().phase).toBe('listening')
      expect(hoisted.calls).toContainEqual(['voiceSetBarge', sessionId(), 'wake'])
      expect(resume).toHaveBeenCalledTimes(1)
      expect(getSectionPlayerSnapshot().playingKey).toBe('doc:d1')
    } finally {
      stop()
    }
  })

  it('the user moved on to another item meanwhile: nothing resumes (the latest item wins)', async () => {
    setSectionPlayerSupported(true)
    const resume = frontDocument()
    const { asks, stop } = chat()
    try {
      await render()
      await listening()
      await act(async () => playSection('doc:d1', ['One.', 'Two.']))
      await emit({ type: 'turn', turnId: 't1', text: 'Joseph, summarize it' })
      __setFrontListenTargetForTests({ key: 'doc:d2', resume: vi.fn(), describe: () => null })
      await act(async () => asks[0].settle('spoken'))
      await advance(INTERACTIVE_TIMING.FOLLOW_UP_MS)
      expect(resume).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })

  it('no chat to take it: says it can’t reach the chat', async () => {
    setSectionPlayerSupported(true)
    frontDocument()
    await render()
    await listening()
    await emit({ type: 'turn', turnId: 't1', text: 'Joseph, read the next one' })
    expect(hoisted.lines).toEqual([INTERACTIVE_LINES.unreachable])
    expect(getInteractiveVoice().phase).toBe('listening')
  })

  it('the echo guard: the reading heard back, naming the assistant, doesn’t wake it', async () => {
    setSectionPlayerSupported(true)
    frontDocument()
    const { asks, stop } = chat()
    try {
      await render()
      await listening()
      await act(async () => playSection('doc:d1', ['Joseph approved the budget yesterday.']))
      const first = hoisted.calls.filter((c) => c[0] === 'ttsSpeak').map((c) => c[1] as { id: string })[0]
      await tts({ id: first.id, state: 'speaking' })
      await emit({ type: 'transcript', turnId: 't1', text: 'Joseph approved the', final: false })
      expect(getSectionPlayerSnapshot().playingKey).toBe('doc:d1')
      await emit({ type: 'turn', turnId: 't1', text: 'Joseph approved the budget yesterday' })
      expect(asks).toHaveLength(0)
      expect(getInteractiveVoice().phase).toBe('listening')
    } finally {
      stop()
    }
  })
})
