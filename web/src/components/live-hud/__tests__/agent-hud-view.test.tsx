// @vitest-environment jsdom
/**
 * AgentHudView: the live agent's HUD, one view for both hosts. Pins:
 *   - it renders the same whatever feeds it: a plain feed, the desktop HUD
 *     window (Tauri events from the recording window), and the web panel (the
 *     recording context, through InPageHudFeed);
 *   - the header (what the agent is doing: the agent's face and name are
 *     gone, 10-17), a chip per voice with a static highlight on whoever spoke
 *     last, Voice ID's actions on the chips, and the chat for the call's
 *     conversation with the nudges handed to it; the old speaker sheets and
 *     terminal are gone;
 *   - the meeting's scheduled time reaches the view from either host: the
 *     recording window's HUD_SCHEDULE_EVENT on desktop (another capture's,
 *     or none, dropped), the capture route's `schedule` variant on web;
 *   - likewise the person's pre-call brief for the Briefing line: the
 *     recording window's HUD_BRIEF_EVENT on desktop, the capture route's
 *     `brief` variant on web; none renders no line;
 *   - the goal line, where the host can save a goal (both hosts do): the
 *     goal above the Briefing line (which keeps to the prep), "Set a goal"
 *     only while the call is up; a save goes to the recording window as
 *     HUD_GOAL_ACTION_EVENT from the desktop window (its answer keeps or
 *     reverts it; none within the cap reverts), and through the recording
 *     window's own write on web (the capture's meeting, then PUT with source
 *     'hud', then the brief read again);
 *   - the desktop window asks the recording window for everything once it
 *     listens, tells Rust it's ready for buffered nudges, keeps the
 *     workspace in memory only, sends Voice ID clicks back, and before a send
 *     asks the recording window to flush, waiting for its answer (or the cap).
 *   - the recording's controls on the header's right (moved from the top
 *     bar, lib/live-agent/hud-recording.ts): there only while recording;
 *     each click reaches the recording's handlers on web and goes back as
 *     HUD_RECORDING_ACTION_EVENT from the desktop window; the web panel
 *     claims them (the top bar steps aside) while it's up.
 * LiveChat is stubbed to its props (its own tests pin the chat).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const chatProps = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }))
vi.mock('@/components/live-chat/live-chat', () => ({
  LiveChat: (props: Record<string, unknown>) => {
    chatProps.last = props
    const nudges = (props.nudges as Array<{ id: string }> | undefined) ?? []
    return h('div', {
      'data-chat-stub': '',
      'data-conversation': props.conversationId as string,
      'data-agent': (props.agentId as string | null) ?? '',
      'data-workspace': (props.workspaceId as string | null) ?? '',
      'data-nudges': nudges.map((n) => n.id).join(','),
    })
  },
}))

type Handler = (e: { payload: unknown }) => void
const tauri = vi.hoisted(() => ({
  global: new Map<string, (e: { payload: unknown }) => void>(),
  window: new Map<string, (e: { payload: unknown }) => void>(),
  emitted: [] as Array<{ event: string; payload: unknown }>,
  invoked: [] as string[],
  order: [] as string[],
  onEmit: null as null | ((event: string, payload: unknown) => void),
  drags: 0,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (event: string, cb: Handler) => {
    tauri.global.set(event, cb)
    tauri.order.push(`listen:${event}`)
    return () => tauri.global.delete(event)
  },
  emit: async (event: string, payload?: unknown) => {
    tauri.emitted.push({ event, payload })
    tauri.onEmit?.(event, payload)
  },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({
    listen: async (event: string, cb: Handler) => {
      tauri.window.set(event, cb)
      return () => tauri.window.delete(event)
    },
    startDragging: async () => {
      tauri.drags++
    },
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    tauri.invoked.push(cmd)
    tauri.order.push(`invoke:${cmd}`)
  },
}))
vi.mock('@/lib/workspace-fetch', () => ({ setClientWorkspaceId: vi.fn(), getClientWorkspaceId: () => 'ws-1' }))

// The recording, for the web host.
const rec = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  speakers: [] as string[],
  active: null as string | null,
  stable: null as null | Record<string, unknown>,
}))
vi.mock('@/hooks/recording-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/recording-context')>()),
  useRecordingContext: () => rec.ctx,
  useDetectedSpeakers: () => rec.speakers,
  useLiveActiveSpeaker: () => rec.active,
  useOptionalRecordingStable: () => rec.stable,
}))

import { AgentHudView, HUD_WINDOW_CLIP } from '../agent-hud-view'
import { EMPTY_HUD_FEED, createHudFeedStore, type AgentHudFeed } from '../hud-feed'
import { WebHud } from '../web-hud'
import { AgentHud, flushRecordingWindow } from '@/app/hud/agent/agent-hud'
import { setClientWorkspaceId } from '@/lib/workspace-fetch'
import { VOICE_ID_HUD_ACTION_EVENT, VOICE_ID_HUD_READY_EVENT, VOICE_ID_HUD_STATE_EVENT, type VoiceIdHudState } from '@/lib/live-agent/voice-id-hud'
import { TRANSCRIPT_HUD_EVENT } from '@/lib/live-agent/transcript-hud'
import {
  LIVE_CAPTURE_CONVERSATION_EVENT,
  LIVE_HUD_CONVERSATION_EVENT,
  LIVE_HUD_FLUSHED_EVENT,
  LIVE_HUD_FLUSH_EVENT,
  __resetLiveCaptureConversationsForTests,
} from '@/lib/live-agent/live-hud'
import { __resetLiveAgentNamesForTests } from '../use-live-agent-name'
import {
  HUD_RECORDING_ACTION_EVENT,
  HUD_RECORDING_STATE_EVENT,
  __resetHudRecordingControlsForTests,
  hudShowsRecordingControls,
  type HudRecordingState,
} from '@/lib/live-agent/hud-recording'
import { OPEN_CARD_EVENT } from '@/lib/chat-cards/open-card'
import { HUD_SCHEDULE_EVENT } from '@/lib/live-agent/hud-schedule'
import { HUD_BRIEF_EVENT } from '@/lib/live-agent/hud-brief'
import { MEETING_GOAL_CHANGED_EVENT } from '@/lib/meetings/meeting-goal'
import { HUD_GOAL_ACK_CAP_MS, HUD_GOAL_ACTION_EVENT, HUD_GOAL_RESULT_EVENT } from '@/lib/live-agent/hud-goal'
import { requestHudGoal } from '@/app/hud/agent/agent-hud'
import { _resetMeetingGoalCacheForTests } from '@/hooks/use-meeting-goal'

const VOICE_ID: VoiceIdHudState = {
  captureId: 'cap-1',
  workspaceId: 'ws-1',
  detectedSpeakers: ['local_1', 'remote_1'],
  activeSpeaker: 'remote_1',
  speakerNames: {},
  demotedSelfLabels: [],
  speakerContacts: {
    remote_1: { contactId: 'c-1', contactName: 'Sam Rivera', confidence: 0.82, isAutoMatched: true, isSuggestion: true, autoAcceptCountdown: 6 },
  },
  postSessionReview: null,
  selfSuggestion: null,
}
const CONVERSATION = { captureId: 'cap-1', conversationId: 'conv-1', agentId: 'agent-7', workspaceId: 'ws-1' }
const NUDGE = { id: 'n1', message: 'Ask about timing.', kind: 'reminder' }

let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  tauri.global.clear()
  tauri.window.clear()
  tauri.emitted = []
  tauri.invoked = []
  tauri.order = []
  tauri.onEmit = null
  tauri.drags = 0
  chatProps.last = null
  vi.mocked(setClientWorkspaceId).mockClear()
  __resetLiveCaptureConversationsForTests()
  __resetLiveAgentNamesForTests()
  __resetHudRecordingControlsForTests()
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/api/account/agents/agent-7'
      ? ({ ok: true, json: async () => ({ agent: { id: 'agent-7', name: 'Sales Coach' } }) } as Response)
      : ({ ok: false, json: async () => ({}) } as Response),
  ))
  // The HUD's box is ~430px wide: wide enough for its placeholder.
  vi.spyOn(HTMLTextAreaElement.prototype, 'clientWidth', 'get').mockReturnValue(430)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** What the view shows, host aside. */
