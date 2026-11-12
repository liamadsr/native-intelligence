// @vitest-environment jsdom
/**
 * Team chat's panel: its sub-nav (team-chat-panel.tsx; Liam, 11-11: "make
 * the team-chat one look like this"). Registered for `team-chat`: it holds
 * the slot while the Team chat page's own card is in front, once that card
 * says what it has (team-chat-card-controls.ts). All | Recent at the top
 * (remembered); Favorites, Team channels, Channels, DMs, Meetings, each only
 * with rows; favorites per device, never listed twice; each sorted section's
 * order remembered; + opens the card's own dialogs; rows bold while unread,
 * their mentions, the open one lit from the card. Fixtures are made up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useSyncExternalStore } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-home' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/account' }))
vi.mock('@/app/account/workspace-switcher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/account/workspace-switcher')>()),
  useWorkspaceId: () => 'ws-1',
}))
vi.mock('../../side-panels/side-panels', async () => {
  const store = await import('../../side-panels/side-panel-store')
  return {
    PANEL_TOP: '6px',
    SLIDE_CLASS: 'transition-[translate,visibility]',
    SLIDE_STYLE: {},
    useComposerReserve: () => 0,
    useSidePanelState: () => useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState),
  }
})

import { PAGE_PANELS, PagePanelHost, pageKeyOf } from '../page-panel'
import { TeamChatPanel } from '../team-chat-panel'
import { TEAM_CHAT_MODE_KEY, TEAM_CHAT_SORT_KEY, __resetTeamChatPanelPrefsForTests, teamChatFavoritesKey } from '../team-chat-panel-prefs'
import * as store from '../../side-panels/side-panel-store'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import {
  __resetTeamChatCardsForTests,
  publishTeamChatCard,
  unpublishTeamChatCard,
  type TeamChatCardControls,
  type TeamChatPanelConversation,
} from '@/components/chat-cards/team-chat-card-controls'
import type { TeamChatChannel } from '@/lib/team-chat/types'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { KEEP_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace } from '../../rail/selected-place'

const CARD = 'card-team-chat-page'
const chatSpec = () => CARD_PAGES.find((p) => p.slug === 'team-chat')!.spec(new Date()) as CardSpec

function conv(id: string, title: string, over: Partial<TeamChatChannel> = {}, extra: Partial<TeamChatPanelConversation> = {}): TeamChatPanelConversation {
  return {
    channel: {
      id,
      kind: 'channel',
      name: title,
      topic: null,
      team_id: null,
      dm_member_id: null,
      last_message_at: null,
      archived_at: null,
      unread: 0,
      mentions: 0,
      thread_unread: 0,
      thread_mentions: 0,
      notify: 'mentions',
      ...over,
    },
    title,
    teamName: null,
    privateTeam: false,
    person: null,
    ...extra,
  }
}

// In the server's order (latest activity first), as the card publishes it.
const CONVERSATIONS: TeamChatPanelConversation[] = [
  conv('c-general', 'general', { last_message_at: '2026-11-10T12:00:00Z', unread: 3 }),
  conv('dm-rosa', 'Rosa Lind', { kind: 'dm', name: null, dm_member_id: 'm-rosa', last_message_at: '2026-11-10T11:00:00Z', mentions: 1, unread: 1 }, { person: { name: 'Rosa Lind', url: null } }),
  conv('t-design-standup', 'standup', { team_id: 'team-design', last_message_at: '2026-11-10T10:00:00Z' }, { teamName: 'Design' }),
  conv('c-announcements', 'announcements', { last_message_at: '2026-11-09T09:00:00Z', notify: 'muted' }),
  conv('t-eng-standup', 'standup', { team_id: 'team-eng', last_message_at: '2026-11-08T09:00:00Z' }, { teamName: 'Engineering', privateTeam: true }),
  conv('t-eng-builds', 'builds', { team_id: 'team-eng', last_message_at: '2026-11-07T09:00:00Z' }, { teamName: 'Engineering' }),
  conv('dm-me', 'Jordan Ellery (you)', { kind: 'dm', name: null, dm_member_id: 'm-me', last_message_at: null }, { person: { name: 'Jordan Ellery', url: null } }),
  conv('meet-kickoff', 'Kickoff with Northwind', { kind: 'meeting', last_message_at: '2026-11-06T09:00:00Z' }),
]

let container: HTMLDivElement
let root: Root
let releases: Array<() => void> = []
const calls: string[] = []

function controls(over: Partial<TeamChatCardControls> = {}): TeamChatCardControls {
  return {
    cardId: CARD,
    workspaceId: 'ws-1',
    conversations: CONVERSATIONS,
    openId: 'c-general',
    open: (id) => calls.push(`open:${id}`),
    newChannel: (team) => calls.push(`new-channel:${team ?? 'workspace'}`),
    newDm: () => calls.push('new-dm'),
    newMeeting: () => calls.push('new-meeting'),
    show: () => calls.push('show'),
    ...over,
  }
}

beforeEach(() => {
  calls.length = 0
  releases = []
  window.localStorage.clear()
  __resetTeamChatPanelPrefsForTests()
  __resetSelectedPlaceForTests()
  __resetTeamChatCardsForTests()
  store.resetSidePanelStore()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ entries: [], next_cursor: null }) }) as Response))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  for (const release of releases) act(() => release())
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {})
}

function Row() {
  const state = useSyncExternalStore(store.subscribeSidePanels, store.getSidePanelState, store.getServerSidePanelState)
  return <PagePanelHost mode={store.pagePanelWanted(state) ? 'room' : 'off'} />
}

async function openChatPage(id = CARD) {
  act(() => {
    releases.push(holdFrontCard({ id, spec: chatSpec(), close: () => {} }))
  })
  await flush()
}

async function showPanel(over: Partial<TeamChatCardControls> = {}) {
  act(() => root.render(<Row />))
  await openChatPage()
  act(() => publishTeamChatCard(controls(over)))
  await flush()
}

const panel = () => container.querySelector<HTMLElement>('aside[data-page-panel="team-chat"]')
const sections = () => [...container.querySelectorAll('[data-team-chat-section]')].map((s) => s.getAttribute('data-team-chat-section'))
const headings = () => [...container.querySelectorAll('[data-team-chat-section] h3')].map((h) => h.textContent)
const idsIn = (section: string) =>
  [...container.querySelectorAll(`[data-team-chat-section="${section}"] [data-team-chat-panel-row]`)].map((r) => r.getAttribute('data-team-chat-panel-row'))
const row = (id: string) => container.querySelector<HTMLButtonElement>(`[data-team-chat-panel-row="${id}"]`)!
const star = (id: string) => container.querySelector<HTMLButtonElement>(`[data-team-chat-star="${id}"]`)!
const lit = () => [...container.querySelectorAll('[data-team-chat-panel-row][aria-current="true"]')].map((r) => r.getAttribute('data-team-chat-panel-row'))
const mode = (id: 'all' | 'recent') => container.querySelector<HTMLButtonElement>(`[data-team-chat-mode-option="${id}"]`)!
const sortOf = (section: string) => container.querySelector<HTMLButtonElement>(`[data-team-chat-sort="${section}"]`)
const addOf = (section: string) => container.querySelector<HTMLButtonElement>(`[data-team-chat-add="${section}"]`)

describe('the Team chat sub-nav', () => {
  it('is Team chat’s registered panel', () => {
    expect(PAGE_PANELS['team-chat']).toBe(TeamChatPanel)
    expect(pageKeyOf('team-chat')).toBe('team-chat')
  })

  it('holds the slot on the Team chat page from its first commit, before its card says anything: the switch and the headings; then the sections', async () => {
    act(() => root.render(<Row />))
    await openChatPage()
    expect(selectedPlace()).toBe('team-chat')
    // No card has said what it has yet (Liam, 11-11: "it goes away completely and reappears"): the switch,
    // Channels and DMs with their +, nothing lit; room asked.
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(store.getSidePanelState()).toMatchObject({ pagePanel: true, pagePanelPage: true })
    expect(mode('all')).not.toBeNull()
    expect(headings()).toEqual(['Channels', 'DMs'])
    expect(addOf('channels')).not.toBeNull()
    expect(lit()).toEqual([])
    act(() => publishTeamChatCard(controls()))
    await flush()
    expect(panel()!.getAttribute('aria-label')).toBe('Team chat')
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('room')
    expect(mode('all').getAttribute('aria-checked')).toBe('true')
    // No favorites yet: no Favorites section.
    expect(sections()).toEqual(['team', 'channels', 'dms', 'meetings'])
    expect(headings()).toEqual(['Team channels', 'Channels', 'DMs', 'Meetings'])
    // Team vs the whole workspace's, DMs, meetings; latest activity first by default.
    expect(idsIn('team')).toEqual(['t-design-standup', 't-eng-standup', 't-eng-builds'])
    expect(idsIn('channels')).toEqual(['c-general', 'c-announcements'])
    expect(idsIn('dms')).toEqual(['dm-rosa', 'dm-me'])
    expect(idsIn('meetings')).toEqual(['meet-kickoff'])
    // A press in it keeps the page selected; it is the page's one list (pinned: shown while open, room or not).
    expect(row('c-general').closest(`[${KEEP_PLACE_ATTR}]`)).not.toBeNull()
    expect(store.getSidePanelState().pagePanelPage).toBe(true)
  })

  it('names the team only where two team channels would read the same; a DM wears its person’s initials', async () => {
    await showPanel()
    const hint = (id: string) => row(id).querySelector('[data-team-chat-hint]')?.textContent ?? null
    expect(hint('t-design-standup')).toBe('Design')
    expect(hint('t-eng-standup')).toBe('Engineering')
    expect(hint('t-eng-builds')).toBeNull()
    expect(row('dm-rosa').querySelector('[data-team-chat-avatar]')!.textContent).toBe('RL')
    expect(row('dm-me').textContent).toContain('Jordan Ellery (you)')
  })

  it('Channels and DMs always show (their + starts the first one), Meetings whenever calling is on; empty Favorites and Team channels don’t', async () => {
    // Liam, 11-11: "when you have no direct messages the + section for direct messages doesn't show up", "also the meeting + isn't showing either".
    const workspaceChannels = CONVERSATIONS.filter((c) => c.channel.kind === 'channel' && !c.channel.team_id)
    await showPanel({ conversations: workspaceChannels })
    expect(sections()).toEqual(['channels', 'dms', 'meetings'])
    expect(addOf('dms')!.getAttribute('aria-label')).toBe('New message')
    expect(addOf('meetings')!.getAttribute('aria-label')).toBe('New meeting link')
    // Nothing to sort in an empty section: its "+" only.
    expect(container.querySelector('[data-team-chat-sort="dms"]')).toBeNull()
    addOf('dms')!.click()
    addOf('meetings')!.click()
    expect(calls).toEqual(['new-dm', 'new-meeting'])
    // Calling off: no Meetings section at all (the page lists none).
    act(() => publishTeamChatCard(controls({ conversations: workspaceChannels, newMeeting: null })))
    await flush()
    expect(sections()).toEqual(['channels', 'dms'])
  })

  it('rows: bold while unread, its mentions, a muted one’s bell; the open one lit from the card, never from the click', async () => {
    await showPanel()
    expect(lit()).toEqual(['c-general'])
    // The open one shows no unread.
    expect(row('c-general').hasAttribute('data-unread')).toBe(false)
    expect(row('dm-rosa').hasAttribute('data-unread')).toBe(true)
    expect(row('dm-rosa').querySelector('[data-team-chat-title]')!.className).toContain('font-semibold')
    expect(row('dm-rosa').querySelector('[data-team-chat-mentions]')!.textContent).toBe('@1')
    expect(row('c-announcements').querySelector('[data-team-chat-muted]')).not.toBeNull()
    row('dm-rosa').click()
    expect(calls).toEqual(['open:dm-rosa'])
    expect(lit()).toEqual(['c-general'])
    act(() => publishTeamChatCard(controls({ openId: 'dm-rosa' })))
    await flush()
    expect(lit()).toEqual(['dm-rosa'])
    expect(row('c-general').querySelector('[data-team-chat-count]')!.textContent).toContain('3')
    // The one already open, in front: nothing more.
    row('dm-rosa').click()
    expect(calls).toEqual(['open:dm-rosa'])
  })

  it('a record over the page in front: a row puts the page’s card back first', async () => {
    await showPanel()
    act(() => {
      releases.push(holdFrontCard({ id: 'card-other', spec: chatSpec(), close: () => {} }))
    })
    await flush()
    row('c-announcements').click()
    expect(calls).toEqual(['show', 'open:c-announcements'])
  })

  it('All | Recent: Recent is every conversation, latest first, remembered on this device', async () => {
    await showPanel()
    await act(async () => mode('recent').click())
    expect(sections()).toEqual(['recent'])
    expect(idsIn('recent')).toEqual([
      'c-general', 'dm-rosa', 't-design-standup', 'c-announcements', 't-eng-standup', 't-eng-builds', 'meet-kickoff', 'dm-me',
    ])
    expect(container.querySelector('[data-team-chat-section] h3')).toBeNull()
    expect(window.localStorage.getItem(TEAM_CHAT_MODE_KEY)).toBe('recent')
    // Arrow keys move the switch, as a radio group's.
    await act(async () => {
      mode('recent').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(sections()).toEqual(['team', 'channels', 'dms', 'meetings'])
    expect(window.localStorage.getItem(TEAM_CHAT_MODE_KEY)).toBe('all')
  })

  it('opens on Recent when this device last picked it', async () => {
    window.localStorage.setItem(TEAM_CHAT_MODE_KEY, 'recent')
    await showPanel()
    expect(mode('recent').getAttribute('aria-checked')).toBe('true')
    expect(sections()).toEqual(['recent'])
  })

  it('favorites: starred by the row’s star or its menu, kept per device and workspace, listed once, unstarred again', async () => {
    await showPanel()
    expect(star('dm-rosa').getAttribute('aria-label')).toBe('Add Rosa Lind to favorites')
    await act(async () => star('dm-rosa').click())
    await act(async () => star('t-eng-builds').click())
    expect(sections()).toEqual(['favorites', 'team', 'channels', 'dms', 'meetings'])
    expect(headings()[0]).toBe('Favorites')
    // In the order starred, and not again in their own sections.
    expect(idsIn('favorites')).toEqual(['dm-rosa', 't-eng-builds'])
    expect(idsIn('dms')).toEqual(['dm-me'])
    expect(idsIn('team')).toEqual(['t-design-standup', 't-eng-standup'])
    expect(JSON.parse(window.localStorage.getItem(teamChatFavoritesKey('ws-1'))!)).toEqual(['dm-rosa', 't-eng-builds'])
    expect(window.localStorage.getItem(teamChatFavoritesKey('ws-other'))).toBeNull()
    expect(star('dm-rosa').getAttribute('aria-label')).toBe('Remove Rosa Lind from favorites')
    // The right-click menu says the same, and takes it out.
    await act(async () => {
      row('dm-rosa').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    await flush()
    const item = document.querySelector<HTMLElement>('[data-team-chat-menu-item="favorite"]')!
    expect(item.textContent).toBe('Remove from favorites')
    await act(async () => item.click())
    await flush()
    expect(idsIn('favorites')).toEqual(['t-eng-builds'])
    expect(idsIn('dms')).toEqual(['dm-rosa', 'dm-me'])
    await act(async () => star('t-eng-builds').click())
    expect(sections()).toEqual(['team', 'channels', 'dms', 'meetings'])
  })

  it('reads favorites this device kept for the workspace; one no longer listed is skipped', async () => {
    window.localStorage.setItem(teamChatFavoritesKey('ws-1'), JSON.stringify(['c-gone', 'c-announcements']))
    await showPanel()
    expect(idsIn('favorites')).toEqual(['c-announcements'])
    expect(idsIn('channels')).toEqual(['c-general'])
  })

  it('sort: each section toggles recent ↔ A–Z on its own, says its order, and is remembered', async () => {
    await showPanel()
    expect(sortOf('team')!.getAttribute('aria-label')).toContain('sorted by recent activity')
    await act(async () => sortOf('channels')!.click())
    expect(idsIn('channels')).toEqual(['c-announcements', 'c-general'])
    expect(sortOf('channels')!.getAttribute('aria-label')).toContain('sorted by name, A–Z')
    // The others keep theirs.
    expect(idsIn('dms')).toEqual(['dm-rosa', 'dm-me'])
    await act(async () => sortOf('dms')!.click())
    expect(idsIn('dms')).toEqual(['dm-me', 'dm-rosa'])
    expect(JSON.parse(window.localStorage.getItem(TEAM_CHAT_SORT_KEY)!)).toEqual({ team: 'recent', channels: 'az', dms: 'az' })
    // No order of its own for Favorites or Meetings.
    expect(sortOf('meetings')).toBeNull()
    await act(async () => sortOf('channels')!.click())
    expect(idsIn('channels')).toEqual(['c-general', 'c-announcements'])
  })

  it('+ opens the card’s own dialogs: New channel (Team channels’ with a team), New message, New meeting link; none on Favorites', async () => {
    window.localStorage.setItem(teamChatFavoritesKey('ws-1'), JSON.stringify(['c-general']))
    await showPanel({ openId: 't-eng-builds' })
    addOf('channels')!.click()
    addOf('dms')!.click()
    // Team channels': the open conversation's team.
    addOf('team')!.click()
    addOf('meetings')!.click()
    expect(calls).toEqual(['new-channel:workspace', 'new-dm', 'new-channel:team-eng', 'new-meeting'])
    expect(addOf('team')!.getAttribute('aria-label')).toBe('New channel')
    expect(addOf('dms')!.getAttribute('aria-label')).toBe('New message')
    expect(addOf('meetings')!.getAttribute('aria-label')).toBe('New meeting link')
    expect(addOf('favorites')).toBeNull()
  })

  it('a visit again: the conversations its card last said, at once, before a card is back (kept for the workspace); Meetings as it was', async () => {
    await showPanel()
    // The card goes (it fell out of the pages kept mounted) and the page is left.
    act(() => unpublishTeamChatCard(CARD))
    act(() => releases.pop()!())
    await flush()
    // Back: no card has said anything yet, and no fetch has answered.
    await openChatPage()
    expect(idsIn('channels')).toEqual(['c-general', 'c-announcements'])
    expect(idsIn('dms')).toEqual(['dm-rosa', 'dm-me'])
    expect(headings()).toEqual(['Team channels', 'Channels', 'DMs', 'Meetings'])
    expect(lit()).toEqual([])
    // Another workspace's kept list is never shown here.
    __resetTeamChatCardsForTests()
    act(() => publishTeamChatCard(controls({ cardId: 'card-other', workspaceId: 'ws-2' })))
    act(() => unpublishTeamChatCard('card-other'))
    await flush()
    expect(idsIn('channels')).toEqual([])
  })

  it('a row or a + pressed before the card says anything: waits, then moves the card once it does', async () => {
    await showPanel()
    act(() => unpublishTeamChatCard(CARD))
    await flush()
    act(() => row('dm-rosa').click())
    expect(calls).toEqual([])
    act(() => publishTeamChatCard(controls({ pending: true })))
    await flush()
    expect(calls).toEqual(['open:dm-rosa'])
    calls.length = 0
    act(() => unpublishTeamChatCard(CARD))
    await flush()
    addOf('dms')!.click()
    expect(calls).toEqual([])
    act(() => publishTeamChatCard(controls()))
    await flush()
    expect(calls).toEqual(['new-dm'])
  })

  it('closed by its button: off (the card has no list of its own until it is opened again)', async () => {
    await showPanel()
    expect(store.getSidePanelState().pagePanelShown).toBe(true)
    act(() => store.setPagePanelOpen(false))
    await flush()
    expect(panel()!.getAttribute('data-page-panel-mode')).toBe('off')
    expect(store.getSidePanelState().pagePanelShown).toBe(false)
  })
})
