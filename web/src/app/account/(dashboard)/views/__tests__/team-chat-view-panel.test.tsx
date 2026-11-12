// @vitest-environment jsdom
/**
 * Team chat's card and its sub-nav beside the rail (Liam, 11-11: "make the
 * team-chat one look like this"; ../../page-panel/team-chat-panel.tsx). The
 * view in a card says what it has (team-chat-card-controls.ts): its
 * conversations as its own list titles them, the one on screen, and its
 * moves (open one, its own New channel and New message dialogs).
 *
 * Full screen from `md` up the sub-nav is its one list (Liam, 11-11: "did you
 * actually clean up the old one and remove it from the panel complely or did
 * you do something the lazy way?"): no list, no divider, no hidden panel in
 * its resizable group, from the first render. Inline, below `md` or with no
 * card, its list is as it was.
 *
 * And the cursor (Liam, 11-11: "when I hover over the teams panel my coursor
 * turns into the resize tool even if I'm not trying to resize"): the
 * library sets a document-wide `cursor` rule (an adopted stylesheet) over a
 * divider's hit region; a hidden panel left registered made that region run
 * from the window's left edge to the visible pane. Probed as in the browser:
 * a pointermove left of the visible pane leaves no cursor rule, while one on
 * a real divider between two panes still sets it. Fixtures are made up.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', useWorkspaceEdition: () => null }))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}), useOptionalRecordingStable: () => null }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/app/account/teams-context', () => ({
  useTeams: () => ({ teams: [{ id: 'team-eng', name: 'Engineering', is_private: true }, { id: 'team-design', name: 'Design', is_private: false }] }),
}))
vi.mock('@/lib/voice/assistant-name-store', () => ({ useAssistantName: () => ({ name: 'Joseph' }) }))
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: async () => ({ members: [{ id: 'm-me', display_name: 'Jordan Ellery' }, { id: 'm-rosa', display_name: 'Rosa Lind', avatar_url: null }] }) }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = { on: () => channel, subscribe: () => channel }
    return { channel: () => channel, removeChannel: async () => {} }
  },
}))

import { TeamChatView } from '../team-chat-view'
import { __resetTeamChatCardsForTests, teamChatCardFor } from '@/components/chat-cards/team-chat-card-controls'
import { RAIL_MEDIA } from '../../rail/rail-media'
import { __resetSubnavOnScreenForTests, setSubnavOnScreen } from '../../page-panel/subnav-on-screen'

const base = { topic: null, archived_at: null, unread: 0, mentions: 0, thread_unread: 0, thread_mentions: 0, notify: 'mentions' }
const CHANNELS = [
  { ...base, id: 'c-general', kind: 'channel', name: 'general', team_id: null, dm_member_id: null, last_message_at: '2026-11-09T10:00:00Z', unread: 2 },
  { ...base, id: 't-builds', kind: 'channel', name: 'builds', team_id: 'team-eng', dm_member_id: null, last_message_at: '2026-11-09T09:00:00Z' },
  { ...base, id: 'dm-rosa', kind: 'dm', name: null, team_id: null, dm_member_id: 'm-rosa', last_message_at: '2026-11-09T08:00:00Z' },
  { ...base, id: 'dm-me', kind: 'dm', name: null, team_id: null, dm_member_id: 'm-me', last_message_at: null },
  // Calling is off here: a meeting's conversation isn't listed, nor said.
  { ...base, id: 'meet-1', kind: 'meeting', name: 'Kickoff', team_id: null, dm_member_id: null, last_message_at: '2026-11-09T07:00:00Z' },
]

const CARD = 'card-team-chat'
let width = 1200
/** The window at `md` or wider (the rail, and the sub-nav beside it). */
let railShown = true
let container: HTMLDivElement
let root: Root

// The document's adopted stylesheets, where the library puts its cursor rule
// (jsdom has none of its own), and ARIA reflection for its count of panels.
beforeAll(() => {
  Object.defineProperty(document, 'adoptedStyleSheets', { configurable: true, value: [] })
  if (!('ariaDisabled' in Element.prototype)) {
    Object.defineProperty(Element.prototype, 'ariaDisabled', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('aria-disabled')
      },
    })
  }
})

