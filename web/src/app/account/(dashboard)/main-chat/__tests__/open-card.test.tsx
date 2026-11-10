// @vitest-environment jsdom
/**
 * Every way in opens a card (P5): the main chat's provider routes an
 * OPEN_CARD_EVENT to the one chat (docs/plans/one-chat.md), and a card of
 * another workspace only once that workspace's chat is in. The boot deep links
 * (?sequence=, ?prospect_list=, ?action=) open cards the same way, in the chat
 * the workspace ends up with.
 *
 * Pinned:
 *   • same workspace → delivered to the chat, no switch;
 *   • other workspace → parked, switched, and delivered to the NEW workspace's
 *     chat once it is in (never the outgoing one's);
 *   • a refused switch (a capture recording) drops it, so a later switch never
 *     replays it, and so does a switch that ends up somewhere else;
 *   • a card that once asked for a tab of its own (`newTab`) opens in the chat;
 *   • the deep links: delivered to the STORED chat, the param stripped, one
 *     per boot.
 *
 * Driven through a real render (createRoot + act); the async workspace fetch
 * is simulated by flipping the mocked `useWorkspaceId` and re-rendering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'
import { OPEN_CARD_EVENT, cardForTarget, openTarget } from '@/lib/chat-cards/open-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS_A = 'ws-a'
const WS_B = 'ws-b'
const WS_C = 'ws-c'

let currentWorkspaceId: string | null = WS_A
let switchStarts = true
const switchWorkspace = vi.fn((_id: string) => switchStarts)

vi.mock('@/app/account/workspace-switcher', () => ({
  useWorkspaceId: () => currentWorkspaceId,
  useSwitchWorkspace: () => switchWorkspace,
}))

import { MainChatProvider, useCardDeliveries, useMainChat, type CardDelivery } from '../main-chat-context'

let container: HTMLDivElement
let root: Root
let state: ReturnType<typeof useMainChat> | null = null
/** Every card delivered, in order, acknowledged as the host does. */
let delivered: CardDelivery[] = []

function Probe() {
  state = useMainChat()
  const cards = useCardDeliveries()
  useEffect(() => {
    if (!cards) return
    for (const d of cards.deliveries) {
      delivered.push(d)
      cards.ack(d.id)
    }
  }, [cards])
  return null
}

function render() {
  act(() => {
    root.render(h(MainChatProvider, null, h(Probe)))
  })
}

function workspaceArrives(id: string) {
  currentWorkspaceId = id
  render()
}

const ACTION = { type: 'action' as const, id: 'a-1', title: 'GEN-1 Pricing' }

/** The chat a workspace keeps on this device, and the pointer at it. */
function storeChat(workspaceId: string, chatSessionId: string) {
  localStorage.setItem(`dial8-chat:${workspaceId}`, JSON.stringify({ chatSessionId, chatMessages: [], chatInput: '' }))
  localStorage.setItem('dial8-chat:last-workspace', workspaceId)
}
const sessionNow = () => state!.chat.chatSessionId

beforeEach(() => {
  localStorage.clear()
  currentWorkspaceId = WS_A
  switchStarts = true
  switchWorkspace.mockClear()
  state = null
  delivered = []
  window.history.replaceState({}, '', '/account')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('a card asked for from anywhere', () => {
  it('same workspace: goes to the chat on screen, no switch', () => {
    render()
    act(() => {
      openTarget(ACTION, { from: 'chip', workspaceId: WS_A })
    })
    expect(switchWorkspace).not.toHaveBeenCalled()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe(sessionNow())
    expect(delivered[0].request).toMatchObject({ spec: cardForTarget(ACTION)!.spec, from: 'chip' })
  })

  it('without a workspace: the one on screen', () => {
    render()
    act(() => {
      openTarget(ACTION, { from: 'chip' })
    })
    expect(delivered.map((d) => d.chatSessionId)).toEqual([sessionNow()])
  })

  it('other workspace: switches, and lands only once that workspace’s chat is in', () => {
    storeChat(WS_B, 's-b')
    render()
    const outgoing = sessionNow()
    act(() => {
      openTarget(ACTION, { from: 'notification', workspaceId: WS_B })
    })
    expect(switchWorkspace).toHaveBeenCalledWith(WS_B)
    // Nothing yet: the chat on screen is still A's.
    expect(delivered).toHaveLength(0)
    workspaceArrives(WS_B)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe('s-b')
    expect(delivered[0].chatSessionId).not.toBe(outgoing)
  })

  it('other workspace with no chat of its own yet: lands in its new one', () => {
    render()
    act(() => {
      openTarget(ACTION, { from: 'notification', workspaceId: WS_B })
    })
    workspaceArrives(WS_B)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe(sessionNow())
    expect(localStorage.getItem(`dial8-chat:${WS_B}`)).toContain(sessionNow())
  })

  it('a refused switch (a capture recording) drops it: a later switch never replays it', () => {
    render()
    switchStarts = false
    act(() => {
      openTarget(ACTION, { from: 'notification', workspaceId: WS_B })
    })
    switchStarts = true
    workspaceArrives(WS_B)
    expect(delivered).toHaveLength(0)
  })

  it('a switch that ends up elsewhere drops it rather than opening it there', () => {
    render()
    act(() => {
      openTarget(ACTION, { from: 'notification', workspaceId: WS_B })
    })
    workspaceArrives(WS_C)
    expect(delivered).toHaveLength(0)
  })

  it('a card that asks for a tab of its own (newTab) opens in the one chat', () => {
    render()
    const before = sessionNow()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CARD_EVENT, { detail: { spec: cardForTarget(ACTION)!.spec, from: 'notification', newTab: true } }))
    })
    expect(sessionNow()).toBe(before)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe(before)
    expect(delivered[0].request).not.toHaveProperty('newTab')
  })

  it('ignores an event that carries no card', () => {
    render()
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_CARD_EVENT, { detail: { spec: { kind: 'nav', title: 'x' } } }))
    })
    expect(delivered).toHaveLength(0)
  })
})

