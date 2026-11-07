// @vitest-environment jsdom
/**
 * What a HUD feed change costs (one-chat review fix 2/3). Pinned:
 *   - a Voice ID or last-speaker change never re-renders the chat (LiveChat is
 *     memoized and handed stable props);
 *   - a change of speaker re-renders only the two chips it moves between;
 *   - the chat box wears the call's glow in both hosts, only while the call
 *     is live and audio flows, and the call's level never re-renders the chat;
 *   - the header's recording time counts on in its own text, never
 *     re-rendering the chat or the chips;
 *   - editing the goal line (typing, saving) never re-renders the chat or
 *     the chips: its draft and its pending save are its own;
 *   - a suggestion sent across windows counts down to its `autoAcceptAt` in
 *     its own leaf, one timeout at a time, with no tick store;
 *   - the web HUD's feed store is emptied when its call's HUD goes, so the
 *     next call never opens on the last one's conversation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const counts = vi.hoisted(() => ({ chat: 0, chips: new Map<string, number>() }))
vi.mock('@/components/live-chat/use-live-chat', () => ({
  useLiveChat: () => {
    counts.chat++
    return { messages: [], status: 'ready', error: undefined, loading: false, send: async () => true, answerQuestion: () => {}, stop: () => {} }
  },
}))
vi.mock('@/components/capture/live-capture-header', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/capture/live-capture-header')>()),
  VoiceIdSpeaker: ({ speaker }: { speaker: string }) => {
    counts.chips.set(speaker, (counts.chips.get(speaker) ?? 0) + 1)
    return null
  },
}))
// The glow's beam (voice-glow), drawn as a marker: jsdom can't paint it.
vi.mock('voice-glow', () => ({ VoiceBeam: () => h('i', { 'data-voice-beam': '' }) }))
vi.mock('../use-live-agent-name', () => ({ useLiveAgentName: () => 'Sales Coach' }))

const rec = vi.hoisted(() => ({ ctx: null as null | Record<string, unknown> }))
vi.mock('@/hooks/recording-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/recording-context')>()),
  useRecordingContext: () => rec.ctx,
  useDetectedSpeakers: () => ['local_1'],
  useLiveActiveSpeaker: () => null,
}))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1', setClientWorkspaceId: vi.fn() }))

import { AgentHudView } from '../agent-hud-view'
import { createHudFeedStore, EMPTY_HUD_FEED, type AgentHudFeed } from '../hud-feed'
import type { HudAudioLevels } from '../hud-audio-levels'
import { InPageHudFeed } from '../in-page-hud-feed'
import { useAutoAcceptCountdown } from '@/hooks/recording-context'
import type { VoiceIdHudState } from '@/lib/live-agent/voice-id-hud'
import type { SpeakerIdentification } from '@/lib/voice-id-service'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  counts.chat = 0
  counts.chips.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const voiceId = (over: Partial<VoiceIdHudState> = {}): VoiceIdHudState => ({
  captureId: 'cap-1',
  workspaceId: 'ws-1',
  detectedSpeakers: ['local_1', 'remote_1', 'remote_2'],
  activeSpeaker: null,
  speakerNames: {},
  demotedSelfLabels: [],
  speakerContacts: {},
  postSessionReview: null,
  selfSuggestion: null,
  ...over,
})
const conversation = { captureId: 'cap-1', conversationId: 'conv-live', agentId: 'rec-1', workspaceId: 'ws-1' }
const actions = { sendVoiceIdAction: () => {}, beforeSend: async () => {} }

describe('the HUD on a feed change', () => {
  const render = (feed: AgentHudFeed) => act(async () => root.render(h(AgentHudView, { host: 'page', feed, actions })))

  it('a new Voice ID state or speaker never re-renders the chat; a speaker change re-renders the two chips it moves between', async () => {
    const nudges = EMPTY_HUD_FEED.nudges
    await render({ voiceId: voiceId(), lastSpeaker: 'remote_1', nudges, conversation, recording: null, schedule: null, brief: null })
    const chatRenders = counts.chat
    expect(chatRenders).toBeGreaterThan(0)
    counts.chips.clear()

    // The same state again, as a fresh object (desktop: every Tauri message is).
    await render({ voiceId: voiceId(), lastSpeaker: 'remote_1', nudges, conversation, recording: null, schedule: null, brief: null })
    expect(counts.chat).toBe(chatRenders)
    expect([...counts.chips.keys()]).toEqual([])

    // Who spoke last moves from remote_1 to remote_2.
    await render({ voiceId: voiceId(), lastSpeaker: 'remote_2', nudges, conversation, recording: null, schedule: null, brief: null })
    expect(counts.chat).toBe(chatRenders)
    expect([...counts.chips.keys()].sort()).toEqual(['remote_1', 'remote_2'])
  })

  it('the recording time counts on in its own text: the chat and the chips never re-render for it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    const nudges = EMPTY_HUD_FEED.nudges
    const recording = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected' as const, elapsedSec: 59, at: Date.now() }
    const recActions = { ...actions, sendRecordingAction: () => {} }
    await act(async () => root.render(h(AgentHudView, { host: 'window', feed: { voiceId: voiceId(), lastSpeaker: 'remote_1', nudges, conversation, recording, schedule: null, brief: null }, actions: recActions })))
    const elapsed = () => container.querySelector('[data-hud-elapsed]')!.textContent
    expect(elapsed()).toBe('0:59')
    const chatRenders = counts.chat
    counts.chips.clear()
    await act(async () => { await vi.advanceTimersByTimeAsync(5_010) })
    expect(elapsed()).toBe('1:04')
    expect(counts.chat).toBe(chatRenders)
    expect([...counts.chips.keys()]).toEqual([])
  })

  it('editing the goal line never re-renders the chat or the chips', async () => {
    const nudges = EMPTY_HUD_FEED.nudges
    const recording = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected' as const, elapsedSec: 1, at: 1 }
    const brief = { captureId: 'cap-1', goal: 'Close the pilot', prepTitle: null, prepTop: null }
    const goalActions = { ...actions, saveGoal: async () => true }
    await act(async () => root.render(h(AgentHudView, { host: 'page', feed: { voiceId: voiceId(), lastSpeaker: null, nudges, conversation, recording, schedule: null, brief }, actions: goalActions })))
    const chatRenders = counts.chat
    counts.chips.clear()
    await act(async () => (container.querySelector('[data-hud-goal] button') as HTMLButtonElement).click())
    const input = container.querySelector('[data-hud-goal] input') as HTMLInputElement
    for (const value of ['G', 'Ge', 'Get a yes']) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(container.querySelector('[data-hud-goal-text]')!.textContent).toBe('Get a yes')
    expect(counts.chat).toBe(chatRenders)
    expect([...counts.chips.keys()]).toEqual([])
  })

  it("the chat box wears the call's glow in both hosts, only while the call is live and audio flows; levels never re-render the chat", async () => {
    const nudges = EMPTY_HUD_FEED.nudges
    let level = 0
    const listeners = new Set<() => void>()
    const audioLevels: HudAudioLevels = {
      get: () => level,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const emit = (next: number) =>
      act(() => {
        level = next
        for (const cb of [...listeners]) cb()
      })
    const recording = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected' as const, elapsedSec: 1, at: 1 }
    for (const host of ['window', 'page'] as const) {
      // Before the conversation is known (the waiting box), then the chat's box.
      for (const conv of [null, conversation]) {
        const render = (rec: typeof recording | null) =>
          act(async () => root.render(h(AgentHudView, { host, feed: { voiceId: voiceId(), lastSpeaker: null, nudges, conversation: conv, recording: rec, schedule: null, brief: null }, actions, audioLevels })))
        // Not live yet: no glow, nothing listening.
        await render(null)
        expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
        expect(listeners.size).toBe(0)
        // Live, silent: listening, nothing drawn.
        await render(recording)
        expect(listeners.size).toBe(1)
        expect(container.querySelector('[data-hud-audio-glow="beam"]')!.hasAttribute('data-flowing')).toBe(false)
        // Sound: on, in the box beside its textarea; the chat never re-renders for levels.
        const chatRenders = counts.chat
        emit(0.5)
        emit(0.6)
        emit(0.4)
        const glow = container.querySelector('[data-hud-audio-glow="beam"]')!
        expect(glow.hasAttribute('data-flowing')).toBe(true)
        expect(glow.parentElement!.querySelector('textarea')).not.toBeNull()
        expect(counts.chat).toBe(chatRenders)
        expect(container.querySelectorAll('[data-hud-audio-glow]')).toHaveLength(1)
        // Paused: gone.
        await render({ ...recording, paused: true })
        expect(container.querySelector('[data-hud-audio-glow]')).toBeNull()
        expect(listeners.size).toBe(0)
        level = 0
      }
    }
  })
})

describe('a countdown sent across windows', () => {
  function Countdown({ s }: { s: SpeakerIdentification }) {
    const seconds = useAutoAcceptCountdown(s)
    return h('span', { 'data-seconds': seconds ?? '' })
  }

  it('counts down to autoAcceptAt in its own leaf, with no provider and no tick store', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const s: SpeakerIdentification = { contactId: 'c', contactName: 'Sam', confidence: 0.8, isAutoMatched: true, isSuggestion: true, autoAcceptCountdown: 3, autoAcceptAt: 13_000 }
    await act(async () => root.render(h(Countdown, { s })))
    const seconds = () => container.querySelector('span')!.getAttribute('data-seconds')
    expect(seconds()).toBe('3')
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(seconds()).toBe('2')
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(seconds()).toBe('0')
    // Done: nothing left scheduled.
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('the web HUD feed store between calls', () => {
  it('is emptied when the call’s HUD goes, so the next call never opens on its conversation', async () => {
    rec.ctx = { liveModeEnabled: true, speakerNames: {}, selfDemotedLabels: new Set(), speakerContacts: {}, postSessionReview: null, selfSuggestion: null }
    const store = createHudFeedStore()
    await act(async () => root.render(h(InPageHudFeed, { captureId: 'cap-1', store })))
    store.set({ conversation })
    expect(store.get().conversation).toEqual(conversation)
    await act(async () => root.render(h('div')))
    expect(store.get()).toEqual(EMPTY_HUD_FEED)
  })
})
