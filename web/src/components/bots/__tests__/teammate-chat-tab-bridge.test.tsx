// @vitest-environment jsdom
/**
 * A bot's page opens as a card (P5): `openTeammateChatTab` (the bubble's
 * Open, the desktop overlay's Open in Dial8) asks the
 * dashboard, and TeammateChatTabBridge answers with a `bot` card for a
 * teammate the roster holds — on one of its items when asked. A teammate the
 * roster doesn't hold is left alone, so the caller falls back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/work/agent-work-provider', () => ({
  useAgentWorkShared: () => ({
    work: {
      roster: [
        { id: 'tm-ada', name: 'Ada' },
        { id: 'tm-agent', workspace_id: 'w1', name: 'Joseph', is_system: true, system_key: 'assistant' },
        { id: 'tm-mail', workspace_id: 'w1', name: 'Mail', is_system: true, system_key: 'mail' },
      ],
    },
  }),
}))

import { TeammateChatTabBridge } from '../../bots/teammate-chat-tab-bridge'
import { openTeammateChatTab } from '@/lib/bots/teammate-chat-tab'

const ITEM = '0b8f6a52-3c1d-4e2f-9a7b-1c2d3e4f5a6b'

let container: HTMLDivElement
let root: Root
let opened: OpenCardRequest[] = []
const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenCardRequest>).detail)

beforeEach(() => {
  opened = []
  window.addEventListener(OPEN_CARD_EVENT, onOpen)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(h(TeammateChatTabBridge, null)))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.removeEventListener(OPEN_CARD_EVENT, onOpen)
})

describe('a bot’s page opens as a card', () => {
  it('a teammate the roster holds: a bot card, and the caller is told it opened', () => {
    expect(openTeammateChatTab('tm-ada')).toBe(true)
    expect(opened).toHaveLength(1)
    // reuse: the bot's page already in the chat comes back rather than a second card.
    expect(opened[0]).toMatchObject({ from: 'bot', reuse: true, spec: { kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'tm-ada' } } })
    expect(opened[0].seed).toBeUndefined()
  })

  it('on one of its items: the card lands on the item', () => {
    expect(openTeammateChatTab('tm-ada', { itemId: ITEM, title: '  Draft the brief  ' })).toBe(true)
    expect(opened[0].seed).toMatchObject({ at: { type: 'work_item', id: ITEM, label: 'Draft the brief' } })
  })

  it('an id that is not a work item’s opens the bot’s own page', () => {
    expect(openTeammateChatTab('tm-ada', { itemId: 'not-an-id', title: 'x' })).toBe(true)
    expect(opened[0].seed).toBeUndefined()
  })

  it('one face: an area face’s page is the agent’s (its workspace’s Assistant), on the item when asked', () => {
    expect(openTeammateChatTab('tm-mail', { itemId: ITEM, title: 'Two replies' })).toBe(true)
    expect(opened[0]).toMatchObject({ spec: { kind: 'bot', title: 'Joseph', target: { type: 'bot', id: 'tm-agent' } } })
    expect(opened[0].seed).toMatchObject({ at: { type: 'work_item', id: ITEM } })
  })

  it('a teammate the roster does not hold is left alone: nothing opens, the caller falls back', () => {
    expect(openTeammateChatTab('tm-gone')).toBe(false)
    expect(opened).toHaveLength(0)
  })
})
