// @vitest-environment jsdom
/**
 * A guest's conversation as a card (the `guest` page kind, guest access PR4):
 * read from its route, drawn with the chat's own message list, opened on the
 * message it was opened for; read-only (no composer, no reply or thumbs on
 * its bubbles); its header says who and how and opens People.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { CardHeaderSlotsProvider } from '../card-header-slot'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const editor = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/components/bots/agent-editor', () => ({ openAgentEditor: editor.open }))

import GuestCard from '../pages/guest-card'

const GUEST = '44444444-0000-4000-8000-000000000004'
const spec: PageCardSpec = { kind: 'guest', title: 'Sam', target: { type: 'guest', id: GUEST, label: 'Sam' } }
const text = (id: string, role: 'user' | 'assistant', words: string) => ({ id, role, parts: [{ type: 'text', text: words }], metadata: { createdAt: '2026-10-24T13:00:00Z' } })

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
      guest: { id: GUEST, displayName: 'Sam', preset: 'household', state: 'active', channel: 'sms' },
      conversationId: 'c1',
      messages: [
        text('sms-in:SM1', 'user', 'Book Nopa Saturday 7:30 for us'),
        text('home-turn:1', 'assistant', 'Done. Nopa is booked Saturday 7:30 for 2.'),
        text('sms-in:SM2', 'user', 'When does Liam land tomorrow?'),
        text('home-turn:2', 'assistant', 'His flight gets into SFO at 6:05 PM.'),
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

async function show(store = makeStore('g1', spec)) {
  await mount.render(
    React.createElement(CardHeaderSlotsProvider, { value: { left: null, right } }, React.createElement(GuestCard, { toolCallId: 'g1', spec, store, fullScreen: false })),
  )
  await act(async () => new Promise((r) => setTimeout(r, 0)))
  return store
}

describe('a guest’s conversation card', () => {
  it('reads the guest’s thread and draws it with the chat’s own messages, read-only', async () => {
    await show()
    expect(fetched).toEqual([`/api/account/agent-guests/${GUEST}/conversation`])
    const rows = [...mount.container.querySelectorAll('[data-message-row]')].map((r) => r.getAttribute('data-message-row'))
    expect(rows).toEqual(['sms-in:SM1', 'home-turn:1', 'sms-in:SM2', 'home-turn:2'])
    expect(mount.container.textContent).toContain('His flight gets into SFO at 6:05 PM.')
    // Nothing to type into, and nothing that acts on the owner's chat.
    expect(mount.container.querySelector('textarea, input')).toBeNull()
    expect(mount.container.querySelector('[data-message-feedback]')).toBeNull()
  })

  it('its header says who and how, and opens People', async () => {
    await show()
    expect(right.textContent).toContain('Household · by text')
    const manage = right.querySelector<HTMLButtonElement>('[data-guest-manage]')!
    await act(async () => manage.click())
    expect(editor.open).toHaveBeenCalledWith(manage, 'people', { guestId: GUEST })
  })

  it('opens on the message it was opened for', async () => {
    const store = makeStore('g1', spec)
    store.update('g1', { at: { type: 'guest_message', id: 'sms-in:SM2' } })
    await show(store)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1)
    expect((Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.contexts[0]).toBe(mount.container.querySelector('[data-message-row="sms-in:SM2"]'))
  })

  it('a guest who hasn’t texted says so; one who is gone, or a failed read, says that', async () => {
    answer.body = { ...(answer.body as object), messages: [], conversationId: null }
    await show()
    expect(mount.container.textContent).toContain('Sam hasn’t texted yet.')
    mount.unmount()
    mount = mountRoot()
    answer = { status: 404, body: { error: 'No such person' } }
    await show()
    expect(mount.container.textContent).toContain('no longer one of your guests')
  })
})