beforeEach(() => {
  width = 1200
  railShown = true
  __resetTeamChatCardsForTests()
  __resetSubnavOnScreenForTests()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === RAIL_MEDIA ? railShown : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/account/team-chat/channels') return new Response(JSON.stringify({ channels: CHANNELS, memberId: 'm-me' }))
    if (/\/messages/.test(url)) return new Response(JSON.stringify({ messages: [] }))
    return new Response('{}')
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function render(props: { compact?: boolean; cardId?: string; onShowCard?: () => void } = { cardId: CARD }) {
  await act(async () => root.render(<TeamChatView {...props} />))
  await settle()
}
/** A fresh mount (its width is measured at mount: the test's ResizeObserver never fires). */
async function remount(props?: Parameters<typeof render>[0]) {
  act(() => root.unmount())
  root = createRoot(container)
  await render(props)
}

const panes = () => container.querySelector('[data-team-chat-panes]')?.getAttribute('data-team-chat-panes')
const aside = () => container.querySelector('aside')
const listPanel = () => aside()!.closest('[data-panel]')!
const handle = () => container.querySelector('[role="separator"]')
const panels = () => [...container.querySelectorAll('[data-panel]')].map((p) => p.id)

/**
 * Lay the group out as a browser would: the group 1200px wide; a hidden
 * panel a zero box at the window's corner (as Chromium reports one); the
 * list 0-300 and the conversation after it, or the conversation alone from
 * 400 (the rail and the sub-nav to its left); the divider at 300.
 */
function layOut() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.hasAttribute('hidden')) return new DOMRect(0, 0, 0, 0)
    if (this.hasAttribute('data-group')) return new DOMRect(0, 0, 1200, 800)
    if (this.id === 'team-chat-list') return new DOMRect(0, 0, 300, 800)
    if (this.getAttribute('role') === 'separator') return new DOMRect(300, 0, 1, 800)
    if (this.id === 'team-chat-channel') {
      const list = document.getElementById('team-chat-list')
      return list && !list.hasAttribute('hidden') ? new DOMRect(301, 0, 899, 800) : new DOMRect(400, 0, 800, 800)
    }
    return new DOMRect(0, 0, 0, 0)
  })
}

/** The pointer moves to (x, y): the document-wide cursor rules the library set then (the browser probe). */
function cursorRulesAt(x: number, y = 100): string[] {
  document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
  return document.adoptedStyleSheets.flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText)).filter((t) => t.includes('cursor'))
}

