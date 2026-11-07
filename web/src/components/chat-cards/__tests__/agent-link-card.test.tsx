// @vitest-environment jsdom
/**
 * The two agents' conversation as a card (the `agent_link` page kind, agent
 * links phase D): read from its route, each exchange under its topic line and
 * drawn with the chat's own message list (the other agent's words incoming),
 * oldest first, opened on the exchange it was opened for; read-only; its
 * header says whose agent and from where and opens People.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { CardHeaderSlotsProvider } from '../card-header-slot'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const editor = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/components/bots/agent-editor', () => ({ openAgentEditor: editor.open }))

import AgentLinkCard from '../pages/agent-link-card'

const LINK = '77777777-0000-4000-8000-000000000007'
const HALF = '44444444-0000-4000-8000-000000000004'
const E1 = '88888888-0000-4000-8000-000000000001'
const E2 = '88888888-0000-4000-8000-000000000002'
const spec: PageCardSpec = { kind: 'agent_link', title: 'Dana Kim’s agent', target: { type: 'agent_link', id: LINK, label: 'Dana Kim’s agent' } }
const msg = (id: string, from: 'me' | 'them', body: string) => ({ id, from, kind: from === 'me' ? 'ask' : 'answer', body, at: '2026-10-25T13:00:00Z' })

let answer: { status: number; body: unknown }
const fetched: string[] = []
let mount: ReturnType<typeof mountRoot>
let right: HTMLDivElement

beforeEach(() => {
  mount = mountRoot()
  fetched.length = 0
  editor.open.mockClear()
  answer = {
    status: 200,
    body: {
      link: { id: LINK, state: 'active', peerName: 'Dana Kim', workspaceName: 'Northwind', myHalfGuestId: HALF },
      // Newest first, as the route answers.
      exchanges: [
        { id: E2, topic: 'Hold a time for the renewal', state: 'capped', startedBy: 'them', messages: [msg('m3', 'them', 'Can Liam hold Thu 2:00?'), msg('m4', 'me', 'Held.')], createdAt: '2026-10-25T14:00:00Z', closedAt: null },
        { id: E1, topic: '30 min this week', state: 'done', startedBy: 'me', messages: [msg('m1', 'me', 'Liam would like 30 minutes.'), msg('m2', 'them', 'Thu 2:00 or Fri 10:00.')], createdAt: '2026-10-25T13:00:00Z', closedAt: '2026-10-25T13:05:00Z' },
      ],
      hasMore: false,
    },
  }
  vi.stubGlobal('fetch', async (input: unknown) => {
    fetched.push(String(input))
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } })
  })
  Element.prototype.scrollIntoView = vi.fn()
  right = document.createElement('div')
  document.body.appendChild(right)
})
afterEach(() => {
  mount.unmount()
  right.remove()
  vi.unstubAllGlobals()
})

async function show(store = makeStore('l1', spec)) {
  await mount.render(
    React.createElement(CardHeaderSlotsProvider, { value: { left: null, right } }, React.createElement(AgentLinkCard, { toolCallId: 'l1', spec, store, fullScreen: false })),
  )
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  return store
}

describe('the two agents’ conversation card', () => {
  it('reads the link’s exchanges and draws each, oldest first, under its line, read-only', async () => {
    await show()
    expect(fetched).toEqual([`/api/account/agent-links/${LINK}/exchanges`])
    const sections = [...mount.container.querySelectorAll<HTMLElement>('[data-agent-link-exchange]')].map((s) => s.dataset.agentLinkExchange)
    expect(sections).toEqual([E1, E2])
    const lines = [...mount.container.querySelectorAll('[data-agent-link-exchange-line]')].map((l) => l.textContent)
    expect(lines).toEqual(['30 min this week · Your agent asked', 'Hold a time for the renewal · Dana Kim’s agent asked · stopped at 8 messages'])
    const rows = [...mount.container.querySelectorAll('[data-message-row]')].map((r) => r.getAttribute('data-message-row'))
    expect(rows).toEqual(['agent-link-message:m1', 'agent-link-message:m2', 'agent-link-message:m3', 'agent-link-message:m4'])
    expect(mount.container.textContent).toContain('Thu 2:00 or Fri 10:00.')
    expect(mount.container.querySelector('textarea, input')).toBeNull()
    expect(mount.container.querySelector('[data-message-feedback]')).toBeNull()
  })

  it('its header says from where, and opens my half in People', async () => {
    await show()
    expect(right.textContent).toContain('Northwind')
    expect(right.textContent).not.toContain('Dana Kim')
    const manage = right.querySelector<HTMLButtonElement>('[data-agent-link-manage]')!
    await act(async () => manage.click())
    expect(editor.open).toHaveBeenCalledWith(manage, 'people', { guestId: HALF })
  })

  it('opens on the exchange it was opened for', async () => {
    const store = makeStore('l1', spec)
    store.update('l1', { at: { type: 'agent_link_exchange', id: E1 } })
    await show(store)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts[0]).toBe(mount.container.querySelector(`[data-agent-link-exchange="${E1}"]`))
  })

  it('no exchanges yet says so; a link that isn’t mine, or a failed read, says that', async () => {
    answer.body = { ...(answer.body as object), exchanges: [] }
    await show()
    expect(mount.container.textContent).toContain('Your agent and Dana Kim’s agent haven’t talked yet.')
    mount.unmount()
    mount = mountRoot()
    answer = { status: 404, body: { error: 'No such link' } }
    await show()
    expect(mount.container.textContent).toContain('no longer yours to read')
  })
})
