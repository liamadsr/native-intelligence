// @vitest-environment jsdom
/**
 * Team chat's panes (../team-chat-view.tsx): side by side where there is room,
 * one at a time where there isn't (a phone, where the two squeezed the
 * messages into a column one word wide). Narrow, the list comes first, with
 * its unread counts; the channel picked for the person isn't marked read until
 * they open it; opened, it takes the view, with Back to the list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/voice/assistant-name-store', () => ({ useAssistantName: () => ({ name: 'Joseph' }) }))
vi.mock('@/lib/cached-fetch', () => ({ cachedJson: async () => ({ members: [{ id: 'm-me', display_name: 'Jordan Ellery' }, { id: 'm-rosa', display_name: 'Rosa Lind' }] }) }))
// The realtime channel: its handlers kept by table, so a test can send what the database would.
const realtime = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>() }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = {
      on: (_event: string, filter: { table: string }, cb: (payload: unknown) => void) => {
        realtime.handlers.set(filter.table, cb)
        return channel
      },
      subscribe: () => channel,
    }
    return { channel: () => channel, removeChannel: async () => {} }
  },
}))

import { TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX, TEAM_CHAT_TWO_PANE_MIN_PX, TeamChatView } from '../team-chat-view'

const CHANNELS = [
  { id: 'c-general', kind: 'channel', name: 'general', topic: null, team_id: null, dm_member_id: null, last_message_at: '2026-11-09T10:00:00Z', archived_at: null, unread: 2, mentions: 0 },
  { id: 'c-launch', kind: 'channel', name: 'launch', topic: null, team_id: null, dm_member_id: null, last_message_at: '2026-11-09T09:00:00Z', archived_at: null, unread: 1, mentions: 0 },
]
const MESSAGES = [
  { id: 'msg-1', channel_id: 'c-general', author_kind: 'member', author_member_id: 'm-rosa', agent_for_member_id: null, agent_name: null, in_reply_to: null, body: 'The kickoff moved to Thursday.', mentions: [], mentions_agent: false, created_at: '2026-11-09T10:00:00Z', edited_at: null, deleted_at: null },
]

let reads: string[] = []
let width = 390
let channelsList: unknown[] = CHANNELS
let channelsStatus = 200
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  reads = []
  channelsList = CHANNELS
  channelsStatus = 200
  realtime.handlers.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/team-chat/channels') {
      return channelsStatus === 200 ? new Response(JSON.stringify({ channels: channelsList, memberId: 'm-me' })) : new Response('{}', { status: channelsStatus })
    }
    const read = url.match(/channels\/([^/]+)\/read$/)
    if (read && init?.method === 'POST') {
      reads.push(read[1])
      return new Response('{}')
    }
    if (/\/messages/.test(url)) return new Response(JSON.stringify({ messages: url.includes('c-general') ? MESSAGES : [] }))
    return new Response('{}')
  }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})

async function render(props: { compact?: boolean } = {}) {
  await act(async () => root.render(<TeamChatView {...props} />))
  await settle()
}
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const panes = () => container.querySelector('[data-team-chat-panes]')?.getAttribute('data-team-chat-panes')
const aside = () => container.querySelector('aside')!
const section = () => container.querySelector('section')!
const row = (name: string) => [...container.querySelectorAll('aside button')].find((b) => b.textContent?.includes(name)) as HTMLButtonElement
const back = () => container.querySelector<HTMLButtonElement>('[data-team-chat-back]')

describe('team chat on a phone (narrower than two panes)', () => {
  beforeEach(() => {
    width = 390
  })

  it('shows the list alone first, its unread counts intact, and marks nothing read', async () => {
    await render()
    expect(panes()).toBe('list')
    expect(aside().className).toContain('w-full')
    expect(section().className).toContain('hidden')
    // The first channel is picked for the person, but it isn't on screen: still unread, not lit.
    expect(row('general').textContent).toContain('2')
    expect(reads).toEqual([])
  })

  it('opens the channel picked full width, reads it, and Back goes to the list', async () => {
    await render()
    await act(async () => row('general').click())
    expect(panes()).toBe('channel')
    expect(aside().className).toContain('hidden')
    expect(section().className).not.toContain('hidden')
    expect(container.textContent).toContain('The kickoff moved to Thursday.')
    expect(reads).toEqual(['c-general'])
    await act(async () => back()!.click())
    expect(panes()).toBe('list')
    expect(section().className).toContain('hidden')
  })

  it('mounts the channel only once it is on screen (so it opens at its newest message), with the focus on Back', async () => {
    await render()
    // Picked for the person but not on screen: nothing of it is drawn yet.
    expect(container.textContent).not.toContain('The kickoff moved to Thursday.')
    await act(async () => row('general').click())
    expect(document.activeElement).toBe(back())
  })

  it('a live message in a channel while the list shows refreshes the counts and marks nothing read', async () => {
    await render()
    const send = realtime.handlers.get('team_chat_message')!
    await act(async () => send({ eventType: 'INSERT', new: { ...MESSAGES[0], id: 'msg-2' } }))
    expect(reads).toEqual([])
  })

  it('goes back to the list when the open channel is archived, never an empty pane with no way back', async () => {
    await render()
    await act(async () => row('general').click())
    expect(panes()).toBe('channel')
    channelsList = []
    await act(async () => realtime.handlers.get('team_chat_channel')!({ eventType: 'UPDATE', new: { id: 'c-general', archived_at: '2026-11-09T11:00:00Z' } }))
    expect(panes()).toBe('list')
    await act(async () => new Promise((r) => setTimeout(r, 450)))
    await settle()
    expect(panes()).toBe('list')
    expect(container.textContent).toContain('Start your first channel')
  })

  it('says so in the list when the channels could not be loaded', async () => {
    channelsStatus = 500
    await render()
    expect(aside().textContent).toContain('Could not load team chat')
  })
})

describe('the inline card (compact): its list is narrower, so two panes hold down to a narrower width', () => {
  it('two panes at the compact threshold, one below it', async () => {
    width = TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX
    await render({ compact: true })
    expect(panes()).toBe('both')
    expect(aside().className).toContain('w-44')
    act(() => root.unmount())
    root = createRoot(container)
    width = TEAM_CHAT_TWO_PANE_MIN_COMPACT_PX - 1
    await render({ compact: true })
    expect(panes()).toBe('list')
  })
})

describe('team chat with room for two panes', () => {
  beforeEach(() => {
    width = TEAM_CHAT_TWO_PANE_MIN_PX
  })

  it('shows the list and the first channel side by side, reads it, and has no Back', async () => {
    await render()
    expect(panes()).toBe('both')
    expect(aside().className).toContain('w-60')
    expect(section().className).not.toContain('hidden')
    expect(container.textContent).toContain('The kickoff moved to Thursday.')
    expect(reads).toEqual(['c-general'])
    expect(back()).toBeNull()
  })

  it('keeps two panes where nothing can be measured (as before)', async () => {
    width = 0
    await render()
    expect(panes()).toBe('both')
  })
})