function snapshot() {
  return {
    state: container.querySelector('[data-hud-state]')?.textContent,
    participants: [...container.querySelectorAll('[data-participant]')].map((el) => ({
      speaker: el.getAttribute('data-participant'),
      speaking: el.getAttribute('data-speaking') === 'true',
      text: el.textContent,
    })),
    chat: (() => {
      const stub = container.querySelector('[data-chat-stub]')
      return stub && {
        conversation: stub.getAttribute('data-conversation'),
        agent: stub.getAttribute('data-agent'),
        workspace: stub.getAttribute('data-workspace'),
        nudges: stub.getAttribute('data-nudges'),
      }
    })(),
  }
}

const FEED: AgentHudFeed = { voiceId: VOICE_ID, lastSpeaker: 'local_1', nudges: [NUDGE], conversation: CONVERSATION, recording: null, schedule: null, brief: null }
const EXPECTED = {
  state: 'Listening to the call',
  participants: [
    { speaker: 'local_1', speaking: true, text: expect.stringContaining('You') },
    { speaker: 'remote_1', speaking: false, text: expect.stringContaining('Sam Rivera (82%)') },
  ],
  chat: { conversation: 'conv-1', agent: 'agent-7', workspace: 'ws-1', nudges: 'n1' },
}

describe('one view, whatever feeds it', () => {
  it('a plain feed', async () => {
    await act(async () => root.render(h(AgentHudView, { host: 'page', feed: FEED, actions: { sendVoiceIdAction: () => {} } })))
    await flush()
    expect(snapshot()).toEqual(EXPECTED)
    // The agent's name is the chat's (its messages), no longer the header's.
    expect(chatProps.last!.agentName).toBe('Sales Coach')
    expect(container.querySelector('[data-hud-header]')!.textContent).not.toContain('Sales Coach')
    // No speaker sheets, no aura canvas, no terminal line.
    expect(container.querySelector('canvas, .sheet-fallback, .hud-terminal, [aria-label="Live transcript"]')).toBeNull()
  })

  it('the desktop window, from the recording window’s events', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    // Listening first, then asking for everything; ready for the buffered nudges.
    expect(tauri.emitted.map((e) => e.event)).toContain(VOICE_ID_HUD_READY_EVENT)
    expect(tauri.order.indexOf('invoke:agent_hud_ready')).toBeGreaterThan(tauri.order.indexOf('listen:agent-nudge'))
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    await act(async () =>
      tauri.window.get(TRANSCRIPT_HUD_EVENT)!({
        payload: { captureId: 'cap-1', lines: [{ id: 'a', speaker: 'remote_1', text: 'hello', final: true }, { id: 'b', speaker: 'local_1', text: 'hi there', final: false }] },
      }),
    )
    await act(async () => tauri.window.get(LIVE_HUD_CONVERSATION_EVENT)!({ payload: CONVERSATION }))
    await act(async () => tauri.global.get('agent-nudge')!({ payload: NUDGE }))
    await act(async () => tauri.global.get('agent-nudge')!({ payload: NUDGE }))
    await flush()
    expect(snapshot()).toEqual(EXPECTED)
    expect(setClientWorkspaceId).toHaveBeenCalledWith('ws-1', { persist: false })
  })

  it('the web panel, from the recording context', async () => {
    rec.ctx = {
      liveModeEnabled: true,
      speakerNames: {},
      selfDemotedLabels: new Set<string>(),
      speakerContacts: VOICE_ID.speakerContacts,
      postSessionReview: null,
      selfSuggestion: null,
    }
    rec.speakers = ['local_1', 'remote_1']
    rec.active = 'local_1'
    rec.stable = { isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: vi.fn(async () => {}) }
    const store = createHudFeedStore()
    store.pushNudge(NUDGE)
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store })))
    // The recording context announces the capture's conversation.
    await act(async () =>
      window.dispatchEvent(new CustomEvent(LIVE_CAPTURE_CONVERSATION_EVENT, { detail: { conversationId: 'conv-1', captureId: 'cap-1', cwd: null, recipeId: 'agent-7' } })),
    )
    // A new call starts from nothing: the nudge pushed before it is gone; one pushed now shows.
    await act(async () => store.pushNudge(NUDGE))
    await flush()
    expect(snapshot()).toEqual(EXPECTED)
  })
})

