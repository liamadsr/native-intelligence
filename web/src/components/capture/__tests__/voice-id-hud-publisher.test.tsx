// @vitest-environment jsdom
/**
 * The recording window's half of the live agent's HUD: on desktop, during a
 * live capture, it sends the HUD the Voice ID state (again when the HUD says
 * it's listening, and on every auto-accept tick) and the transcript's tail as
 * it streams (throttled, the latest flush always sent), and runs the HUD's
 * clicks through the recording's own handlers — for its own capture only.
 * Anywhere else it does nothing, and the composer keeps Voice ID.
 *
 * The header's recording controls (lib/live-agent/hud-recording.ts): the
 * state goes on each change (never a tick) and again on ready, with the
 * elapsed reading; their clicks (pause, resume, stop, back to the capture)
 * run through the recording's own handlers, for its own capture only (back
 * to the capture also raises this window via `focus_own_window`); the
 * controls are claimed (the top bar steps aside) only once the HUD listens,
 * and let go when the recording ends, which tells the HUD too.
 *
 * The meeting's scheduled time (lib/live-agent/hud-schedule.ts): read once
 * from the capture route's `schedule` variant, sent when known (none sends
 * `{ captureId: null }`) and again on ready, read again only when the
 * capture's event is re-linked. The person's pre-call brief
 * (lib/live-agent/hud-brief.ts) likewise, from the route's `brief` variant.
 *
 * The HUD's goal line (lib/live-agent/hud-goal.ts): a HUD_GOAL_ACTION_EVENT
 * for its own capture is written here (the capture's meeting asked for, then
 * PUT with source 'hud' and the capture, or DELETE for a clear), answered to
 * the HUD window with HUD_GOAL_RESULT_EVENT `{ id, ok }`, and the brief is
 * read again and re-sent; another capture's is left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (e: { payload: unknown }) => void
const env = vi.hoisted(() => ({
  desktop: true,
  ctx: null as null | Record<string, unknown>,
  speakers: [] as string[],
  active: null as string | null,
  ticks: new Map<unknown, number>(),
  tickListeners: new Set<() => void>(),
  sent: [] as Array<{ target: string; event: string; payload: unknown }>,
  segments: [] as Array<{ id: string; speaker: string; text: string; isFinal: boolean }>,
  segmentListeners: new Set<() => void>(),
  elapsed: 0,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  invoked: [] as Array<{ cmd: string; args: unknown }>,
  schedule: {} as Record<string, unknown>,
  brief: null as unknown,
  fetched: [] as string[],
}))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => env.desktop }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@tauri-apps/api/event', () => ({
  emitTo: async (target: string, event: string, payload: unknown) => {
    env.sent.push({ target, event, payload })
  },
  listen: async (event: string, cb: Handler) => {
    env.listeners.set(event, cb)
    return () => env.listeners.delete(event)
  },
}))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: async (cmd: string, args?: unknown) => {
    env.invoked.push({ cmd, args })
  },
}))
vi.mock('@/hooks/recording-context', () => ({
  useOptionalRecordingContext: () => env.ctx,
  useRecordingContext: () => env.ctx,
  useRecordingStable: () => ({
    getAutoAcceptTick: (s: unknown) => env.ticks.get(s),
    subscribeAutoAcceptTicks: (cb: () => void) => {
      env.tickListeners.add(cb)
      return () => env.tickListeners.delete(cb)
    },
    getTranscriptSegmentsSnapshot: () => env.segments,
    subscribeTranscriptSegments: (cb: () => void) => {
      env.segmentListeners.add(cb)
      return () => env.segmentListeners.delete(cb)
    },
  }),
  useDetectedSpeakers: () => env.speakers,
  useLiveActiveSpeaker: () => env.active,
}))

import { VoiceIdHudPublisher, useVoiceIdInHud } from '../voice-id-hud-publisher'
import {
  AGENT_HUD_WINDOW,
  VOICE_ID_HUD_ACTION_EVENT,
  VOICE_ID_HUD_READY_EVENT,
  VOICE_ID_HUD_STATE_EVENT,
  type VoiceIdHudState,
} from '@/lib/live-agent/voice-id-hud'
import { TRANSCRIPT_HUD_EMIT_MS, TRANSCRIPT_HUD_EVENT, type TranscriptHudTail } from '@/lib/live-agent/transcript-hud'
import {
  HUD_RECORDING_ACTION_EVENT,
  HUD_RECORDING_STATE_EVENT,
  __resetHudRecordingControlsForTests,
  hudShowsRecordingControls,
} from '@/lib/live-agent/hud-recording'
import { OPEN_CARD_EVENT } from '@/lib/chat-cards/open-card'
import { HUD_SCHEDULE_EVENT } from '@/lib/live-agent/hud-schedule'
import { HUD_BRIEF_EVENT } from '@/lib/live-agent/hud-brief'
import { MEETING_GOAL_CHANGED_EVENT } from '@/lib/meetings/meeting-goal'
import { HUD_GOAL_ACTION_EVENT, HUD_GOAL_RESULT_EVENT } from '@/lib/live-agent/hud-goal'
import { _resetMeetingGoalCacheForTests } from '@/hooks/use-meeting-goal'

const suggestion = { contactId: 'c-1', contactName: 'Sam', confidence: 0.8, isAutoMatched: true, isSuggestion: true, autoAcceptCountdown: 10 }

function recordingCtx(over: Record<string, unknown> = {}) {
  return {
    isRecording: true,
    liveModeEnabled: true,
    captureId: 'cap-1',
    speakerNames: {},
    selfDemotedLabels: new Set<string>(),
    speakerContacts: { remote_1: suggestion },
    postSessionReview: null,
    selfSuggestion: null,
    assignContact: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    unlinkSpeaker: vi.fn(),
    confirmPostSessionSpeaker: vi.fn(),
    reassignPostSessionSpeaker: vi.fn(),
    confirmSelf: vi.fn(),
    dismissSelf: vi.fn(),
    isPaused: false,
    isAgentFinalizing: false,
    transcriptionStatus: 'connected',
    getElapsed: () => env.elapsed,
    pauseRecording: vi.fn(),
    resumeRecording: vi.fn(),
    stopRecording: vi.fn(async () => {}),
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let inHud: boolean | null = null
function Probe() {
  inHud = useVoiceIdInHud()
  return h(VoiceIdHudPublisher)
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) })
const states = () => env.sent.filter((s) => s.event === VOICE_ID_HUD_STATE_EVENT)
const lastState = () => states().at(-1)?.payload as VoiceIdHudState
const tails = () => env.sent.filter((s) => s.event === TRANSCRIPT_HUD_EVENT).map((s) => s.payload as TranscriptHudTail)
async function mount() {
  await act(async () => root.render(h(Probe)))
  await flush()
}

beforeEach(() => {
  env.desktop = true
  env.ctx = recordingCtx()
  env.speakers = ['local_1', 'remote_1']
  env.active = 'remote_1'
  env.ticks.clear()
  env.tickListeners.clear()
  env.segments = []
  env.segmentListeners.clear()
  env.sent = []
  env.listeners.clear()
  env.elapsed = 0
  env.invoked = []
  __resetHudRecordingControlsForTests()
  env.schedule = { scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: '2026-10-17T16:00:00Z' }
  env.brief = null
  env.fetched = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    env.fetched.push(url)
    if (url.endsWith('fields=brief')) return { ok: true, json: async () => ({ capture: { id: 'cap-1', brief: env.brief } }) } as Response
    return { ok: true, json: async () => ({ capture: { id: 'cap-1', ...env.schedule } }) } as Response
  }))
  inHud = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('VoiceIdHudPublisher', () => {
  it('sends the HUD the Voice ID state during a live capture on desktop', async () => {
    await mount()
    expect(inHud).toBe(true)
    expect(states().every((s) => s.target === AGENT_HUD_WINDOW)).toBe(true)
    expect(lastState()).toMatchObject({
      captureId: 'cap-1',
      workspaceId: 'ws-1',
      detectedSpeakers: ['local_1', 'remote_1'],
      // Who spoke last rides the transcript's tail, never this state.
      activeSpeaker: null,
      speakerContacts: { remote_1: { ...suggestion, autoAcceptAt: expect.any(Number) } },
    })
  })

  it('sends it again when the HUD says it is listening, but never per countdown tick (the HUD counts down itself)', async () => {
    await mount()
    const before = states().length
    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: undefined }))
    await flush()
    expect(states().length).toBe(before + 1)

    const sent = states().length
    env.ticks.set(suggestion, 4)
    await act(async () => env.tickListeners.forEach((cb) => cb()))
    await flush()
    expect(states().length).toBe(sent)
    expect(env.tickListeners.size).toBe(0)
  })

  it("streams the transcript's tail — throttled, the latest flush always sent — and sends it whole when the HUD is ready", async () => {
    env.segments = [{ id: 's1', speaker: 'remote_1', text: 'hello there', isFinal: true }]
    await mount()
    expect(tails().at(-1)).toEqual({ captureId: 'cap-1', lines: [{ id: 's1', speaker: 'remote_1', text: 'hello there', final: true }] })
    const before = tails().length

    // A burst of flushes inside one window: one message, with the latest text.
    // On a frozen clock, so a slow run can't let the window lapse mid-burst
    // (which would send twice).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      for (const text of ['so', 'so we', 'so we should']) {
        env.segments = [...env.segments.slice(0, 1), { id: 's2', speaker: 'local_1', text, isFinal: false }]
        await act(async () => env.segmentListeners.forEach((cb) => cb()))
      }
      expect(tails().length).toBe(before)
      await act(async () => { await vi.advanceTimersByTimeAsync(TRANSCRIPT_HUD_EMIT_MS + 30) })
    } finally {
      vi.useRealTimers()
    }
    await flush()
    expect(tails().length).toBe(before + 1)
    expect(tails().at(-1)!.lines.at(-1)).toEqual({ id: 's2', speaker: 'local_1', text: 'so we should', final: false })

    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: undefined }))
    await flush()
    expect(tails().length).toBe(before + 2)
  })

  it("no longer relays the HUD's old ask box: the HUD's own chat talks to the live agent (one-chat Slice 4)", async () => {
    await mount()
    expect(env.listeners.has('agent-hud:say')).toBe(false)
    expect(env.sent.some((s) => s.event === 'agent-hud:reply')).toBe(false)
  })

  it("runs the HUD's clicks for its own capture through the recording's handlers", async () => {
    await mount()
    const action = env.listeners.get(VOICE_ID_HUD_ACTION_EVENT)!
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'acceptSuggestion', speaker: 'remote_1' } }))
    await act(async () =>
      action({ payload: { captureId: 'cap-1', type: 'assignContact', speaker: 'local_1', contactId: 'c-2', contactName: 'Ana' } }),
    )
    await act(async () => action({ payload: { captureId: 'cap-other', type: 'unlinkSpeaker', speaker: 'remote_1' } }))
    expect(env.ctx!.acceptSuggestion).toHaveBeenCalledWith('remote_1')
    expect(env.ctx!.assignContact).toHaveBeenCalledWith('local_1', 'c-2', 'Ana')
    expect(env.ctx!.unlinkSpeaker).not.toHaveBeenCalled()
  })

  it('sends the recording state on each change and on ready, never per second', async () => {
    env.elapsed = 336
    await mount()
    const recs = () => env.sent.filter((s) => s.event === HUD_RECORDING_STATE_EVENT)
    expect(recs()).toHaveLength(1)
    expect(recs()[0].target).toBe(AGENT_HUD_WINDOW)
    expect(recs()[0].payload).toEqual({
      captureId: 'cap-1',
      paused: false,
      finalizing: false,
      transcription: 'connected',
      elapsedSec: 336,
      at: expect.any(Number),
    })
    // The count going on sends nothing.
    env.elapsed = 340
    await act(async () => root.render(h(Probe)))
    await flush()
    expect(recs()).toHaveLength(1)
    // Paused: sent, with the reading then.
    env.ctx = recordingCtx({ isPaused: true })
    await mount()
    expect(recs().at(-1)!.payload).toMatchObject({ paused: true, elapsedSec: 340 })
    // Ready: sent again.
    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: null }))
    await flush()
    expect(recs()).toHaveLength(3)
  })

  it("runs the HUD's recording clicks for its own capture through the recording's handlers", async () => {
    await mount()
    const opened: unknown[] = []
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_CARD_EVENT, onOpen)
    const action = env.listeners.get(HUD_RECORDING_ACTION_EVENT)!
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'pause' } }))
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'resume' } }))
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'stop' } }))
    // Nothing raises the window before the way back is clicked.
    expect(env.invoked).toEqual([])
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'open' } }))
    await flush()
    await act(async () => action({ payload: { captureId: 'cap-other', type: 'stop' } }))
    await act(async () => action({ payload: { captureId: 'cap-1', type: 'explode' } }))
    await flush()
    window.removeEventListener(OPEN_CARD_EVENT, onOpen)
    expect(env.ctx!.pauseRecording).toHaveBeenCalledTimes(1)
    expect(env.ctx!.resumeRecording).toHaveBeenCalledTimes(1)
    expect(env.ctx!.stopRecording).toHaveBeenCalledTimes(1)
    // The capture's card, reusing the one in the chat (the top bar pill's way back).
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ from: 'capture', reuse: true })
    expect(JSON.stringify(opened[0])).toContain('cap-1')
    // And the way back raises this (the recording) window via the desktop's
    // own command, once: the other capture's click and the unknown one don't.
    // The command goes through a dynamic import, whose first load can outlast
    // a few ticks on a busy build machine, so wait for it rather than a count.
    await vi.waitFor(() => expect(env.invoked).toEqual([{ cmd: 'focus_own_window', args: undefined }]), {
      timeout: 10_000,
    })
  }, 15_000)

  it('claims the controls once the HUD listens, and lets go (telling the HUD) when the recording ends', async () => {
    await mount()
    // Not before the HUD says it's listening: the top bar keeps its pill.
    expect(hudShowsRecordingControls('cap-1')).toBe(false)
    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: null }))
    expect(hudShowsRecordingControls('cap-1')).toBe(true)
    env.ctx = recordingCtx({ isRecording: false })
    await mount()
    expect(hudShowsRecordingControls('cap-1')).toBe(false)
    expect(env.sent.filter((s) => s.event === HUD_RECORDING_STATE_EVENT).at(-1)!.payload).toEqual({ captureId: null })
  })

  it("sends the meeting's scheduled time once read, and again on ready", async () => {
    await mount()
    const schedules = () => env.sent.filter((s) => s.event === HUD_SCHEDULE_EVENT)
    const scheduleReads = () => env.fetched.filter((u) => u.endsWith('fields=schedule'))
    expect(scheduleReads()).toEqual(['/api/account/captures/cap-1?fields=schedule'])
    expect(schedules().every((s) => s.target === AGENT_HUD_WINDOW)).toBe(true)
    expect(schedules().at(-1)!.payload).toEqual({
      captureId: 'cap-1',
      start: Date.parse('2026-10-17T15:00:00Z'),
      end: Date.parse('2026-10-17T16:00:00Z'),
    })
    const before = schedules().length
    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: null }))
    await flush()
    expect(schedules()).toHaveLength(before + 1)
    // Re-renders read nothing more.
    await act(async () => root.render(h(Probe)))
    await flush()
    expect(scheduleReads()).toHaveLength(1)
  })

  it('a capture with no scheduled end sends none, and its re-linked event is read again', async () => {
    env.schedule = { scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: null }
    await mount()
    const schedules = () => env.sent.filter((s) => s.event === HUD_SCHEDULE_EVENT)
    expect(schedules().at(-1)!.payload).toEqual({ captureId: null })
    env.schedule = { scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: '2026-10-17T15:30:00Z' }
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-1' } })))
    await flush()
    expect(env.fetched.filter((u) => u.endsWith('fields=schedule'))).toHaveLength(2)
    expect(schedules().at(-1)!.payload).toMatchObject({ captureId: 'cap-1', end: Date.parse('2026-10-17T15:30:00Z') })
  })

  it("sends the person's pre-call brief once read, again on ready, and none as `{ captureId: null }`", async () => {
    env.brief = { goal: 'Close the pilot', prep: { documentId: 'doc-1', title: 'Prep — Acme', top: 'On you: SOW' } }
    await mount()
    const briefs = () => env.sent.filter((s) => s.event === HUD_BRIEF_EVENT)
    expect(env.fetched.filter((u) => u.endsWith('fields=brief'))).toEqual(['/api/account/captures/cap-1?fields=brief'])
    expect(briefs().every((s) => s.target === AGENT_HUD_WINDOW)).toBe(true)
    expect(briefs().at(-1)!.payload).toEqual({ captureId: 'cap-1', goal: 'Close the pilot', prepTitle: 'Prep — Acme', prepTop: 'On you: SOW' })
    const before = briefs().length
    await act(async () => env.listeners.get(VOICE_ID_HUD_READY_EVENT)!({ payload: null }))
    await flush()
    expect(briefs()).toHaveLength(before + 1)
    // The capture edited (the goal or its prep changed): read again; gone sends none.
    env.brief = null
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-1' } })))
    await flush()
    expect(env.fetched.filter((u) => u.endsWith('fields=brief'))).toHaveLength(2)
    expect(briefs().at(-1)!.payload).toEqual({ captureId: null })
  })

  it('a goal saved mid-call in this window reaches the HUD window: read again and re-sent', async () => {
    await mount()
    const briefs = () => env.sent.filter((s) => s.event === HUD_BRIEF_EVENT)
    expect(briefs().at(-1)!.payload).toEqual({ captureId: null })
    env.brief = { goal: 'Close the pilot', prep: null }
    await act(async () =>
      window.dispatchEvent(new CustomEvent(MEETING_GOAL_CHANGED_EVENT, { detail: { calendarEventId: 'e', startsAt: '2026-10-18T15:00:00.000Z', captureId: 'cap-1' } })),
    )
    await flush()
    expect(briefs().at(-1)).toEqual({
      target: AGENT_HUD_WINDOW,
      event: HUD_BRIEF_EVENT,
      payload: { captureId: 'cap-1', goal: 'Close the pilot', prepTitle: null, prepTop: null },
    })
  })

  it("writes the HUD's goal for its own capture, answers the HUD, and re-sends the brief", async () => {
    _resetMeetingGoalCacheForTests()
    const writes: Array<{ url: string; method: string; body: unknown }> = []
    let putOk = true
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      env.fetched.push(url)
      if (url.startsWith('/api/account/meeting-goal?capture_id=')) {
        // An ad-hoc call: the capture's own synthetic meeting.
        return { ok: true, json: async () => ({ goal: null, meeting: { calendarEventId: 'capture:cap-1', startsAt: '2026-10-18T15:00:00.000Z' } }) } as Response
      }
      if (url.startsWith('/api/account/meeting-goal')) {
        writes.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
        return { ok: putOk, json: async () => ({}) } as Response
      }
      if (url.endsWith('fields=brief')) return { ok: true, json: async () => ({ capture: { id: 'cap-1', brief: env.brief } }) } as Response
      return { ok: true, json: async () => ({ capture: { id: 'cap-1', ...env.schedule } }) } as Response
    }))
    await mount()
    const results = () => env.sent.filter((s) => s.event === HUD_GOAL_RESULT_EVENT)
    const briefReads = () => env.fetched.filter((u) => u.endsWith('fields=brief')).length
    const readsBefore = briefReads()
    env.brief = { goal: 'Close the pilot', prep: null }
    await act(async () => env.listeners.get(HUD_GOAL_ACTION_EVENT)!({ payload: { captureId: 'cap-1', id: 'g-1', type: 'set', goal: ' Close the pilot ' } }))
    await flush()
    expect(env.fetched).toContain('/api/account/meeting-goal?capture_id=cap-1')
    expect(writes).toEqual([
      {
        url: '/api/account/meeting-goal',
        method: 'PUT',
        body: { calendar_event_id: 'capture:cap-1', starts_at: '2026-10-18T15:00:00.000Z', capture_id: 'cap-1', goal: 'Close the pilot', source: 'hud' },
      },
    ])
    expect(results()).toEqual([{ target: AGENT_HUD_WINDOW, event: HUD_GOAL_RESULT_EVENT, payload: { id: 'g-1', ok: true } }])
    // The write said so on this window: the brief was read again and re-sent with the goal.
    expect(briefReads()).toBe(readsBefore + 1)
    expect(env.sent.filter((s) => s.event === HUD_BRIEF_EVENT).at(-1)!.payload).toMatchObject({ captureId: 'cap-1', goal: 'Close the pilot' })

    // A clear is a DELETE of the same meeting; a failed write answers ok: false.
    putOk = false
    await act(async () => env.listeners.get(HUD_GOAL_ACTION_EVENT)!({ payload: { captureId: 'cap-1', id: 'g-2', type: 'clear', goal: '' } }))
    await flush()
    expect(writes.at(-1)).toMatchObject({ method: 'DELETE', url: expect.stringContaining('calendar_event_id=capture%3Acap-1') })
    expect(results().at(-1)!.payload).toEqual({ id: 'g-2', ok: false })

    // Another capture's, or junk: not this window's to run, no answer.
    await act(async () => env.listeners.get(HUD_GOAL_ACTION_EVENT)!({ payload: { captureId: 'cap-9', id: 'g-3', type: 'set', goal: 'x' } }))
    await act(async () => env.listeners.get(HUD_GOAL_ACTION_EVENT)!({ payload: { captureId: 'cap-1', id: 'g-4', type: 'set', goal: '   ' } }))
    await flush()
    expect(results()).toHaveLength(2)
    expect(writes).toHaveLength(2)
  })

  it('does nothing — and the composer keeps Voice ID — off desktop, between captures, or outside the provider', async () => {
    for (const setup of [
      () => { env.desktop = false },
      () => { env.ctx = recordingCtx({ isRecording: false }) },
      () => { env.ctx = recordingCtx({ captureId: null }) },
      () => { env.ctx = null },
    ]) {
      env.desktop = true
      env.ctx = recordingCtx()
      env.sent = []
      env.listeners.clear()
      setup()
      await mount()
      expect(inHud).toBe(false)
      expect(env.sent).toEqual([])
      expect(env.listeners.size).toBe(0)
    }
  })
})