describe('boot deep links open cards', () => {
  for (const [param, kind, targetType] of [
    ['sequence', 'sequences', 'sequence'],
    ['prospect_list', 'prospecting', 'prospect_list'],
  ] as const) {
    it(`?${param}= opens the ${kind} card in the STORED chat and strips the param`, () => {
      storeChat(WS_A, 's-a')
      window.history.replaceState({}, '', `/account?${param}=00000000-0000-4000-8000-000000000009&utm_source=email`)
      render()
      expect(delivered).toHaveLength(1)
      expect(delivered[0].chatSessionId).toBe('s-a')
      expect(delivered[0].request.spec).toMatchObject({ kind, target: { type: targetType, id: '00000000-0000-4000-8000-000000000009' } })
      expect(window.location.search).toBe('?utm_source=email')
    })
  }

  it('?action= opens the action’s record card', () => {
    window.history.replaceState({}, '', '/account?action=00000000-0000-4000-8000-000000000007')
    render()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].request.spec).toMatchObject({ kind: 'record', record: { type: 'action', id: '00000000-0000-4000-8000-000000000007' } })
    expect(window.location.search).toBe('')
  })

  it('one per boot', () => {
    window.history.replaceState({}, '', '/account?sequence=00000000-0000-4000-8000-000000000001&prospect_list=00000000-0000-4000-8000-000000000011')
    render()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].request.spec.kind).toBe('sequences')
  })

  it('booted from the pointer: waits for the real workspace, then lands in its chat', () => {
    storeChat(WS_B, 's-b')
    localStorage.setItem('dial8-chat:last-workspace', WS_A)
    currentWorkspaceId = null
    window.history.replaceState({}, '', '/account?sequence=00000000-0000-4000-8000-000000000001')
    render()
    expect(delivered).toHaveLength(0)
    workspaceArrives(WS_B)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe('s-b')
  })

  it('pointer A but the server says B (nothing stored): lands in B’s new chat, never A’s', () => {
    storeChat(WS_A, 's-a')
    currentWorkspaceId = null
    window.history.replaceState({}, '', '/account?sequence=00000000-0000-4000-8000-00000000000b')
    render()
    expect(delivered).toHaveLength(0)
    workspaceArrives(WS_B)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).not.toBe('s-a')
    expect(delivered[0].chatSessionId).toBe(sessionNow())
    // A's chat went back to A's key.
    expect(localStorage.getItem(`dial8-chat:${WS_A}`)).toContain('s-a')
  })

  it('no pointer and nothing stored: lands in the chat in memory once the id arrives, which is then stored', () => {
    currentWorkspaceId = null
    window.history.replaceState({}, '', '/account?sequence=00000000-0000-4000-8000-0000000000f1')
    render()
    expect(window.location.search).toBe('')
    workspaceArrives(WS_A)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].chatSessionId).toBe(sessionNow())
    expect(localStorage.getItem(`dial8-chat:${WS_A}`)).toContain(sessionNow())
  })

  it.each([
    ['project', 'project'],
    ['initiative', 'initiative'],
  ] as const)('?%s= (flows’ links) opens its record card', (param, type) => {
    const id = '00000000-0000-4000-8000-0000000000aa'
    window.history.replaceState({}, '', `/account?${param}=${id}`)
    render()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].request.spec).toMatchObject({ kind: 'record', record: { type, id } })
  })

  it.each([
    ['document', 'document'],
    ['capture', 'capture'],
    ['contact', 'contact'],
    ['company', 'company'],
    ['deal', 'deal'],
  ] as const)('?%s= (a menu’s Copy link) opens its record card', (param, type) => {
    const id = '00000000-0000-4000-8000-0000000000bb'
    window.history.replaceState({}, '', `/account?${param}=${id}`)
    render()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].request.spec).toMatchObject({ kind: 'record', record: { type, id } })
  })

  it('?flow= opens the flows card on its editor', () => {
    const id = '00000000-0000-4000-8000-0000000000cc'
    window.history.replaceState({}, '', `/account?flow=${id}`)
    render()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].request).toMatchObject({ spec: { kind: 'flows' }, seed: { editing: id } })
  })

  it('a kind with no link opens nothing (?calendar_event=, ?claim=)', () => {
    window.history.replaceState({}, '', '/account?calendar_event=00000000-0000-4000-8000-0000000000dd&claim=00000000-0000-4000-8000-0000000000ee')
    render()
    expect(delivered).toHaveLength(0)
  })

  it('takes ids only: a link that names anything else opens nothing', () => {
    window.history.replaceState({}, '', '/account?action=../../settings&sequence=%3Cscript%3E')
    render()
    expect(delivered).toHaveLength(0)
  })

  it('nothing without a param', () => {
    render()
    expect(delivered).toHaveLength(0)
  })
})
