// @vitest-environment jsdom
/**
 * The goal composer under a meeting prep's report (MeetingGoalComposer), with
 * fetch, the voice hooks and the toast stubbed. Pins:
 *   - only a prep report naming a calendar event gets one; it reads the goal
 *     once (GET by event and start) and shows nothing until the read answers;
 *   - empty: the placeholder and the dictation mic (when dictation is ready);
 *     typing turns the mic into send; on the web (no dictation) no mic, and
 *     send only with words;
 *   - Enter saves (PUT with the meeting's capture, source prep_card) and the
 *     card shows "Goal: …"; a failed save says so;
 *   - the saved line opens the box to edit; Escape cancels the edit; saving it
 *     empty clears the goal (DELETE);
 *   - mid IME composition, Enter saves nothing and Escape keeps the draft;
 *   - a failed save opens the box again with the words that didn't save;
 *   - the meeting over: no request; the goal this page already read,
 *     read-only, or nothing;
 *   - dictated words land in the box, never past the goal's limit;
 *   - set_meeting_goal's result line re-reads the meeting's card once it has
 *     read, and never adds a read on page load;
 *   - a saved goal (and a chat-set one for a meeting around now) tells the
 *     page (MEETING_GOAL_CHANGED_EVENT), so the live HUD's Briefing re-reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactElement } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const voice = vi.hoisted(() => ({
  dictationReady: true,
  onCommit: null as ((text: string) => void) | null,
}))
vi.mock('@/hooks/use-voice-availability', () => ({
  useVoiceAvailability: () => ({
    hasVoice: voice.dictationReady,
    visible: voice.dictationReady,
    dictation: voice.dictationReady,
    conversation: false,
    blocked: null,
    status: {},
  }),
  voiceBlockedLabel: () => 'blocked',
}))
vi.mock('@/hooks/use-dictation', () => ({
  useDictation: (opts: { onCommit: (text: string) => void }) => {
    voice.onCommit = opts.onCommit
    return { phase: 'idle', active: false, latched: false, transcript: null, buttonProps: {}, toggle: () => {}, stop: () => {}, cancel: () => {} }
  },
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
const toasts = vi.hoisted(() => ({ errors: [] as string[] }))
vi.mock('sonner', () => ({ toast: { error: (m: string) => void toasts.errors.push(m) } }))

import { MeetingGoalComposer, MeetingGoalSetLine } from '../meeting-goal-composer'
import { _resetMeetingGoalCacheForTests } from '@/hooks/use-meeting-goal'
import { MEETING_GOAL_CHANGED_EVENT, type MeetingGoalChangedDetail } from '@/lib/meetings/meeting-goal'

const EVENT = 'evt_abc123'
const CAPTURE = '11111111-1111-4111-8111-111111111111'
const KEY = 'a'.repeat(40)
const HOUR = 60 * 60_000

/** A prep report's metadata for a meeting starting `inMs` from now. */
function prepMeta(inMs: number, over: Record<string, unknown> = {}) {
  return {
    kind: 'teammate_report',
    meeting_prep: {
      startIso: new Date(Date.now() + inMs).toISOString(),
      endIso: null,
      calendarEventId: EVENT,
      captureId: CAPTURE,
      meetingKey: KEY,
      ...over,
    },
  }
}

interface Call {
  method: string
  url: string
  body: Record<string, unknown> | null
}
let calls: Call[]
let serverGoal: string | null
let failWrites: boolean

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method !== 'GET' && failWrites) return new Response('{}', { status: 500 })
      if (method === 'PUT') serverGoal = String(JSON.parse(String(init!.body)).goal)
      if (method === 'DELETE') serverGoal = null
      const body = method === 'GET' ? { goal: serverGoal ? { goal: serverGoal } : null } : method === 'PUT' ? { goal: { goal: serverGoal } } : { cleared: true }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

let container: HTMLDivElement
let root: Root

async function render(el: ReactElement) {
  await act(async () => {
    root.render(el)
  })
  await flush()
}
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel)
const textarea = () => q<HTMLTextAreaElement>('textarea')
const mic = () => q('[data-voice-control="dictation"]')
const send = () => q<HTMLButtonElement>('[data-meeting-goal-send]')

async function type(value: string) {
  const el = textarea()!
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    textarea()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })
  await flush()
}
async function click(el: Element | null) {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

beforeEach(() => {
  _resetMeetingGoalCacheForTests()
  calls = []
  serverGoal = null
  failWrites = false
  toasts.errors = []
  voice.dictationReady = true
  voice.onCommit = null
  stubFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('which messages get one', () => {
  it('not a prep report: nothing, and no read', async () => {
    await render(h(MeetingGoalComposer, { metadata: { kind: 'teammate_report' } }))
    expect(container.innerHTML).toBe('')
    expect(calls).toEqual([])
  })

  it('a prep with no calendar event: nothing', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR, { calendarEventId: null }) }))
    expect(container.innerHTML).toBe('')
    expect(calls).toEqual([])
  })

  it('a prep report reads its goal once, by the event and start', async () => {
    const meta = prepMeta(HOUR)
    await render(h('div', null, h(MeetingGoalComposer, { metadata: meta }), h(MeetingGoalComposer, { metadata: meta })))
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain(`calendar_event_id=${EVENT}`)
    expect(calls[0].url).toContain(`starts_at=${encodeURIComponent(meta.meeting_prep.startIso)}`)
  })
})

