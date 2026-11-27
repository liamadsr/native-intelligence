// @vitest-environment jsdom
/**
 * "Send my assistant" on a meeting prep's card (MeetingAssistantBrief, roadmap
 * #12): the brief editor. fetch is stubbed. Pins:
 *   - nothing unless the server says the meeting agent is on, the message is a
 *     prep report naming a calendar event, and the meeting is still ahead;
 *   - the editor starts with the meeting's saved goal; the same validation as
 *     the server (too many lines, too long, no goal or question);
 *   - Review asks the server's preview (every check, nothing written) and
 *     shows its approval card word for word; Send posts the same brief, this
 *     meeting or every occurrence; a refusal says why and keeps the draft.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { MeetingAssistantBrief, briefOfDrafts, briefProblem } from '../meeting-assistant-brief'
import { resetMeetingAgentProbe } from '@/hooks/use-meeting-agent-on'
import { _resetMeetingGoalCacheForTests } from '@/hooks/use-meeting-goal'
import { BRIEF_MAX_ITEMS } from '@/lib/meeting-agent/brief'

const EVENT = 'evt_abc123'
const HOUR = 60 * 60_000

function prepMeta(inMs: number) {
  return { kind: 'teammate_report', meeting_prep: { startIso: new Date(Date.now() + inMs).toISOString(), endIso: null, calendarEventId: EVENT, captureId: null, meetingKey: 'a'.repeat(40) } }
}

let calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }>
let agentOn: boolean
let postAnswer: { status: number; body: unknown }
let container: HTMLDivElement
let root: Root

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {})
}

beforeEach(() => {
  calls = []
  agentOn = true
  postAnswer = { status: 200, body: {} }
  resetMeetingAgentProbe()
  _resetMeetingGoalCacheForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.includes('probe=1')) return new Response(JSON.stringify({ on: true }), { status: agentOn ? 200 : 403 })
      if (url.includes('meeting-goal')) return new Response(JSON.stringify({ goal: { goal: 'Close the pilot' } }), { status: 200 })
      const body = calls.at(-1)!.body
      if (body?.preview) return new Response(JSON.stringify({ card: { title: 'Send your assistant to “Pilot review”?', why: 'It dials in at the start (•••• 0142)…\nGoals: Close the pilot' } }), { status: 200 })
      return new Response(JSON.stringify(postAnswer.body), { status: postAnswer.status })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
async function click(sel: string) {
  await act(async () => (q(sel) as HTMLButtonElement).click())
  await flush()
}
async function type(field: string, value: string) {
  const ta = q(`[data-brief-field="${field}"]`) as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, value)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the brief editor on a prep card', () => {
  it('shows nothing while the meeting agent is off, for a past meeting, or for another message', async () => {
    agentOn = false
    await act(async () => root.render(h(MeetingAssistantBrief, { metadata: prepMeta(HOUR) })))
    await flush()
    expect(q('[data-meeting-assistant]')).toBeNull()
    resetMeetingAgentProbe()
    agentOn = true
    await act(async () => root.render(h('div', null, h(MeetingAssistantBrief, { metadata: prepMeta(-3 * HOUR) }), h(MeetingAssistantBrief, { metadata: { kind: 'teammate_report' } }))))
    await flush()
    expect(q('[data-meeting-assistant]')).toBeNull()
  })

  it("opens with the meeting's goal, reviews the server's own card, and sends the same brief", async () => {
    await act(async () => root.render(h(MeetingAssistantBrief, { metadata: prepMeta(HOUR) })))
    await flush()
    expect(q('[data-meeting-assistant="open"]')?.textContent).toContain('Send my assistant')
    await click('[data-meeting-assistant="open"]')
    expect((q('[data-brief-field="goals"]') as HTMLTextAreaElement).value).toBe('Close the pilot')
    for (const label of ['Goals', 'Facts it may share', 'Questions to ask', 'Must not agree to', 'This meeting', 'Every occurrence']) expect(container.textContent).toContain(label)
    await type('ask', 'Who signs off?\n\nWhen can we start?')
    await type('must_not_agree', 'Exclusivity')
    await click('[data-every-occurrence]')
    await click('[data-meeting-assistant-review]')
    const preview = calls.find((c) => c.method === 'POST' && c.body?.preview)!
    expect(preview.body).toEqual({
      calendar_event_id: EVENT,
      starts_at: expect.any(String),
      brief: { goals: ['Close the pilot'], may_share: [], ask: ['Who signs off?', 'When can we start?'], must_not_agree: ['Exclusivity'] },
      every_occurrence: true,
      preview: true,
    })
    expect(q('[data-meeting-assistant="review"]')?.textContent).toContain('Send your assistant to “Pilot review”?')
    expect(q('[data-meeting-assistant="review"]')?.textContent).toContain('Goals: Close the pilot')
    await click('[data-meeting-assistant-send]')
    const sent = calls.filter((c) => c.method === 'POST').at(-1)!
    expect(sent.body).toMatchObject({ calendar_event_id: EVENT, every_occurrence: true, brief: preview.body!.brief })
    expect(sent.body!.preview).toBeUndefined()
    expect(q('[data-meeting-assistant="sent"]')?.textContent).toContain('every occurrence')
  })

  it("a refusal says why and keeps the draft", async () => {
    await act(async () => root.render(h(MeetingAssistantBrief, { metadata: prepMeta(HOUR) })))
    await flush()
    await click('[data-meeting-assistant="open"]')
    await click('[data-meeting-assistant-review]')
    postAnswer = { status: 400, body: { error: 'This meeting has no US or Canadian dial-in number with its meeting ID.', code: 'NO_DIAL_IN' } }
    await click('[data-meeting-assistant-send]')
    expect(q('[data-meeting-assistant-error]')?.textContent).toContain('no US or Canadian dial-in')
    expect((q('[data-brief-field="goals"]') as HTMLTextAreaElement).value).toBe('Close the pilot')
  })
})

describe('the same validation as the server', () => {
  const drafts = (over: Partial<Record<'goals' | 'may_share' | 'ask' | 'must_not_agree', string>>) => ({ goals: '', may_share: '', ask: '', must_not_agree: '', ...over })
  it('one item per line, blank lines dropped', () => {
    expect(briefOfDrafts(drafts({ goals: 'A\n\n B ' }))).toEqual({ ok: true, brief: { goals: ['A', 'B'], may_share: [], ask: [], must_not_agree: [] } })
  })
  it('names what is wrong', () => {
    expect(briefProblem(briefOfDrafts(drafts({ may_share: 'x' })))).toBe('Give it at least one goal or one question to ask.')
    expect(briefProblem(briefOfDrafts(drafts({ ask: Array.from({ length: BRIEF_MAX_ITEMS + 1 }, (_, i) => `q${i}`).join('\n') })))).toBe(`Questions to ask: at most ${BRIEF_MAX_ITEMS} lines.`)
    expect(briefProblem(briefOfDrafts(drafts({ goals: 'x'.repeat(301) })))).toBe('Goals: each line at most 300 characters.')
    expect(briefProblem(briefOfDrafts(drafts({ goals: 'A yes' })))).toBeNull()
  })
})