describe('team chat’s card, for its sub-nav', () => {
  it('says what it has: its conversations as its list titles them (no meetings with calling off), the one on screen', async () => {
    const shown: string[] = []
    await render({ cardId: CARD, onShowCard: () => shown.push('show') })
    const card = teamChatCardFor(CARD)!
    expect(card.cardId).toBe(CARD)
    expect(card.workspaceId).toBe('ws-1')
    expect(card.conversations.map((c) => [c.channel.id, c.title])).toEqual([
      ['c-general', 'general'],
      ['t-builds', 'builds'],
      ['dm-rosa', 'Rosa Lind'],
      ['dm-me', 'Jordan Ellery (you)'],
    ])
    const builds = card.conversations.find((c) => c.channel.id === 't-builds')!
    expect(builds.teamName).toBe('Engineering')
    expect(builds.privateTeam).toBe(true)
    expect(card.conversations.find((c) => c.channel.id === 'dm-rosa')!.person).toEqual({ name: 'Rosa Lind', url: null })
    expect(card.openId).toBe('c-general')
    card.show()
    expect(shown).toEqual(['show'])
  })

  it('opens a conversation the sub-nav picks, and says so', async () => {
    await render()
    await act(async () => teamChatCardFor(CARD)!.open('dm-rosa'))
    await settle()
    expect(teamChatCardFor(CARD)!.openId).toBe('dm-rosa')
    expect(container.querySelector('section')!.textContent).toContain('Rosa Lind')
  })

  it('opens its own dialogs, kept in the view with no list of its own: New channel (a team picked when asked), New message', async () => {
    await render()
    expect(aside()).toBeNull()
    await act(async () => teamChatCardFor(CARD)!.newChannel('team-eng'))
    await settle()
    expect(document.body.textContent).toContain('New channel')
    expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select')!.value).toBe('team-eng')
    await act(async () => {
      document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    await act(async () => teamChatCardFor(CARD)!.newChannel(null))
    await settle()
    expect(document.querySelector<HTMLSelectElement>('[role="dialog"] select')!.value).toBe('')
    await act(async () => {
      document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
    await act(async () => teamChatCardFor(CARD)!.newDm())
    await settle()
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('New message')
  })

  it('full screen from `md` up: no list, no divider, no list panel at all, from its first render; the conversation fills it', async () => {
    // The first commit, before anything settles: nothing to show then take away.
    await act(async () => root.render(<TeamChatView cardId={CARD} />))
    expect(aside()).toBeNull()
    expect(handle()).toBeNull()
    expect(panels()).toEqual(['team-chat-channel'])
    expect(panes()).toBe('channel')
    await settle()
    expect(aside()).toBeNull()
    expect(panels()).toEqual(['team-chat-channel'])
    // Narrower than two panes (a small window beside the rail and the sub-nav): still the conversation, no Back to a list.
    width = 390
    await remount()
    expect(panes()).toBe('channel')
    expect(aside()).toBeNull()
    expect(container.querySelector('[data-team-chat-back]')).toBeNull()
  })

  it('full screen without its sub-nav on screen (Liam, 11-11): a capture docked, the panel closed, another page’s: its own list again; undecided, none (no flash)', async () => {
    await render()
    expect(aside()).toBeNull()
    act(() => setSubnavOnScreen('team-chat'))
    await settle()
    expect(aside()).toBeNull()
    expect(panels()).toEqual(['team-chat-channel'])
    // None on screen (the notepad on the left, or closed by its button).
    act(() => setSubnavOnScreen(null))
    await settle()
    expect(aside()).not.toBeNull()
    expect(panes()).toBe('both')
    expect(handle()).not.toBeNull()
    // Another page's sub-nav (Recent beside it).
    act(() => setSubnavOnScreen('home'))
    await settle()
    expect(aside()).not.toBeNull()
    // Its own again: the list goes to the sub-nav.
    act(() => setSubnavOnScreen('team-chat'))
    await settle()
    expect(aside()).toBeNull()
    expect(panels()).toEqual(['team-chat-channel'])
  })

  it('keeps its list inline (not full screen), or with no card of its own', async () => {
    await render({ cardId: CARD, compact: true })
    expect(panes()).toBe('both')
    expect(listPanel().hasAttribute('hidden')).toBe(false)
    expect(handle()).not.toBeNull()
    await act(async () => root.render(<TeamChatView />))
    await settle()
    expect(teamChatCardFor(null)).toBeNull()
    expect(aside()).not.toBeNull()
  })

  it('below `md` (a phone: no rail, no sub-nav): its own list as before, two panes or one at a time', async () => {
    railShown = false
    width = 700
    await render()
    expect(panes()).toBe('both')
    expect(aside()).not.toBeNull()
    expect(handle()).not.toBeNull()
    width = 390
    await remount()
    expect(panes()).toBe('list')
    expect(listPanel().hasAttribute('hidden')).toBe(false)
  })

  it('says it at once on mount (Liam, 11-11: "it goes away completely and reappears"): mounted again, the conversations its workspace’s card last said, pending, before its own read answers; then its own', async () => {
    await render()
    expect(teamChatCardFor(CARD)!.pending).toBe(false)
    act(() => root.unmount())
    root = createRoot(container)
    expect(teamChatCardFor(CARD)).toBeNull()
    // Its read held: nothing answers yet.
    let answer: () => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/account/team-chat/channels') {
          await new Promise<void>((r) => {
            answer = r
          })
          return new Response(JSON.stringify({ channels: CHANNELS.slice(0, 1), memberId: 'm-me' }))
        }
        if (/\/messages/.test(url)) return new Response(JSON.stringify({ messages: [] }))
        return new Response('{}')
      }),
    )
    await act(async () => root.render(<TeamChatView cardId={CARD} />))
    const kept = teamChatCardFor(CARD)!
    expect(kept.pending).toBe(true)
    expect(kept.conversations.map((c) => c.channel.id)).toEqual(['c-general', 't-builds', 'dm-rosa', 'dm-me'])
    // Its moves are there already.
    await act(async () => kept.open('dm-rosa'))
    await act(async () => answer())
    await settle()
    const own = teamChatCardFor(CARD)!
    expect(own.pending).toBe(false)
    expect(own.conversations.map((c) => c.channel.id)).toEqual(['c-general'])
  })

  it('unmounted: says it is gone', async () => {
    await render()
    expect(teamChatCardFor(CARD)).not.toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    expect(teamChatCardFor(CARD)).toBeNull()
  })
})

describe('the resize cursor, only on a real divider', () => {
  it('full screen beside the sub-nav: a pointer over the rail or the sub-nav sets no resize cursor', async () => {
    await render()
    layOut()
    expect(cursorRulesAt(100)).toEqual([])
    expect(cursorRulesAt(350)).toEqual([])
  })

  it('one pane at a time (a phone): the hidden panel draws no resize region left of the visible one', async () => {
    railShown = false
    width = 390
    await render({ cardId: CARD, compact: true })
    // Open a channel: the list's panel hidden, the conversation's on screen.
    await act(async () => teamChatCardFor(CARD)!.open('dm-rosa'))
    await settle()
    expect(panes()).toBe('channel')
    expect(listPanel().hasAttribute('hidden')).toBe(true)
    layOut()
    expect(cursorRulesAt(100)).toEqual([])
  })

  it('two panes on screen: the divider between them still resizes (the cursor on it, none away from it)', async () => {
    railShown = false
    width = 700
    await render()
    layOut()
    expect(cursorRulesAt(300).length).toBe(1)
    expect(cursorRulesAt(800)).toEqual([])
  })
})