describe('the composer', () => {
  it('empty: the question and the mic, no send; typing turns the mic into send', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    expect(textarea()!.placeholder).toBe('What’s the goal of this call?')
    expect(mic()).not.toBeNull()
    expect(send()).toBeNull()
    await type('Close the pilot')
    expect(send()).not.toBeNull()
    expect(mic()).toBeNull()
  })

  it('rides the prep card: the box and the saved goal both sit in the attached spot (tailwind.css)', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    expect(q('[data-meeting-goal="composer"]')!.classList.contains('chat-panel-attachment')).toBe(true)
    // The spot carries the attached shadow, so it wears the box's corners (no square shadow round a round box).
    const spot = q('[data-meeting-goal="composer"]')!
    expect(spot.classList.contains('rounded-3xl')).toBe(true)
    expect((spot.firstElementChild as HTMLElement).classList.contains('rounded-3xl')).toBe(true)
    // Plainly a field: the chat's text size, not the old 13px line.
    expect(textarea()!.className).toContain('text-[15px]')
    await type('Close the pilot')
    await key('Enter')
    expect(q('[data-meeting-goal="saved"]')!.classList.contains('chat-panel-attachment')).toBe(true)
  })

  it('on the web (no dictation): no mic; send only with words', async () => {
    voice.dictationReady = false
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    expect(mic()).toBeNull()
    expect(send()).toBeNull()
    await type('Close the pilot')
    expect(send()).not.toBeNull()
  })

  it('Enter saves the goal with the meeting and its capture, and the card shows it', async () => {
    const meta = prepMeta(HOUR)
    await render(h(MeetingGoalComposer, { metadata: meta }))
    await type('  Close the pilot ')
    await key('Enter')
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({
      calendar_event_id: EVENT,
      starts_at: meta.meeting_prep.startIso,
      capture_id: CAPTURE,
      goal: 'Close the pilot',
      source: 'prep_card',
    })
    expect(textarea()).toBeNull()
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Goal: Close the pilot')
  })

  it('a failed save puts the box back with the words that didn’t save, and says so', async () => {
    failWrites = true
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await type('Close the pilot')
    await click(send())
    expect(q('[data-meeting-goal="saved"]')).toBeNull()
    expect(textarea()!.value).toBe('Close the pilot')
    expect(toasts.errors).toHaveLength(1)
    // Trying again saves it.
    failWrites = false
    await key('Enter')
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Close the pilot')
  })

  it('mid IME composition, Enter saves nothing and Escape keeps the draft', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await type('ゴール')
    await key('Enter', { isComposing: true })
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
    await key('Escape', { isComposing: true })
    expect(textarea()!.value).toBe('ゴール')
    // Composition over: Escape empties the fresh box.
    await key('Escape')
    expect(textarea()!.value).toBe('')
  })

  it('Enter on an empty box saves nothing', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await key('Enter')
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('dictated words land in the box', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await act(async () => voice.onCommit!('close the pilot'))
    expect(textarea()!.value).toBe('close the pilot')
    expect(send()).not.toBeNull()
  })

  it('dictation never fills the box past the goal’s limit', async () => {
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await act(async () => voice.onCommit!('word '.repeat(150)))
    expect(textarea()!.value.length).toBe(500)
  })
})