describe('the desktop window', () => {
  it('sends Voice ID clicks back with the capture id', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    await act(async () => (container.querySelector('[aria-label="Yes, this is Sam Rivera"]') as HTMLButtonElement).click())
    await flush()
    expect(tauri.emitted.filter((e) => e.event === VOICE_ID_HUD_ACTION_EVENT).map((e) => e.payload)).toEqual([
      { captureId: 'cap-1', type: 'acceptSuggestion', speaker: 'remote_1' },
    ])
  })

  it('drops a conversation for another capture than Voice ID is on', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    await act(async () => tauri.window.get(LIVE_HUD_CONVERSATION_EVENT)!({ payload: { ...CONVERSATION, captureId: 'cap-0' } }))
    expect(container.querySelector('[data-chat-stub]')).toBeNull()
    expect(container.querySelector('textarea')!.placeholder).toBe('Waiting for the call…')
  })

  it('hands the chat a beforeSend that flushes the recording window and waits for its word', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    await act(async () => tauri.window.get(LIVE_HUD_CONVERSATION_EVENT)!({ payload: CONVERSATION }))
    const beforeSend = chatProps.last!.beforeSend as () => Promise<void>
    // The recording window answers the flush it was asked for.
    tauri.onEmit = (event, payload) => {
      if (event !== LIVE_HUD_FLUSH_EVENT) return
      const { id } = payload as { id: string }
      setTimeout(() => tauri.window.get(LIVE_HUD_FLUSHED_EVENT)?.({ payload: { id } }), 5)
    }
    let done = false
    await act(async () => {
      await beforeSend().then(() => {
        done = true
      })
    })
    expect(done).toBe(true)
    expect(tauri.emitted.find((e) => e.event === LIVE_HUD_FLUSH_EVENT)!.payload).toEqual({ captureId: 'cap-1', id: expect.any(String) })
  })

  it("moves by a press anywhere that isn't a control, never a double-click", async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    const press = async (el: Element, detail = 1) => {
      await act(async () => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail })))
      await flush()
    }
    await press(container.querySelector('[data-participants]')!)
    await press(container.querySelector('.agent-hud')!)
    expect(tauri.drags).toBe(2)
    await press(container.querySelector('[data-participant] button')!)
    await press(container.querySelector('textarea')!)
    await press(container.querySelector('[data-participants]')!, 2)
    expect(tauri.drags).toBe(2)
  })

  it('stops waiting at the cap when no recording window answers', async () => {
    vi.useFakeTimers()
    let done = false
    const p = flushRecordingWindow('cap-1').then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1300)
    await p
    expect(done).toBe(true)
    vi.useRealTimers()
  })
})

