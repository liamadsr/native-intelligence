// @vitest-environment jsdom
/**
 * Guests in the owner's chat (guest-chat-cards.tsx, guest access PR4):
 *
 *   • a stretch of a guest's conversation is the teammate report's card,
 *     their initials in its tile, and opens their conversation on it;
 *   • an access request is the chat's approval card: Household, Colleague,
 *     Ignore, each one POST to the People routes; once settled (here or in
 *     People), one quiet line;
 *   • both are drawn from the home thread's parts (tool-renderers.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GuestActivityChip, GuestRequestCard } from '../guest-chat-cards'
import { dataPartRendererFor } from '@/app/account/(dashboard)/chat/tool-renderers'
import { GUEST_ACTIVITY_PART_TYPE, GUEST_MESSAGE_PART_TYPE, GUEST_REQUEST_PART_TYPE, guestActivityPartData, guestMessagePartData, guestRequestPartData } from '@/lib/guests/chat-parts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GUEST = '44444444-0000-4000-8000-000000000004'
let container: HTMLDivElement
let root: Root
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)
const settle = async () => {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function render(node: ReturnType<typeof h>) {
  await act(async () => root.render(node))
  await settle()
}

type Answer = { status: number; body: unknown }
let answers: Record<string, Answer>
const posts: Array<{ url: string; body: unknown }> = []
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  posts.length = 0
  answers = { [`/api/account/agent-guests/${GUEST}`]: { status: 200, body: { guest: { id: GUEST, state: 'requested', preset: 'colleague' } } } }
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body ?? '{}')) })
    const a = answers[url] ?? { status: 200, body: { ok: true } }
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const activity = guestActivityPartData({
  guest: { id: GUEST, name: 'Sam', preset: 'household', channel: 'sms', message_id: 'sms-in:SM7' },
  summary: 'Booked Nopa, added 2 to Groceries, asked when you land',
  count: 3,
  started_at: new Date().toISOString(),
  last_at: new Date().toISOString(),
})!
const request = guestRequestPartData({ guest_id: GUEST, guest_name: 'Priya Shah', phone_last4: '4821', status: 'pending', requested_at: new Date().toISOString() })!

describe('a guest’s activity', () => {
  it('is the report’s card with their initials, what happened and who, and opens their conversation there', async () => {
    await render(h(GuestActivityChip, { data: activity }))
    const card = container.querySelector<HTMLButtonElement>(`[data-guest-activity="${GUEST}"]`)!
    expect(card.getAttribute('data-chat-panel')).toBe('deliverable')
    expect(card.textContent).toContain('S')
    expect(container.querySelector('[data-guest-activity-summary]')!.textContent).toBe(activity.summary)
    expect(container.querySelector('[data-guest-activity-meta]')!.textContent).toMatch(/^Sam · Household · 3 things · \d/)
    const opened: unknown[] = []
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail)
    window.addEventListener('ni:open-card', onOpen)
    await act(async () => card.click())
    window.removeEventListener('ni:open-card', onOpen)
    expect(opened).toEqual([expect.objectContaining({ spec: expect.objectContaining({ kind: 'guest', target: { type: 'guest', id: GUEST, label: 'Sam' } }), seed: { at: { type: 'guest_message', id: 'sms-in:SM7' } }, reuse: true })])
  })
})

describe('an access request', () => {
  it('reads whether it still waits, then asks: Household, Colleague, Ignore', async () => {
    await render(h(GuestRequestCard, { data: request }))
    expect(container.textContent).toContain('Priya Shah asked to text your agent')
    expect(container.textContent).toContain('ending 4821')
    expect(button('Household')).toBeDefined()
    expect(button('Colleague')).toBeDefined()
    expect(button('Ignore')).toBeDefined()
  })

  it('Colleague approves with that preset, once, and the card becomes one line', async () => {
    await render(h(GuestRequestCard, { data: request }))
    await act(async () => button('Colleague')!.click())
    await settle()
    expect(posts).toEqual([{ url: `/api/account/agent-guests/${GUEST}/approve`, body: { preset: 'colleague' } }])
    expect(container.querySelector('[data-guest-request-settled="allowed"]')!.textContent).toBe('Priya Shah can now text your agent, as Colleague.')
    expect(button('Household')).toBeUndefined()
  })

  it('Ignore ignores', async () => {
    await render(h(GuestRequestCard, { data: request }))
    await act(async () => button('Ignore')!.click())
    await settle()
    expect(posts).toEqual([{ url: `/api/account/agent-guests/${GUEST}/ignore`, body: {} }])
    expect(container.querySelector('[data-guest-request-settled="ignored"]')).not.toBeNull()
  })

  it('answered in People already: says what became of it, no buttons', async () => {
    answers[`/api/account/agent-guests/${GUEST}`] = { status: 200, body: { guest: { id: GUEST, state: 'active', preset: 'household' } } }
    await render(h(GuestRequestCard, { data: request }))
    expect(container.querySelector('[data-guest-request-settled="allowed"]')!.textContent).toBe('Priya Shah can now text your agent, as Household.')
    expect(button('Household')).toBeUndefined()
  })

  it('answered elsewhere meanwhile (409): reads the row again and says so', async () => {
    await render(h(GuestRequestCard, { data: request }))
    answers[`/api/account/agent-guests/${GUEST}/approve`] = { status: 409, body: { code: 'GUEST_WRONG_STATE' } }
    answers[`/api/account/agent-guests/${GUEST}`] = { status: 200, body: { guest: { id: GUEST, state: 'removed' } } }
    await act(async () => button('Household')!.click())
    await settle()
    expect(container.querySelector('[data-guest-request-settled="ignored"]')).not.toBeNull()
  })

  it('a failed click says so and keeps the buttons', async () => {
    await render(h(GuestRequestCard, { data: request }))
    answers[`/api/account/agent-guests/${GUEST}/approve`] = { status: 500, body: {} }
    await act(async () => button('Household')!.click())
    await settle()
    expect(container.textContent).toContain('That didn’t go through.')
    expect(button('Household')).toBeDefined()
  })

  it('the People route not there yet (or down): the part’s own word stands', async () => {
    answers[`/api/account/agent-guests/${GUEST}`] = { status: 500, body: {} }
    await render(h(GuestRequestCard, { data: request }))
    expect(button('Household')).toBeDefined()
  })
})

describe('drawn from the home thread’s parts', () => {
  it('each part type has its card, and a malformed part draws nothing', async () => {
    const activityEntry = dataPartRendererFor(GUEST_ACTIVITY_PART_TYPE)!
    const requestEntry = dataPartRendererFor(GUEST_REQUEST_PART_TYPE)!
    expect(activityEntry.render({ type: GUEST_ACTIVITY_PART_TYPE, data: { summary: 'x' } }, 'k')).toBeNull()
    expect(requestEntry.render({ type: GUEST_REQUEST_PART_TYPE, data: {} }, 'k')).toBeNull()
    await render(h('div', null, activityEntry.render({ type: GUEST_ACTIVITY_PART_TYPE, data: activity }, 'a'), requestEntry.render({ type: GUEST_REQUEST_PART_TYPE, data: request }, 'r')))
    expect(container.querySelector(`[data-guest-activity="${GUEST}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-guest-request="${GUEST}"]`)).not.toBeNull()
  })
})

describe('a guest’s note to the owner (message_owner)', () => {
  it('is their line over their words, plain, and says Urgent when it is', async () => {
    const entry = dataPartRendererFor(GUEST_MESSAGE_PART_TYPE)!
    expect(entry.render({ type: GUEST_MESSAGE_PART_TYPE, data: { guest: { id: GUEST, name: 'Sam' }, text: '  ' } }, 'k')).toBeNull()
    const data = guestMessagePartData({ guest: { id: GUEST, name: 'Sam', preset: 'household', channel: 'sms' }, text: 'Running late, **pick up Max**?', urgent: true, at: new Date().toISOString() })!
    await render(h('div', null, entry.render({ type: GUEST_MESSAGE_PART_TYPE, data }, 'm')))
    const note = container.querySelector(`[data-guest-message="${GUEST}"]`)!
    expect(note.querySelector(`[data-guest-line="${GUEST}"]`)!.textContent).toBe('SSam · Household')
    expect(note.querySelector('p')!.textContent).toBe('Running late, **pick up Max**?')
    expect(note.querySelector('[data-guest-message-urgent]')).not.toBeNull()
  })
})