describe('a saved goal', () => {
  it('opens to edit; Escape cancels the edit', async () => {
    serverGoal = 'Close the pilot'
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await click(q('[data-meeting-goal="saved"]'))
    expect(textarea()!.value).toBe('Close the pilot')
    await type('Something else')
    await key('Escape')
    expect(textarea()).toBeNull()
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Close the pilot')
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('an edit saves the new goal', async () => {
    serverGoal = 'Close the pilot'
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await click(q('[data-meeting-goal="saved"]'))
    await type('Get a yes on pricing')
    await key('Enter')
    expect(calls.find((c) => c.method === 'PUT')?.body?.goal).toBe('Get a yes on pricing')
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Get a yes on pricing')
  })

  it('a failed edit opens the box again with the edited words', async () => {
    serverGoal = 'Close the pilot'
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await click(q('[data-meeting-goal="saved"]'))
    failWrites = true
    await type('Get a yes on pricing')
    await key('Enter')
    expect(textarea()!.value).toBe('Get a yes on pricing')
    // Escape gives up the edit: the saved goal is the old one.
    await key('Escape')
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Close the pilot')
  })

  it('saved empty, the goal is cleared', async () => {
    serverGoal = 'Close the pilot'
    await render(h(MeetingGoalComposer, { metadata: prepMeta(HOUR) }))
    await click(q('[data-meeting-goal="saved"]'))
    await type('')
    await key('Enter')
    const del = calls.find((c) => c.method === 'DELETE')
    expect(del?.url).toContain(`calendar_event_id=${EVENT}`)
    expect(q('[data-meeting-goal="saved"]')).toBeNull()
    expect(textarea()!.value).toBe('')
  })
})

describe('once the meeting is over', () => {
  it('makes no request, and with nothing known shows nothing', async () => {
    serverGoal = 'Close the pilot'
    // Started 3 hours ago, no end on record: over after DEFAULT_MEETING_MS.
    await render(h(MeetingGoalComposer, { metadata: prepMeta(-3 * HOUR) }))
    expect(calls).toEqual([])
    expect(container.innerHTML).toBe('')
  })

  it('the goal this page already read, read-only', async () => {
    serverGoal = 'Close the pilot'
    // Ends in 1.5 s: read while it is on, then it ends under the card. Real
    // timers, so wait for the end (up to 6 s) rather than a fixed sleep: a
    // fixed 60 ms / 120 ms pair lost the race on a loaded build machine.
    await render(h(MeetingGoalComposer, { metadata: prepMeta(-3 * HOUR, { endIso: new Date(Date.now() + 1_500).toISOString() }) }))
    expect(q('[data-meeting-goal="saved"]')).not.toBeNull()
    for (let i = 0; i < 60 && !q('[data-meeting-goal="over"]'); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100))
      })
    }
    const line = q('[data-meeting-goal="over"]')
    expect(line?.textContent).toContain('Goal: Close the pilot')
    expect(line?.tagName).toBe('P')
    expect(textarea()).toBeNull()
    expect(calls).toHaveLength(1)
  }, 15_000)

  it('its calendar end counts, not the default hour', async () => {
    // Started 90 minutes ago, ends in 30: still on.
    await render(h(MeetingGoalComposer, { metadata: prepMeta(-1.5 * HOUR, { endIso: new Date(Date.now() + 0.5 * HOUR).toISOString() }) }))
    expect(textarea()).not.toBeNull()
  })
})

describe("set_meeting_goal's result line", () => {
  it('says what was set and re-reads the meeting’s card', async () => {
    const meta = prepMeta(HOUR)
    await render(h(MeetingGoalComposer, { metadata: meta }))
    expect(textarea()).not.toBeNull()
    serverGoal = 'Close the pilot'
    await render(
      h(
        'div',
        null,
        h(MeetingGoalComposer, { metadata: meta }),
        h(MeetingGoalSetLine, {
          toolCallId: 'call-1',
          result: { calendarEventId: EVENT, startsAt: meta.meeting_prep.startIso, goal: 'Close the pilot' },
        }),
      ),
    )
    expect(q('[data-meeting-goal-set]')?.textContent).toContain('Goal set: Close the pilot')
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2)
    expect(q('[data-meeting-goal="saved"]')?.textContent).toContain('Close the pilot')
  })

  it('on page load (the card still reading, or a finished meeting) it reads nothing more', async () => {
    const meta = prepMeta(HOUR)
    const line = (startsAt: string, id: string) =>
      h(MeetingGoalSetLine, { toolCallId: id, result: { calendarEventId: EVENT, startsAt, goal: 'Close the pilot' } })
    await render(h('div', null, h(MeetingGoalComposer, { metadata: meta }), line(meta.meeting_prep.startIso, 'call-a')))
    expect(calls).toHaveLength(1)
    // A meeting no card asked for (a finished one) is never read.
    await render(h('div', null, h(MeetingGoalComposer, { metadata: meta }), line(meta.meeting_prep.startIso, 'call-a'), line('2026-01-01T10:00:00.000Z', 'call-b')))
    expect(calls).toHaveLength(1)
  })
})

describe('a goal change tells the page (the live HUD re-reads its brief)', () => {
  let heard: MeetingGoalChangedDetail[]
  const onGoal = (e: Event) => heard.push((e as CustomEvent<MeetingGoalChangedDetail>).detail)
  beforeEach(() => {
    heard = []
    window.addEventListener(MEETING_GOAL_CHANGED_EVENT, onGoal)
  })
  afterEach(() => window.removeEventListener(MEETING_GOAL_CHANGED_EVENT, onGoal))

  it('a saved goal from the card, with its capture; a failed save says nothing', async () => {
    const meta = prepMeta(HOUR)
    failWrites = true
    await render(h(MeetingGoalComposer, { metadata: meta }))
    await type('Close the pilot')
    await key('Enter')
    expect(heard).toEqual([])
    failWrites = false
    await key('Enter')
    expect(heard).toEqual([{ calendarEventId: EVENT, startsAt: meta.meeting_prep.startIso, captureId: CAPTURE }])
  })

  it("set_meeting_goal's result: once, for a meeting around now only", async () => {
    const soon = new Date(Date.now() + HOUR).toISOString()
    const line = (startsAt: string, id: string) =>
      h(MeetingGoalSetLine, { toolCallId: id, result: { calendarEventId: EVENT, startsAt, goal: 'Close the pilot' } })
    await render(h('div', null, line(soon, 'call-1')))
    await render(h('div', null, line(soon, 'call-1'), line('2026-01-01T10:00:00.000Z', 'call-old')))
    expect(heard).toEqual([{ calendarEventId: EVENT, startsAt: soon, captureId: null }])
  })
})