describe('the recording controls in the header', () => {
  const REC: HudRecordingState = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected', elapsedSec: 336, at: Date.now() }
  const controls = () => container.querySelector('[data-hud-recording]')
  const button = (label: string) => container.querySelector(`[data-hud-recording] button[aria-label^="${label}"]`) as HTMLButtonElement
  const click = (label: string) => act(async () => button(label).click())

  it('show on the header only while recording, and each click goes to the host with the capture', async () => {
    const sendRecordingAction = vi.fn()
    const render = (recording: HudRecordingState | null) =>
      act(async () => root.render(h(AgentHudView, { host: 'page', feed: { ...FEED, recording }, actions: { sendVoiceIdAction: () => {}, sendRecordingAction } })))
    await render(null)
    expect(controls()).toBeNull()

    // Read now, not when the file was collected: the elapsed counts on in
    // real time from `at`, so a stale stamp on a slow run would show 5:37.
    await render({ ...REC, at: Date.now() })
    const tag = container.querySelector('[data-hud-header]')!
    expect(tag.contains(controls())).toBe(true)
    expect(controls()!.textContent).toContain('Recording')
    expect(container.querySelector('[data-hud-elapsed]')!.textContent).toBe('5:36')
    await click('Recording: return')
    await click('Pause recording')
    await click('Stop recording')
    expect(sendRecordingAction.mock.calls.map((c) => c[0])).toEqual([
      { captureId: 'cap-1', type: 'open' },
      { captureId: 'cap-1', type: 'pause' },
      { captureId: 'cap-1', type: 'stop' },
    ])

    await render({ ...REC, paused: true })
    await click('Resume recording')
    expect(sendRecordingAction).toHaveBeenLastCalledWith({ captureId: 'cap-1', type: 'resume' })
    // Finishing up: pause and stop wait.
    await render({ ...REC, finalizing: true })
    expect(button('Pause recording').disabled).toBe(true)
    expect(button('Stop recording').disabled).toBe(true)

    await render(null)
    expect(controls()).toBeNull()
  })

  it('the desktop window: from the recording window’s state, clicks go back as events', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    expect(controls()).toBeNull()
    await act(async () => tauri.window.get(HUD_RECORDING_STATE_EVENT)!({ payload: REC }))
    expect(controls()).not.toBeNull()
    await click('Pause recording')
    await click('Stop recording')
    await click('Recording: return')
    await flush()
    expect(tauri.emitted.filter((e) => e.event === HUD_RECORDING_ACTION_EVENT).map((e) => e.payload)).toEqual([
      { captureId: 'cap-1', type: 'pause' },
      { captureId: 'cap-1', type: 'stop' },
      { captureId: 'cap-1', type: 'open' },
    ])
    // The recording ended.
    await act(async () => tauri.window.get(HUD_RECORDING_STATE_EVENT)!({ payload: { captureId: null } }))
    expect(controls()).toBeNull()
  })

  it("the web panel: the recording's own handlers, and the top bar steps aside while it's up", async () => {
    const stable = {
      isRecording: true,
      captureId: 'cap-1',
      flushTranscriptForAgent: vi.fn(async () => {}),
      pauseRecording: vi.fn(),
      resumeRecording: vi.fn(),
      stopRecording: vi.fn(async () => {}),
    }
    rec.ctx = {
      liveModeEnabled: true,
      speakerNames: {},
      selfDemotedLabels: new Set<string>(),
      speakerContacts: {},
      postSessionReview: null,
      selfSuggestion: null,
      isRecording: true,
      isPaused: false,
      isAgentFinalizing: false,
      transcriptionStatus: 'connected',
      getElapsed: () => 336,
    }
    rec.speakers = []
    rec.stable = stable
    const opened: unknown[] = []
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener(OPEN_CARD_EVENT, onOpen)
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store: createHudFeedStore() })))
    await flush()
    expect(hudShowsRecordingControls('cap-1')).toBe(true)
    expect(container.querySelector('[data-hud-elapsed]')!.textContent).toBe('5:36')
    await click('Pause recording')
    await click('Stop recording')
    await click('Recording: return')
    window.removeEventListener(OPEN_CARD_EVENT, onOpen)
    expect(stable.pauseRecording).toHaveBeenCalledTimes(1)
    expect(stable.stopRecording).toHaveBeenCalledTimes(1)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ from: 'capture', reuse: true })

    await act(async () => root.render(h('div')))
    expect(hudShowsRecordingControls('cap-1')).toBe(false)
  })
})

