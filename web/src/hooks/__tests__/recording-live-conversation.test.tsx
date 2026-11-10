// @vitest-environment jsdom
/**
 * The live conversation follows the agent that is actually listening in.
 *
 * recording-context opens the capture's chat conversation (POST
 * /api/account/chat-history/live) when a live recording starts, with whatever
 * agent is selected at that moment. The capture panel's live lock often selects
 * the agent a beat LATER — so when the agent changes mid-call the provider must
 * re-open with the new id (the route re-points the row), and the event it
 * dispatches must carry the agent the server pinned, which the chat tab uses as
 * its agent. These tests lock that in, plus the two guards: never open before
 * the recording has, and never let a later open overtake an earlier one.
 *
 * useRecording is mocked (as in recording-start.test.tsx) so only the
 * provider's wrapper logic runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { createElement as h, act, useEffect } from 'react'

const mockRecording = {
  isRecording: false,
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async () => {}),
  clearSessionAccumulators: vi.fn(),
  getTranscriptSegmentsSnapshot: () => [],
  subscribeTranscriptSegments: () => () => {},
  getFinalSegmentCount: () => 0,
  subscribeFinalSegmentCount: () => () => {},
  getLevels: () => ({ micLevel: 0, systemLevel: 0, timestamp: 0 }),
  subscribeLevels: () => () => {},
  getElapsed: () => 0,
  subscribeElapsed: () => () => {},
  transcriptSegments: [],
  recordingError: null,
  transcriptionStatus: 'connected',
  speakerContacts: {},
  isAgentFinalizing: false,
}

vi.mock('../use-recording', () => ({
  useRecording: () => mockRecording,
}))
vi.mock('@/lib/capture-cache', () => ({
  seedCaptureCache: vi.fn(),
  captureDetailCache: new Map(),
  CAPTURE_CACHE_MAX: 20,
  writeCaptureCache: vi.fn(),
  registerPendingCaptureCreate: vi.fn(),
  captureRowReady: vi.fn(async () => true),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }) } }),
}))

import { RecordingProvider, useRecordingContext, useRecordingStable } from '../recording-context'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The agent the fake /live route pins when the request names none. */
const DEFAULT_AGENT = 'rec-default'

let liveOpens: Array<{ recipe_id: unknown }> = []
/** When set, /live responses wait until released (in arrival order). */
let holdLiveResponses = false
const heldLiveResponses: Array<() => void> = []

function installFetch() {
  liveOpens = []
  holdLiveResponses = false
  heldLiveResponses.length = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method || 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    if (url === '/api/account/captures' && method === 'POST') {
      return Promise.resolve({ ok: true, json: async () => ({ capture: { id: body.id, title: 'T' } }) } as Response)
    }
    if (url === '/api/account/chat-history/live' && method === 'POST') {
      liveOpens.push({ recipe_id: body.recipe_id })
      const respond = () => ({
        ok: true,
        json: async () => ({
          conversationId: 'conv-1',
          recipeId: body.recipe_id ?? DEFAULT_AGENT,
          created: liveOpens.length === 1,
        }),
      }) as Response
      if (!holdLiveResponses) return Promise.resolve(respond())
      return new Promise((res) => { heldLiveResponses.push(() => res(respond())) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
  }))
}

const holder: {
  start: (() => Promise<void>) | null
  setAgentId: ((id: string | null) => void) | null
  setLiveModeEnabled: ((on: boolean) => void) | null
  captureId: string | null
} = { start: null, setAgentId: null, setLiveModeEnabled: null, captureId: null }

function Grabber() {
  const { startRecording, registerNavigate, unregisterNavigate, captureId } = useRecordingStable()
  const { setAgentId, setLiveModeEnabled } = useRecordingContext()
  useEffect(() => {
    holder.start = startRecording
    holder.setAgentId = setAgentId
    holder.setLiveModeEnabled = setLiveModeEnabled
  }, [startRecording, setAgentId, setLiveModeEnabled])
  useEffect(() => {
    registerNavigate(() => {}, () => {})
    return () => unregisterNavigate()
  }, [registerNavigate, unregisterNavigate])
  useEffect(() => { holder.captureId = captureId })
  return null
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let events: Array<{ conversationId: string; captureId: string; recipeId?: string | null }> = []
const onEvent = (e: Event) => { events.push((e as CustomEvent).detail) }

beforeEach(async () => {
  mockRecording.isRecording = false
  localStorage.clear()
  installFetch()
  events = []
  window.addEventListener('ni:live-capture-conversation', onEvent)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(h(RecordingProvider, null, h(Grabber))) })
})
afterEach(async () => {
  window.removeEventListener('ni:live-capture-conversation', onEvent)
  await act(async () => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

/** Live mode on, then a recording started with no agent selected yet — the
 *  common order when the capture panel's live lock lands after the click. */
async function startLiveRecording() {
  await act(async () => { holder.setLiveModeEnabled!(true) })
  await act(async () => { await holder.start!() })
  mockRecording.isRecording = true
}

describe('the live conversation follows the listening agent', () => {
  it('opens with the start-time agent, then re-points when the agent changes mid-call', async () => {
    await startLiveRecording()
    expect(liveOpens).toEqual([{ recipe_id: null }])

    await act(async () => { holder.setAgentId!('rec-live') })

    expect(liveOpens).toEqual([{ recipe_id: null }, { recipe_id: 'rec-live' }])
    // Each event carries the agent the SERVER pinned (the default for a bare
    // open), not the request — that is what the chat tab talks as.
    expect(events.map((e) => e.recipeId)).toEqual([DEFAULT_AGENT, 'rec-live'])
    expect(events.every((e) => e.conversationId === 'conv-1' && e.captureId === holder.captureId)).toBe(true)
  })

  it('does not re-open for the agent it already sent', async () => {
    await act(async () => { holder.setAgentId!('rec-live') })
    await startLiveRecording()
    expect(liveOpens).toEqual([{ recipe_id: 'rec-live' }])

    // The first render that sees isRecording=true re-runs the effect (a dep
    // changed) with the very agent the open already carried: no second open.
    await act(async () => { root.render(h(RecordingProvider, null, h(Grabber))) })
    expect(liveOpens).toHaveLength(1)
  })

  it('every start is live: one after live mode was switched off (in code — no UI offers it) opens the conversation', async () => {
    await act(async () => { holder.setLiveModeEnabled!(false) })
    await act(async () => { await holder.start!() })
    expect(liveOpens).toEqual([{ recipe_id: null }])
  })

  it('never opens the conversation before the recording has', async () => {
    await act(async () => { holder.setLiveModeEnabled!(true) })
    await act(async () => { holder.setAgentId!('rec-live') })
    expect(liveOpens).toHaveLength(0)
  })

  it('queues a mid-call re-point behind an open still in flight', async () => {
    holdLiveResponses = true
    await startLiveRecording()
    expect(liveOpens).toHaveLength(1)

    await act(async () => { holder.setAgentId!('rec-live') })
    // The re-point waits: sending it now could let the stale first open land on
    // the conversation last.
    expect(liveOpens).toHaveLength(1)

    await act(async () => { heldLiveResponses.shift()!() })
    expect(liveOpens).toEqual([{ recipe_id: null }, { recipe_id: 'rec-live' }])

    await act(async () => { heldLiveResponses.shift()!() })
    expect(events.map((e) => e.recipeId)).toEqual([DEFAULT_AGENT, 'rec-live'])
  })
})
