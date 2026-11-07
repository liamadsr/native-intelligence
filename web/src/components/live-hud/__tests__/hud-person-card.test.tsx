// @vitest-environment jsdom
/**
 * Who's on the call (./hud-person-card.tsx, in AgentHudView's chips). Pinned:
 *   - only a speaker Voice ID has linked to a contact gets a card: an
 *     unknown voice and a suggested match fetch nothing and show nothing;
 *   - each contact is fetched once per call, however often the feed changes,
 *     and a newly linked speaker's contact once more;
 *   - the linked chip's Voice ID card shows role · company, the relationship
 *     and one line of background; a missing contact shows no lines;
 *   - a new call fetches again;
 *   - each fetch names the call's workspace (Voice ID's state) itself, so a
 *     chip that mounts before the HUD window points its requests there never
 *     asks the last-saved workspace (and caches a 404 for the call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/live-chat/live-chat', () => ({ LiveChat: () => h('div', { 'data-chat-stub': '' }) }))
vi.mock('../use-live-agent-name', () => ({ useLiveAgentName: () => 'Sales Coach' }))

import { AgentHudView } from '../agent-hud-view'
import { EMPTY_HUD_FEED, type AgentHudFeed } from '../hud-feed'
import { __resetHudPeopleForTests, loadHudPerson } from '../hud-person-card'
import type { VoiceIdHudState } from '@/lib/live-agent/voice-id-hud'
import type { SpeakerIdentification } from '@/lib/voice-id-service'

const linked = (contactId: string, contactName: string): SpeakerIdentification => ({
  contactId,
  contactName,
  confidence: 0.91,
  isAutoMatched: true,
  isSuggestion: false,
})
const suggested = (contactId: string, contactName: string): SpeakerIdentification => ({
  ...linked(contactId, contactName),
  isSuggestion: true,
  autoAcceptCountdown: 8,
})

const voiceId = (contacts: Record<string, SpeakerIdentification>, captureId = 'cap-1'): VoiceIdHudState => ({
  captureId,
  workspaceId: 'ws-1',
  detectedSpeakers: ['local_1', 'remote_1', 'remote_2'],
  activeSpeaker: null,
  speakerNames: {},
  demotedSelfLabels: [],
  speakerContacts: contacts,
  postSessionReview: null,
  selfSuggestion: null,
})

const PEOPLE: Record<string, unknown> = {
  'c-sam': {
    id: 'c-sam',
    name: 'Sam Rivera',
    role: 'VP Sales',
    company: 'Acme',
    relationship: 'Customer · Warm',
    background: 'Ran sales at Initech for six years.',
  },
  'c-ana': { id: 'c-ana', name: 'Ana Lee', role: null, company: 'Globex', relationship: null, background: null },
}

let fetchMock: ReturnType<typeof vi.fn>
let container: HTMLDivElement
let root: Root
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)) })
const cardFetches = () =>
  fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/account/contacts/'))

beforeEach(() => {
  __resetHudPeopleForTests()
  fetchMock = vi.fn(async (url: string) => {
    const id = /\/contacts\/([^/]+)\/card$/.exec(url)?.[1]
    const person = id ? PEOPLE[decodeURIComponent(id)] : undefined
    return (person
      ? { ok: true, status: 200, json: async () => ({ person }) }
      : { ok: false, status: 404, json: async () => ({ error: 'Contact not found' }) }) as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (feed: Partial<AgentHudFeed>) =>
  act(async () => root.render(h(AgentHudView, { host: 'window', feed: { ...EMPTY_HUD_FEED, ...feed }, actions: { sendVoiceIdAction: () => {} } })))
const chipButton = (speaker: string) => container.querySelector(`[data-participant="${speaker}"] button`) as HTMLButtonElement
const person = () => document.querySelector('[data-hud-person]')

describe('only linked speakers', () => {
  it('fetches the linked contact alone: not the unknown voice, not the suggestion', async () => {
    await render({ voiceId: voiceId({ remote_1: linked('c-sam', 'Sam Rivera'), remote_2: suggested('c-ana', 'Ana Lee') }) })
    await flush()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-sam/card'])
  })

  it("the linked chip's card says who they are", async () => {
    await render({ voiceId: voiceId({ remote_1: linked('c-sam', 'Sam Rivera') }) })
    await flush()
    await act(async () => chipButton('remote_1').click())
    await flush()
    const card = person()!
    expect(card.getAttribute('data-hud-person')).toBe('c-sam')
    expect(card.querySelector('[data-hud-person-role]')!.textContent).toBe('VP Sales · Acme')
    expect(card.querySelector('[data-hud-person-relationship]')!.textContent).toBe('Customer · Warm')
    expect(card.querySelector('[data-hud-person-background]')!.textContent).toBe('Ran sales at Initech for six years.')
    // Inside Voice ID's own card for that speaker, its Unlink still there.
    expect(card.closest('[role="dialog"]')!.textContent).toContain('Unlink')
    // Opening it fetched nothing more.
    expect(cardFetches()).toHaveLength(1)
  })

  it('an unknown speaker opens the contact search as before, with no card', async () => {
    await render({ voiceId: voiceId({}) })
    await flush()
    expect(cardFetches()).toEqual([])
    expect(person()).toBeNull()
  })
})

describe('once per contact per call', () => {
  it('feed changes fetch nothing more; a newly linked speaker fetches its contact once', async () => {
    const first = { remote_1: linked('c-sam', 'Sam Rivera'), remote_2: suggested('c-ana', 'Ana Lee') }
    await render({ voiceId: voiceId(first) })
    await flush()
    await render({ voiceId: voiceId({ ...first }), lastSpeaker: 'remote_1' })
    await render({ voiceId: voiceId({ ...first }), lastSpeaker: 'remote_2' })
    await flush()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-sam/card'])

    // The suggestion is accepted: now linked, fetched once.
    const accepted = { remote_1: linked('c-sam', 'Sam Rivera'), remote_2: linked('c-ana', 'Ana Lee') }
    await render({ voiceId: voiceId(accepted) })
    await render({ voiceId: voiceId({ ...accepted }), lastSpeaker: 'local_1' })
    await flush()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-sam/card', '/api/account/contacts/c-ana/card'])
  })

  it('two speakers linked to one contact fetch it once', async () => {
    await render({ voiceId: voiceId({ remote_1: linked('c-sam', 'Sam Rivera'), remote_2: linked('c-sam', 'Sam Rivera') }) })
    await flush()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-sam/card'])
  })

  it('a missing contact is not asked for again, even when its card is opened', async () => {
    await render({ voiceId: voiceId({ remote_1: linked('c-gone', 'Gone') }) })
    await flush()
    await act(async () => chipButton('remote_1').click())
    await flush()
    expect(person()).toBeNull()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-gone/card'])
  })

  it('a new call asks again', async () => {
    loadHudPerson('cap-1', 'ws-1', 'c-sam')
    loadHudPerson('cap-1', 'ws-1', 'c-sam')
    await flush()
    loadHudPerson('cap-2', 'ws-1', 'c-sam')
    await flush()
    expect(cardFetches()).toEqual(['/api/account/contacts/c-sam/card', '/api/account/contacts/c-sam/card'])
  })
})

describe("the call's workspace", () => {
  it("each fetch carries Voice ID's workspace itself, whatever the client last saved", async () => {
    await render({ voiceId: { ...voiceId({ remote_1: linked('c-sam', 'Sam Rivera') }), workspaceId: 'ws-call' } })
    await flush()
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/account/contacts/c-sam/card')!
    expect(new Headers((call[1] as RequestInit).headers).get('x-workspace-id')).toBe('ws-call')
  })

  it('a contact is cached per workspace: a miss in one never hides it in another', async () => {
    loadHudPerson('cap-1', 'ws-old', 'c-sam')
    loadHudPerson('cap-1', 'ws-call', 'c-sam')
    loadHudPerson('cap-1', 'ws-call', 'c-sam')
    await flush()
    expect(cardFetches()).toHaveLength(2)
    expect(fetchMock.mock.calls.map((c) => new Headers((c[1] as RequestInit).headers).get('x-workspace-id'))).toEqual(['ws-old', 'ws-call'])
  })
})