it('in its own window, nothing paints past the sheet’s round corners (no square shadow "ears"); a page panel keeps its shadow', async () => {
  const props = { feed: EMPTY_HUD_FEED, actions: { sendVoiceIdAction: () => {} } }
  await act(async () => root.render(h(AgentHudView, { host: 'window', ...props })))
  const hud = () => container.querySelector<HTMLElement>('.agent-hud')!
  const sheet = () => container.querySelector<HTMLElement>('[data-bot-bubble-backdrop]')!
  expect(hud().className).toContain(HUD_WINDOW_CLIP)
  expect(sheet().className).toContain('rounded-[28px]')
  expect(sheet().classList.contains('shadow-none')).toBe(true)
  await act(async () => root.render(h(AgentHudView, { host: 'page', ...props })))
  expect(hud().className).not.toContain(HUD_WINDOW_CLIP)
  expect(sheet().classList.contains('shadow-none')).toBe(false)
})

it('an empty feed waits for the call', async () => {
  await act(async () => root.render(h(AgentHudView, { host: 'window', feed: EMPTY_HUD_FEED, actions: { sendVoiceIdAction: () => {} } })))
  await flush()
  expect(snapshot().state).toBe('Joining the call…')
  expect(container.querySelector('[data-participants-empty]')!.textContent).toBe('Listening…')
  expect(container.querySelector('textarea')!.disabled).toBe(true)
})

describe("the meeting's scheduled time", () => {
  const SCHEDULE = { captureId: 'cap-1', start: Date.parse('2026-10-17T15:00:00Z'), end: Date.parse('2026-10-17T16:00:00Z') }
  const bar = () => container.querySelector('[data-hud-schedule-fill]')

  it('the desktop window: from the recording window, another capture’s or none dropped', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    expect(bar()).toBeNull()
    await act(async () => tauri.window.get(HUD_SCHEDULE_EVENT)!({ payload: SCHEDULE }))
    expect(bar()).not.toBeNull()
    expect(container.querySelector('[data-hud-time-left]')).not.toBeNull()
    await act(async () => tauri.window.get(HUD_SCHEDULE_EVENT)!({ payload: { captureId: null } }))
    expect(bar()).toBeNull()
    await act(async () => tauri.window.get(HUD_SCHEDULE_EVENT)!({ payload: { ...SCHEDULE, captureId: 'cap-0' } }))
    expect(bar()).toBeNull()
  })

  it("the web panel: the capture's own, read once from the capture route's schedule variant", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/account/captures/cap-1?fields=schedule'
        ? ({ ok: true, json: async () => ({ capture: { id: 'cap-1', scheduled_start: '2026-10-17T15:00:00Z', scheduled_end: '2026-10-17T16:00:00Z' } }) } as Response)
        : ({ ok: false, json: async () => ({}) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    rec.ctx = {
      liveModeEnabled: true,
      speakerNames: {},
      selfDemotedLabels: new Set<string>(),
      speakerContacts: {},
      postSessionReview: null,
      selfSuggestion: null,
    }
    rec.speakers = []
    rec.stable = { isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: vi.fn(async () => {}) }
    const store = createHudFeedStore()
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store })))
    await flush()
    expect(store.get().schedule).toEqual(SCHEDULE)
    expect(bar()).not.toBeNull()
    // The event re-linked mid-call: read again; another capture's edit: not.
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-9' } })))
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-1' } })))
    await flush()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('fields=schedule'))).toHaveLength(2)
  })
})

