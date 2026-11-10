// @vitest-environment jsdom
/**
 * The agent panel's People tab (guest access, PR5): requests with Household /
 * Colleague / Ignore, who can reach the agent, Add a person with the
 * connector page's Tool permissions, the invite shown once, a person's page,
 * and landing on a person from a chat card. The routes are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PeoplePanel, askIsOn, pickedPermission, withAsk, withPicked,
  withSectionPicked } from '../people-panel'
import { presetSettings } from '@/lib/guests/presets'
import type { GuestView } from '@/lib/guests/people'
import type { LinkCandidate, LinkView } from '@/lib/agent-links/views'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function view(over: Partial<GuestView> = {}): GuestView {
  const { tools, askTools, askBefore } = presetSettings('household')
  return {
    id: 'g-sam',
    displayName: 'Sam Rivera',
    masked: '··8830',
    channels: ['sms'],
    unbound: [],
    peerUserId: null,
    preset: 'household',
    tools,
    askTools,
    askBefore,
    notes: null,
    calendarEmails: [],
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: '2026-10-24T20:00:00Z',
    lastInboundAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    optedOut: false,
    createdAt: '2026-10-24T19:00:00Z',
    ...over,
  }
}

function linkView(over: Partial<LinkView> = {}): LinkView {
  return {
    id: 'l-dana',
    state: 'requested',
    direction: 'incoming',
    peer: { userId: 'u-dana', name: 'Dana Kim', agentName: 'Ava', workspaceName: 'Northwind', sameWorkspace: false },
    myHalfGuestId: null,
    theirHalf: null,
    outside: true,
    requestedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    acceptedAt: null,
    expiresAt: null,
    lastExchangeAt: null,
    ...over,
  }
}

let guests: GuestView[] = []
let links: LinkView[] = []
let candidates: LinkCandidate[] = []
let answerWorkspaces: Array<{ id: string; name: string; outsideAllowed: boolean }> = []
const calls: Array<{ url: string; method: string; body: unknown }> = []
let slackInstalls: Array<{ teamId: string; teamName: string; myLink: null }> = [{ teamId: 'T1', teamName: 'Acme', myLink: null }]
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  calls.push({ url, method, body })
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
  if (url === '/api/account/phone') return json({ phone: null, niNumber: '+14155550100', available: true })
  if (url === '/api/account/integrations/slack') return json({ configured: true, installations: slackInstalls })
  if (url === '/api/account/agent-links' && method === 'GET') return json({ links, candidates })
  if (url === '/api/account/agent-links/answer-workspaces') return json({ workspaces: answerWorkspaces })
  if (url === '/api/account/agent-links/connect') {
    const b = body as { displayName: string }
    guests = [view({ id: 'g-half', displayName: b.displayName, state: 'invited', channels: ['dial8'], masked: null, lastInboundAt: null }), ...guests]
    return json({ link: linkView({ id: 'l-new', direction: 'outgoing', myHalfGuestId: 'g-half' }), url: 'https://nativeintelligence.dev/link/tok123' }, 201)
  }
  if (url === '/api/account/agent-links' && method === 'POST') {
    const b = body as { guestId?: string; peerUserId: string; displayName: string; email?: string }
    if (b.email) {
      guests = [view({ id: 'g-half', displayName: b.displayName, state: 'invited', channels: ['dial8'], masked: null, lastInboundAt: null }), ...guests]
      return json({ link: linkView({ id: 'l-new', direction: 'outgoing', myHalfGuestId: 'g-half' }) }, 201)
    }
    const halfId = b.guestId ?? 'g-half'
    if (b.guestId) guests = guests.map((g) => (g.id === b.guestId ? { ...g, channels: [...g.channels, 'dial8'], peerUserId: b.peerUserId } : g))
    else guests = [view({ id: halfId, displayName: b.displayName, state: 'invited', channels: ['dial8'], masked: null, peerUserId: b.peerUserId, lastInboundAt: null }), ...guests]
    const link = linkView({ id: 'l-new', direction: 'outgoing', myHalfGuestId: halfId, peer: { userId: b.peerUserId, name: b.displayName, agentName: null, workspaceName: null, sameWorkspace: true } })
    links = [link, ...links]
    return json({ link }, 201)
  }
  if (url.startsWith('/api/account/agent-links/') && url.endsWith('/accept')) {
    guests = [view({ id: 'g-dana', displayName: 'Dana Kim', channels: ['dial8'], masked: null, peerUserId: 'u-dana' }), ...guests]
    links = links.map((l) => (l.id === 'l-dana' ? { ...l, state: 'active' as const, myHalfGuestId: 'g-dana', theirHalf: { summary: 'when you’re free' } } : l))
    return json({ link: links.find((l) => l.id === 'l-dana') })
  }
  if (url.startsWith('/api/account/agent-links/') && url.endsWith('/ignore')) {
    links = links.filter((l) => !url.includes(l.id))
    return json({ ok: true })
  }
  if (url.startsWith('/api/account/agent-links/') && method === 'DELETE') {
    const link = links.find((l) => url.endsWith(l.id))!
    links = links.filter((l) => l !== link)
    guests = guests.flatMap((g) => (g.id === link.myHalfGuestId ? (g.channels.length === 1 ? [] : [{ ...g, channels: g.channels.filter((c) => c !== 'dial8') }]) : [g]))
    return json({ ok: true })
  }
  if (url.startsWith('/api/account/agent-guests/') && url.endsWith('/invite')) {
    const g = guests.find((x) => url.includes(x.id))!
    return json({ guest: { ...g, state: 'invited' }, invite: { code: 'AB12CD', text: "Hi, it's Marco · AB12CD", niNumber: '+14155550100', expiresAt: null } })
  }
  if (url === '/api/account/agent-guests' && method === 'GET') return json({ guests, requests: { code: 'K7Q4MX', open: false }, niNumber: '+14155550100', available: true })
  if (url === '/api/account/agent-guests' && method === 'POST') {
    const b = body as { displayName: string; channels: Array<'sms' | 'slack'>; phone: string | null; tools: string[]; askTools: string[] }
    const guest = view({ id: 'g-new', displayName: b.displayName, state: 'invited', channels: b.channels, unbound: b.channels, masked: b.phone ? '··8831' : null, tools: b.tools, askTools: b.askTools })
    return json({ guest, invite: { code: 'AB12CD', text: "Hi, it's Marco · AB12CD", niNumber: '+14155550100', expiresAt: null } }, 201)
  }
  if (url.endsWith('/approve')) return json({ guest: view({ id: 'g-priya', displayName: 'Priya Shah', state: 'active', preset: (body as { preset: 'colleague' }).preset }) })
  if (url.endsWith('/ignore')) return json({ ok: true })
  if (url.startsWith('/api/account/agent-guests/') && method === 'PATCH') {
    const g = guests.find((x) => url.endsWith(x.id))!
    const b = body as { channels?: Array<'sms' | 'slack'>; phone?: string }
    const next = { ...g, ...(body as object), preset: 'custom' as const, ...(b.phone ? { masked: '··0000' } : {}) }
    if (b.channels) {
      // Their agent stays as it is (the store keeps it).
      next.channels = [...b.channels.filter((c) => (c as string) !== 'dial8'), ...(g.channels.includes('dial8') ? (['dial8'] as const) : [])]
      next.unbound = b.channels.filter((c) => !g.channels.includes(c) || g.unbound.includes(c))
    }
    guests = guests.map((x) => (x.id === g.id ? next : x))
    return json({ guest: next })
  }
  return json({}, 404)
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  guests = []
  links = []
  candidates = [{ userId: 'u-marco', name: 'Marco Ruiz', agentName: 'Rex' }]
  answerWorkspaces = [{ id: 'w-acme', name: 'Acme', outsideAllowed: true }]
  slackInstalls = [{ teamId: 'T1', teamName: 'Acme', myLink: null }]
  calls.length = 0
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const q = (sel: string) => host.querySelector(sel) as HTMLElement | null
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await act(async () => new Promise((r) => setTimeout(r, 5)))
  expect(check()).toBe(true)
}
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click())
}
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function show(props: { focusGuestId?: string } = {}) {
  await act(async () => root.render(<PeoplePanel name="Joseph" active onOpenTab={() => {}} {...props} />))
  await until(() => !!q('[data-people-who]'))
}

describe('picks', () => {
  it('reads Blocked, Needs approval and Always allow from tools and askTools', () => {
    const picks = { tools: ['a', 'b'], askTools: ['b'], askBefore: [] }
    expect(pickedPermission(picks, 'a')).toBe('allow')
    expect(pickedPermission(picks, 'b')).toBe('ask')
    expect(pickedPermission(picks, 'c')).toBe('blocked')
  })

  it('a whole section on Always allow turns everything on, but leaves what sends, changes outside Native Intelligence or deletes on Needs approval', () => {
    const next = withSectionPicked({ tools: [], askTools: [], askBefore: ['payments', 'deletes'] }, ['get_calendar_events', 'create_calendar_event', 'delete_calendar_event'], 'allow')
    expect(next.tools).toEqual(['get_calendar_events', 'create_calendar_event', 'delete_calendar_event'])
    expect(next.askTools).toEqual(['create_calendar_event', 'delete_calendar_event'])
    expect(next.askBefore).toEqual(['payments', 'deletes'])
    // One the owner already set to Always allow keeps it.
    const kept = withSectionPicked({ tools: ['create_calendar_event'], askTools: [], askBefore: ['payments'] }, ['create_calendar_event', 'update_calendar_event'], 'allow')
    expect(kept.askTools).toEqual(['update_calendar_event'])
    // Needs approval and Blocked are the plain picks.
    expect(withSectionPicked(next, ['create_calendar_event', 'get_calendar_events'], 'ask').askTools).toEqual(expect.arrayContaining(['create_calendar_event', 'get_calendar_events']))
  })

  // Liam, 2026-11-02: "nothing should be not allowed at all ... I get to control who can do that".
  it('every tool takes the owner’s pick, an outward one or a delete included; per-tool picks drop "any change"', () => {
    const next = withPicked({ tools: [], askTools: [], askBefore: ['payments', 'changes'] }, ['create_calendar_event', 'get_calendar_events'], 'allow')
    expect(next.tools).toEqual(['create_calendar_event', 'get_calendar_events'])
    expect(next.askTools).toEqual([])
    // "Any change at all" comes off, keeping what it held for payments and deletes.
    expect(next.askBefore).toEqual(['payments', 'deletes'])
    expect(withPicked(next, ['get_calendar_events'], 'blocked').tools).toEqual(['create_calendar_event'])
    expect(withPicked(next, ['create_calendar_event'], 'ask').askTools).toEqual(['create_calendar_event'])
    // A delete on Always allow turns "Deleting anything asks you first" off; other deletes keep their own setting.
    const deletes = withPicked({ tools: ['delete_action'], askTools: ['delete_action'], askBefore: ['payments', 'deletes'] }, ['delete_calendar_event'], 'allow')
    expect(deletes.askBefore).toEqual(['payments'])
    expect(deletes.askTools).toEqual(['delete_action'])
  })

  it('payments and deletes ask first per person: on by default, and either can be turned off', () => {
    const household = presetSettings('household')
    expect(askIsOn(household, 'payments')).toBe(true)
    expect(askIsOn(household, 'deletes')).toBe(true)
    expect(household.askTools).toContain('delete_calendar_event')

    // Deletes off: held deletes stop asking, and a delete can be Always allow.
    const noDeleteAsk = withAsk(household, 'deletes', false)
    expect(noDeleteAsk.askBefore).toEqual(['payments'])
    expect(noDeleteAsk.askTools).not.toContain('delete_calendar_event')
    expect(withPicked(noDeleteAsk, ['delete_calendar_event'], 'allow').askTools).not.toContain('delete_calendar_event')
    // An outward tool starts on Needs approval, and the owner can set it to Always allow.
    expect(household.askTools).toContain('create_calendar_event')
    expect(withPicked(noDeleteAsk, ['create_calendar_event'], 'allow').askTools).not.toContain('create_calendar_event')

    // Back on: every held delete is Needs approval again.
    expect(withAsk(noDeleteAsk, 'deletes', true).askTools).toContain('delete_calendar_event')

    // Payments off leaves the tools alone.
    const noPayAsk = withAsk(household, 'payments', false)
    expect(noPayAsk.askBefore).toEqual(['deletes'])
    expect(noPayAsk.askTools).toEqual(household.askTools)

    // A Colleague's "any change at all" covers both, and turning one off keeps the other.
    const colleague = presetSettings('colleague')
    expect(askIsOn(colleague, 'deletes')).toBe(true)
    expect(withAsk(colleague, 'payments', false).askBefore).toEqual(['deletes'])
  })
})

describe('the People tab', () => {
  it('with no one added: not you, only that no one else can talk to the agent', async () => {
    await show()
    expect(q('[data-people-person]')).toBeNull()
    expect(q('[data-people-who]')!.textContent).not.toContain('Owner')
    expect(q('[data-people-others]')!.textContent).toContain('No one else can talk to Joseph')
    expect(q('[data-people-requests]')).toBeNull()
  })

  it('lists invited and active people with their preset and where they are', async () => {
    guests = [view(), view({ id: 'g-marco', displayName: 'Marco Ruiz', preset: 'colleague', state: 'invited', inviteExpiresAt: new Date(Date.now() + 86400_000).toISOString(), lastInboundAt: null })]
    await show()
    const sam = q('[data-people-guest="g-sam"]')!
    expect(sam.textContent).toContain('Sam Rivera')
    expect(sam.textContent).toContain('Text ··8830 · texted 2 h ago')
    expect(sam.textContent).toContain('Household')
    expect(q('[data-people-guest="g-marco"]')!.textContent).toContain('invited, hasn’t texted yet')
  })

  it('a request: Colleague allows them, and they move to the list', async () => {
    guests = [view({ id: 'g-priya', displayName: 'Priya Shah', state: 'requested', requestedAt: new Date(Date.now() - 5 * 60_000).toISOString() })]
    await show()
    expect(q('[data-people-request="g-priya"]')!.textContent).toContain('asked 5 min ago')
    await click(q('[data-people-request="g-priya"] [data-people-allow="colleague"]')!)
    await until(() => !q('[data-people-requests]'))
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ preset: 'colleague' })
    expect(q('[data-people-guest="g-priya"]')!.textContent).toContain('Colleague')
  })

  it('a request: Ignore drops it', async () => {
    guests = [view({ id: 'g-priya', displayName: 'Priya Shah', state: 'requested' })]
    await show()
    await click(q('[data-people-ignore]')!)
    await until(() => !q('[data-people-requests]'))
    expect(calls.some((c) => c.url === '/api/account/agent-guests/g-priya/ignore' && c.method === 'POST')).toBe(true)
  })

  it('Add a person: name, number and a preset, then the invite once', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await type(q('[data-people-name]') as HTMLInputElement, 'Marco Ruiz')
    await type(q('[data-people-phone]') as HTMLInputElement, '4155558831')
    await click(q('[data-people-preset="colleague"]')!)
    await click(q('[data-people-choose]')!)
    expect(q('[data-tool-group]')).not.toBeNull()
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-invite]'))
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/account/agent-guests')!.body as Record<string, unknown>
    const colleague = presetSettings('colleague')
    expect(post).toMatchObject({ displayName: 'Marco Ruiz', channels: ['sms'], phone: '+14155558831', preset: 'colleague', tools: colleague.tools, askTools: colleague.askTools })
    expect(q('[data-people-invite-channel="slack"]')).toBeNull()
    expect(q('[data-people-invite-text]')!.textContent).toBe("Hi, it's Marco · AB12CD")
    expect(q('[data-people-invite] [data-qr-code]')!.getAttribute('data-qr-code')).toBe("SMSTO:+14155550100:Hi, it's Marco · AB12CD")
    expect(q('[data-people-guest="g-new"]')).not.toBeNull()
  })

  it('Add a person on Slack only: no number asked for, and the invite says what to DM the Native Intelligence app', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await type(q('[data-people-name]') as HTMLInputElement, 'Marco Ruiz')
    await click(q('[data-people-channel-pick="slack"]')!)
    expect(q('[data-people-channel-pick="slack"]')!.getAttribute('aria-checked')).toBe('true')
    await click(q('[data-people-channel-pick="sms"]')!)
    expect(q('[data-people-phone]')).toBeNull()
    // At least one stays picked.
    await click(q('[data-people-channel-pick="slack"]')!)
    expect(q('[data-people-channel-pick="slack"]')!.getAttribute('aria-checked')).toBe('true')
    expect((q('[data-people-channel-pick="dial8"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-invite]'))
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/account/agent-guests')!.body as Record<string, unknown>
    expect(post).toMatchObject({ channels: ['slack'], phone: null })
    expect(q('[data-people-invite-channel="sms"]')).toBeNull()
    expect(q('[data-people-invite-channel="slack"]')!.textContent).toContain('the Native Intelligence app in Acme')
    expect(q('[data-people-guest="g-new"]')!.textContent).toContain('Slack · invited, hasn’t messaged yet')
  })

  it('Slack can’t be picked until Native Intelligence is in a Slack workspace, and Set up Slack opens its tab', async () => {
    slackInstalls = []
    const onOpenTab = vi.fn()
    await act(async () => root.render(<PeoplePanel name="Joseph" active onOpenTab={onOpenTab} />))
    await until(() => !!q('[data-people-who]'))
    await click(q('[data-people-add]')!)
    expect((q('[data-people-channel-pick="slack"]') as HTMLButtonElement).disabled).toBe(true)
    await click(q('[data-people-set-up-slack]')!)
    expect(onOpenTab).toHaveBeenCalledWith('slack')
  })

  it('a person’s page: adding Slack saves at once, then offers a new invite for it', async () => {
    guests = [view()]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    await click(q('[data-people-channel-pick="slack"]')!)
    await until(() => calls.some((c) => c.method === 'PATCH'))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ channels: ['sms', 'slack'] })
    await until(() => !!q('[data-people-unbound]'))
    expect(q('[data-people-unbound]')!.textContent).toContain("isn't on Slack yet")
    expect(q('[data-people-new-invite]')).not.toBeNull()
  })

  it('a person’s page: adding Text for someone on Slack alone asks for their number first', async () => {
    guests = [view({ channels: ['slack'], masked: null })]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    await click(q('[data-people-channel-pick="sms"]')!)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    await type(q('[data-people-page] [data-people-phone]') as HTMLInputElement, '4155550000')
    await click(q('[data-people-save-channels]')!)
    await until(() => calls.some((c) => c.method === 'PATCH'))
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ channels: ['sms', 'slack'], phone: '+14155550000' })
    await until(() => !q('[data-people-save-channels]'))
  })

  it('a person’s page: calendar emails save on leaving the field, cleaned; a typo is named beside it and nothing is saved', async () => {
    guests = [view({ displayName: 'Jess Alizadeh' })]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    const field = q('[data-people-calendar-emails]') as HTMLInputElement
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('jess@example.com')
    await type(field, 'Jess@Gmail.com, jess@gmail.com; jess@work.example')
    await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await until(() => calls.some((c) => c.method === 'PATCH'))
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ calendarEmails: ['jess@gmail.com', 'jess@work.example'] }])
    await until(() => (q('[data-people-calendar-emails]') as HTMLInputElement).value === 'jess@gmail.com, jess@work.example')
    // Leaving it unchanged saves nothing.
    await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await type(field, 'jess@')
    await act(async () => field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(q('[data-people-page] [role="alert"]')!.textContent).toBe('Enter up to 5 email addresses, separated by commas.')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1)
  })

  it('a person’s page: a whole section set at once, saved as tools and askTools', async () => {
    guests = [view()]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    expect(q('[data-people-page="g-sam"]')!.textContent).toContain('Joseph for Sam Rivera')
    const row = q('[data-tool-row="get_calendar_events"]')!
    expect(row.querySelector('[aria-checked="true"]')!.getAttribute('aria-label')).toBe('Always allow')
    await click(row.querySelector('[aria-label="Blocked"]')!)
    await until(() => calls.some((c) => c.method === 'PATCH'))
    const patch = calls.find((c) => c.method === 'PATCH')!.body as { tools: string[]; askTools: string[] }
    expect(patch.tools).not.toContain('get_calendar_events')
    expect(patch).toHaveProperty('askTools')
  })

  it('Add a person by their agent alone: pick the teammate, send the request, and they wait to accept', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await click(q('[data-people-channel-pick="sms"]')!)
    await click(q('[data-people-channel-pick="dial8"]')!)
    expect(q('[data-people-channel-pick="sms"]')!.getAttribute('aria-checked')).toBe('true')
    await click(q('[data-people-channel-pick="sms"]')!)
    expect(q('[data-people-phone]')).toBeNull()
    expect((q('[data-people-create]') as HTMLButtonElement).disabled).toBe(true)
    await click(q('[data-people-teammate="u-marco"]')!)
    expect((q('[data-people-name]') as HTMLInputElement).value).toBe('Marco Ruiz')
    expect(q('[data-people-create]')!.textContent).toBe('Send request')
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-guest="g-half"]'))
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/account/agent-links')!.body).toMatchObject({ peerUserId: 'u-marco', displayName: 'Marco Ruiz', preset: 'household' })
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/account/agent-guests')).toBe(false)
    expect(q('[data-people-guest="g-half"]')!.textContent).toContain('Their agent · asked, waiting for them to accept')
  })

  it('Add a person on Text and their agent: one row, the request first, then Text and its invite', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await click(q('[data-people-channel-pick="dial8"]')!)
    await click(q('[data-people-teammate="u-marco"]')!)
    await type(q('[data-people-phone]') as HTMLInputElement, '4155558831')
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-invite]'))
    const order = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`)
    expect(order).toEqual(['POST /api/account/agent-links', 'PATCH /api/account/agent-guests/g-half', 'POST /api/account/agent-guests/g-half/invite'])
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ channels: ['sms'], phone: '+14155558831' })
    expect(q('[data-people-invite-channel="sms"]')).not.toBeNull()
  })

  it('an agent asking to talk: Review chooses what it may ask, and Let them talk lands on their page', async () => {
    links = [linkView()]
    await show()
    expect(q('[data-people-link-request="l-dana"]')!.textContent).toContain('Their agent, Ava · Northwind · asked 5 min ago')
    await click(q('[data-people-review-open]')!)
    expect(q('[data-people-review="l-dana"]')!.textContent).toContain('What Dana’s agent can ask Joseph'.replace('’', "'"))
    await click(q('[data-people-preset="household"]')!)
    expect(q('[data-people-answer-workspaces]')).toBeNull()
    await until(() => !(q('[data-people-accept]') as HTMLButtonElement).disabled)
    await click(q('[data-people-accept]')!)
    await until(() => !!q('[data-people-page="g-dana"]'))
    const household = presetSettings('household')
    expect(calls.find((c) => c.url.endsWith('/accept'))!.body).toEqual({ preset: 'household', tools: household.tools, askTools: household.askTools, askBefore: household.askBefore })
    expect(q('[data-people-link="active"]')!.textContent).toContain('Dana chose: when you’re free.')
  })

  it('an agent asking to talk, with two workspaces: pick which agent answers; one whose admin turned off outside links can’t', async () => {
    links = [linkView()]
    answerWorkspaces = [
      { id: 'w-acme', name: 'Acme', outsideAllowed: false },
      { id: 'w-side', name: 'Side Project', outsideAllowed: true },
    ]
    await show()
    await click(q('[data-people-review-open]')!)
    await until(() => !!q('[data-people-answer-workspaces]'))
    const acme = q('[data-people-answer-workspace="w-acme"]') as HTMLButtonElement
    expect(acme.disabled).toBe(true)
    expect(acme.textContent).toContain('Your workspace admin has turned off links outside this workspace')
    expect((q('[data-people-accept]') as HTMLButtonElement).disabled).toBe(true)
    await click(q('[data-people-answer-workspace="w-side"]')!)
    await click(q('[data-people-accept]')!)
    await until(() => calls.some((c) => c.url.endsWith('/accept')))
    expect(calls.find((c) => c.url.endsWith('/accept'))!.body).toMatchObject({ workspaceId: 'w-side' })
  })

  it('Add a person’s agent by email: always “Request sent”', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await click(q('[data-people-channel-pick="dial8"]')!)
    await click(q('[data-people-channel-pick="sms"]')!)
    await click(q('[data-people-agent-by="email"]')!)
    await type(q('[data-people-name]') as HTMLInputElement, 'Dana Kim')
    await type(q('[data-people-email]') as HTMLInputElement, 'not-an-email')
    expect((q('[data-people-create]') as HTMLButtonElement).disabled).toBe(true)
    await type(q('[data-people-email]') as HTMLInputElement, 'dana@northwind.com')
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-sent="email"]'))
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/account/agent-links')!.body).toMatchObject({ email: 'dana@northwind.com', displayName: 'Dana Kim' })
    expect(q('[data-people-sent]')!.textContent).toContain('Request sent')
    expect(q('[data-people-sent]')!.textContent).not.toMatch(/not found|isn.t on (Native Intelligence|Dial8)/i)
  })

  it('Add a person’s agent by a connect link: the link, shown once to copy', async () => {
    await show()
    await click(q('[data-people-add]')!)
    await click(q('[data-people-channel-pick="dial8"]')!)
    await click(q('[data-people-channel-pick="sms"]')!)
    await click(q('[data-people-agent-by="link"]')!)
    await type(q('[data-people-name]') as HTMLInputElement, 'Dana Kim')
    expect(q('[data-people-create]')!.textContent).toBe('Make link')
    await click(q('[data-people-create]')!)
    await until(() => !!q('[data-people-sent="link"]'))
    expect(calls.find((c) => c.url === '/api/account/agent-links/connect')!.body).toMatchObject({ displayName: 'Dana Kim', preset: 'household' })
    expect(q('[data-people-connect-url]')!.textContent).toBe('https://nativeintelligence.dev/link/tok123')
    expect(q('[data-people-sent]')!.textContent).toContain('Works once, for 7 days')
  })

  it('an agent asking to talk: Ignore drops it', async () => {
    links = [linkView()]
    await show()
    await click(q('[data-people-link-ignore]')!)
    await until(() => !q('[data-people-link-requests]'))
    expect(calls.some((c) => c.url === '/api/account/agent-links/l-dana/ignore' && c.method === 'POST')).toBe(true)
  })

  it('a person’s page: their agent is turned on with a teammate, on the same row', async () => {
    guests = [view()]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    await click(q('[data-people-channel-pick="dial8"]')!)
    expect(calls.some((c) => c.method !== 'GET')).toBe(false)
    await click(q('[data-people-teammate="u-marco"]')!)
    await click(q('[data-people-save-channels]')!)
    await until(() => !!q('[data-people-link="requested"]'))
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/account/agent-links')!.body).toMatchObject({ guestId: 'g-sam', peerUserId: 'u-marco' })
    expect(q('[data-people-page="g-sam"]')!.textContent).toContain('Waiting for Sam to accept')
  })

  it('a person’s page: Disconnect ends the link and keeps Text', async () => {
    guests = [view({ channels: ['sms', 'dial8'], peerUserId: 'u-marco' })]
    links = [linkView({ id: 'l-sam', state: 'active', direction: 'outgoing', myHalfGuestId: 'g-sam', theirHalf: { summary: 'when they’re free' } })]
    await show()
    await click(q('[data-people-guest="g-sam"] [data-people-open]')!)
    expect((q('[data-people-channel-pick="dial8"]') as HTMLButtonElement).disabled).toBe(true)
    await click(q('[data-people-disconnect]')!)
    const confirm = await (async () => {
      await until(() => [...document.body.querySelectorAll('button')].some((b) => b.textContent === 'Disconnect' && !b.hasAttribute('data-people-disconnect')))
      return [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Disconnect' && !b.hasAttribute('data-people-disconnect'))!
    })()
    await click(confirm)
    await until(() => !q('[data-people-link]'))
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/account/agent-links/l-sam')).toBe(true)
    expect(q('[data-people-channel-pick="sms"]')!.getAttribute('aria-checked')).toBe('true')
    expect(q('[data-people-channel-pick="dial8"]')!.getAttribute('aria-checked')).toBe('false')
  })

  it('lands on an agent’s request from a connect link, to review it', async () => {
    links = [linkView()]
    await act(async () => root.render(<PeoplePanel name="Joseph" active onOpenTab={() => {}} focusLinkId="l-dana" />))
    await until(() => !!q('[data-people-review="l-dana"]'))
  })

  it('lands on a person from a chat card: their page, or their request highlighted', async () => {
    guests = [view(), view({ id: 'g-priya', displayName: 'Priya Shah', state: 'requested' })]
    await act(async () => root.render(<PeoplePanel name="Joseph" active onOpenTab={() => {}} focusGuestId="g-sam" />))
    await until(() => !!q('[data-people-page="g-sam"]'))
    await act(async () => root.unmount())
    root = createRoot(host)
    await show({ focusGuestId: 'g-priya' })
    expect(q('[data-people-request="g-priya"]')!.className).toContain('border-foreground/40')
  })
})