describe("the person's pre-call brief", () => {
  const BRIEF = { captureId: 'cap-1', goal: 'Close the pilot', prepTitle: 'Prep — Acme', prepTop: '**On you**: send the SOW' }
  const line = () => container.querySelector('[data-hud-briefing]')

  it('a plain feed: the Briefing line between the people and the chat; none without a brief', async () => {
    await act(async () => root.render(h(AgentHudView, { host: 'page', feed: FEED, actions: { sendVoiceIdAction: () => {} } })))
    await flush()
    expect(line()).toBeNull()
    await act(async () => root.render(h(AgentHudView, { host: 'page', feed: { ...FEED, brief: BRIEF }, actions: { sendVoiceIdAction: () => {} } })))
    expect(line()!.textContent).toContain('Close the pilot')
    const order = [...container.querySelectorAll('[data-participants], [data-hud-briefing], [data-chat-stub]')].map((el) =>
      el.hasAttribute('data-participants') ? 'people' : el.hasAttribute('data-hud-briefing') ? 'brief' : 'chat',
    )
    expect(order).toEqual(['people', 'brief', 'chat'])
  })

  it('the desktop window: from the recording window, another capture’s or none dropped', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    expect(line()).toBeNull()
    await act(async () => tauri.window.get(HUD_BRIEF_EVENT)!({ payload: BRIEF }))
    // The desktop window saves goals: the goal on its own line, the prep below.
    expect(container.querySelector('[data-hud-goal-text]')!.textContent).toBe('Close the pilot')
    expect(line()!.textContent).toContain('On you: send the SOW')
    expect(line()!.textContent).not.toContain('Close the pilot')
    await act(async () => tauri.window.get(HUD_BRIEF_EVENT)!({ payload: { captureId: null } }))
    expect(line()).toBeNull()
    // No recording state yet: not live, so no "Set a goal" either.
    expect(container.querySelector('[data-hud-goal]')).toBeNull()
    await act(async () => tauri.window.get(HUD_BRIEF_EVENT)!({ payload: { ...BRIEF, captureId: 'cap-0' } }))
    expect(line()).toBeNull()
  })

  it("the web panel: the person's own, read once from the capture route's brief variant, again on an edit", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === '/api/account/captures/cap-1?fields=brief'
        ? ({ ok: true, json: async () => ({ capture: { id: 'cap-1', brief: { goal: 'Close the pilot', prep: { documentId: 'd', title: 'Prep — Acme', top: '**On you**: send the SOW' } } } }) } as Response)
        : ({ ok: false, json: async () => ({}) } as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    rec.ctx = {
      liveModeEnabled: true,
      speakerNames: {},
      selfDemotedLabels: new Set<string>(),
      speakerContacts: {},
      postSessionReview: null,
      selfSuggestion: null,
    }
    rec.speakers = []
    rec.stable = { isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: vi.fn(async () => {}) }
    const store = createHudFeedStore()
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store })))
    await flush()
    expect(store.get().brief).toEqual(BRIEF)
    expect(line()).not.toBeNull()
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-9' } })))
    await act(async () => window.dispatchEvent(new CustomEvent('dial8:content-edited', { detail: { entityId: 'cap-1' } })))
    await flush()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('fields=brief'))).toHaveLength(2)
    // A goal saved mid-call: its own capture's, or one naming no capture, re-reads; another capture's doesn't.
    const goal = (captureId: string | null) =>
      act(async () => window.dispatchEvent(new CustomEvent(MEETING_GOAL_CHANGED_EVENT, { detail: { calendarEventId: 'e', startsAt: '2026-10-18T15:00:00.000Z', captureId } })))
    await goal('cap-9')
    await flush()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('fields=brief'))).toHaveLength(2)
    await goal('cap-1')
    await goal(null)
    await flush()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('fields=brief'))).toHaveLength(4)
  })
})

describe("the call's goal", () => {
  const BRIEF = { captureId: 'cap-1', goal: 'Close the pilot', prepTitle: 'Prep — Acme', prepTop: '**On you**: send the SOW' }
  const REC: HudRecordingState = { captureId: 'cap-1', paused: false, finalizing: false, transcription: 'connected', elapsedSec: 10, at: Date.now() }
  const goalText = () => container.querySelector('[data-hud-goal-text]')?.textContent ?? null
  const setGoal = () => container.querySelector('[data-hud-goal-set]') as HTMLButtonElement | null
  const input = () => container.querySelector('[data-hud-goal] input') as HTMLInputElement
  async function typeAndEnter(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
      input().dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('a plain feed: the goal line above the Briefing line, which keeps to the prep; "Set a goal" only while the call is up', async () => {
    const saveGoal = vi.fn(async () => true)
    const render = (feed: AgentHudFeed, withSave = true) =>
      act(async () => root.render(h(AgentHudView, { host: 'page', feed, actions: { sendVoiceIdAction: () => {}, ...(withSave ? { saveGoal } : {}) } })))
    await render({ ...FEED, brief: BRIEF })
    await flush()
    expect(goalText()).toBe('Close the pilot')
    expect(container.querySelector('[data-hud-briefing-lead]')!.textContent).toBe('On you: send the SOW')
    const order = [...container.querySelectorAll('[data-participants], [data-hud-goal], [data-hud-briefing], [data-chat-stub]')].map((el) =>
      el.hasAttribute('data-participants') ? 'people' : el.hasAttribute('data-hud-goal') ? 'goal' : el.hasAttribute('data-hud-briefing') ? 'brief' : 'chat',
    )
    expect(order).toEqual(['people', 'goal', 'brief', 'chat'])
    // A goal and no prep: the goal line alone.
    await render({ ...FEED, brief: { ...BRIEF, prepTitle: null, prepTop: null } })
    expect(goalText()).toBe('Close the pilot')
    expect(container.querySelector('[data-hud-briefing]')).toBeNull()
    // No goal: "Set a goal" only while the call is up (paused is still the call; finishing up is not).
    await render({ ...FEED, brief: null })
    expect(container.querySelector('[data-hud-goal]')).toBeNull()
    await render({ ...FEED, brief: null, recording: { ...REC, at: Date.now() } })
    expect(setGoal()!.textContent).toBe('Set a goal')
    await render({ ...FEED, brief: null, recording: { ...REC, paused: true, at: Date.now() } })
    expect(setGoal()).not.toBeNull()
    await render({ ...FEED, brief: null, recording: { ...REC, finalizing: true, at: Date.now() } })
    expect(container.querySelector('[data-hud-goal]')).toBeNull()
    // A host that can't save: no goal line, the Briefing line as before.
    await render({ ...FEED, brief: BRIEF, recording: { ...REC, at: Date.now() } }, false)
    expect(container.querySelector('[data-hud-goal]')).toBeNull()
    expect(container.querySelector('[data-hud-briefing-lead]')!.textContent).toBe('Close the pilot')
  })

  it('the desktop window: a save goes to the recording window, and its answer keeps or reverts it', async () => {
    await act(async () => root.render(h(AgentHud)))
    await flush()
    await act(async () => tauri.window.get(VOICE_ID_HUD_STATE_EVENT)!({ payload: VOICE_ID }))
    await act(async () => tauri.window.get(HUD_RECORDING_STATE_EVENT)!({ payload: { ...REC, at: Date.now() } }))
    await act(async () => tauri.window.get(HUD_BRIEF_EVENT)!({ payload: BRIEF }))
    let answer: { ok: boolean } | null = { ok: false }
    tauri.onEmit = (event, payload) => {
      if (event !== HUD_GOAL_ACTION_EVENT || !answer) return
      const { id } = payload as { id: string }
      const ok = answer.ok
      setTimeout(() => tauri.window.get(HUD_GOAL_RESULT_EVENT)?.({ payload: { id, ok } }), 5)
    }
    // Refused: the old goal comes back.
    await act(async () => (container.querySelector('[data-hud-goal] button') as HTMLButtonElement).click())
    await typeAndEnter('Get the SOW signed')
    expect(goalText()).toBe('Get the SOW signed')
    await flush()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(goalText()).toBe('Close the pilot')
    expect(container.querySelector('[data-hud-goal-failed]')).not.toBeNull()
    expect(tauri.emitted.filter((e) => e.event === HUD_GOAL_ACTION_EVENT).map((e) => e.payload)).toEqual([
      { captureId: 'cap-1', id: expect.any(String), type: 'set', goal: 'Get the SOW signed' },
    ])
    // Saved: kept, and the brief the recording window re-sends agrees.
    answer = { ok: true }
    await act(async () => (container.querySelector('[data-hud-goal] button') as HTMLButtonElement).click())
    await typeAndEnter('Get the SOW signed')
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(goalText()).toBe('Get the SOW signed')
    expect(container.querySelector('[data-hud-goal-failed]')).toBeNull()
    await act(async () => tauri.window.get(HUD_BRIEF_EVENT)!({ payload: { ...BRIEF, goal: 'Get the SOW signed' } }))
    expect(goalText()).toBe('Get the SOW signed')
    // Cleared: "Set a goal".
    await act(async () => (container.querySelector('[data-hud-goal] button') as HTMLButtonElement).click())
    await typeAndEnter('')
    expect(tauri.emitted.filter((e) => e.event === HUD_GOAL_ACTION_EVENT).at(-1)!.payload).toMatchObject({ type: 'clear', goal: '' })
    expect(setGoal()).not.toBeNull()
  })

  it('the desktop window: no answer within the cap is a failure', async () => {
    vi.useFakeTimers()
    let ok: boolean | null = null
    const p = requestHudGoal('cap-1', 'Ship').then((v) => {
      ok = v
    })
    await vi.advanceTimersByTimeAsync(HUD_GOAL_ACK_CAP_MS + 10)
    await p
    expect(ok).toBe(false)
    vi.useRealTimers()
    expect(await requestHudGoal(null, 'Ship')).toBe(false)
  })

  it("the web panel: the recording window's own write — the capture's meeting, a PUT with source 'hud', the brief read again", async () => {
    _resetMeetingGoalCacheForTests()
    const writes: Array<{ url: string; method: string; body: unknown }> = []
    let goal: string | null = null
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/account/captures/cap-1?fields=brief') {
        return { ok: true, json: async () => ({ capture: { id: 'cap-1', brief: goal ? { goal, prep: null } : null } }) } as Response
      }
      if (url === '/api/account/meeting-goal?capture_id=cap-1') {
        return { ok: true, json: async () => ({ goal: null, meeting: { calendarEventId: 'capture:cap-1', startsAt: '2026-10-18T15:00:00.000Z' } }) } as Response
      }
      if (url.startsWith('/api/account/meeting-goal')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as { goal: string }) : null
        writes.push({ url, method: init?.method ?? 'GET', body })
        goal = body?.goal ?? null
        return { ok: true, json: async () => ({}) } as Response
      }
      return { ok: false, json: async () => ({}) } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    rec.ctx = {
      liveModeEnabled: true,
      speakerNames: {},
      selfDemotedLabels: new Set<string>(),
      speakerContacts: {},
      postSessionReview: null,
      selfSuggestion: null,
      isRecording: true,
      isPaused: false,
      isAgentFinalizing: false,
      transcriptionStatus: 'connected',
      getElapsed: () => 10,
    }
    rec.speakers = []
    rec.stable = { isRecording: true, captureId: 'cap-1', flushTranscriptForAgent: vi.fn(async () => {}) }
    const store = createHudFeedStore()
    await act(async () => root.render(h(WebHud, { captureId: 'cap-1', store })))
    await flush()
    // An ad-hoc call with no brief: "Set a goal".
    expect(store.get().brief).toBeNull()
    await act(async () => setGoal()!.click())
    await typeAndEnter('Agree the rollout date')
    await flush()
    expect(writes).toEqual([
      {
        url: '/api/account/meeting-goal',
        method: 'PUT',
        body: { calendar_event_id: 'capture:cap-1', starts_at: '2026-10-18T15:00:00.000Z', capture_id: 'cap-1', goal: 'Agree the rollout date', source: 'hud' },
      },
    ])
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('fields=brief'))).toHaveLength(2)
    expect(store.get().brief).toMatchObject({ captureId: 'cap-1', goal: 'Agree the rollout date' })
    expect(goalText()).toBe('Agree the rollout date')
  })
})
