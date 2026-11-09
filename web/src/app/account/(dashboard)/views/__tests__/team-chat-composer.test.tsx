// @vitest-environment jsdom
/**
 * Team chat's box (../team-chat-view.tsx) is the main chat's composer
 * (ChatInput) with its own `@` list: the person's agent, then the members but
 * them. What it posts: the members picked whose "@Name" is still in the words
 * (`mentions`), and whether the agent is called (`mentionsAgent`: "@Joseph"
 * in the words, picked or typed). A send that fails keeps the words and says
 * so; an archived channel has no box, only why. Text only: + says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', useWorkspaceEdition: () => null }))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/voice/assistant-name-store', () => ({ useAssistantName: () => ({ name: 'Joseph' }) }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async () => ({
    members: [
      { id: 'm-me', display_name: 'Jordan Ellery' },
      { id: 'm-rosa', display_name: 'Rosa Lind' },
      { id: 'm-joe', display_name: 'Joseph Lee' },
    ],
  }),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = { on: () => channel, subscribe: () => channel }
    return { channel: () => channel, removeChannel: async () => {} }
  },
}))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}) }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))

import { TEAM_CHAT_TWO_PANE_MIN_PX, TeamChatView } from '../team-chat-view'

const channel = (over: Record<string, unknown> = {}) => ({
  id: 'c-general',
  kind: 'channel',
  name: 'general',
  topic: null,
  team_id: null,
  dm_member_id: null,
  last_message_at: null,
  archived_at: null,
  unread: 0,
  mentions: 0,
  ...over,
})

let posts: Array<{ body: string; mentions: string[]; mentionsAgent: boolean }> = []
let postStatus = 200
let channels: unknown[] = [channel()]
let container: HTMLDivElement
let root: Root
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  posts = []
  postStatus = 200
  channels = [channel()]
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/team-chat/channels') return new Response(JSON.stringify({ channels, memberId: 'm-me' }))
    if (/channels\/c-general\/messages$/.test(url) && init?.method === 'POST') {
      const sent = JSON.parse(String(init.body)) as { body: string; mentions: string[]; mentionsAgent: boolean }
      posts.push(sent)
      if (postStatus !== 200) return new Response('{}', { status: postStatus })
      const message = {
        id: `msg-${posts.length}`,
        channel_id: 'c-general',
        author_kind: 'member',
        author_member_id: 'm-me',
        agent_for_member_id: null,
        agent_name: null,
        in_reply_to: null,
        body: sent.body,
        mentions: sent.mentions,
        // The server's own read: the flag, or "@Joseph" in the words.
        mentions_agent: sent.mentionsAgent || /(^|\s)@Joseph(?! Lee)\b/.test(sent.body),
        created_at: '2026-11-09T10:00:00Z',
        edited_at: null,
        deleted_at: null,
      }
      return new Response(JSON.stringify({ message }))
    }
    if (/\/messages/.test(url)) return new Response(JSON.stringify({ messages: [] }))
    return new Response('{}')
  })
  vi.stubGlobal('fetch', fetchSpy)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => TEAM_CHAT_TWO_PANE_MIN_PX })
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

async function settle(ms = 0) {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, ms)))
}
async function render() {
  await act(async () => root.render(<TeamChatView />))
  await settle()
}
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
const box = () => container.querySelector('[data-team-chat-composer] textarea') as HTMLTextAreaElement
function type(text: string) {
  act(() => box().focus())
  for (const ch of text) {
    act(() => {
      const ta = box()
      const { selectionStart: s, selectionEnd: e, value } = ta
      setter.call(ta, value.slice(0, s) + ch + value.slice(e))
      ta.setSelectionRange(s + 1, s + 1)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}
function press(key: string, opts: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  act(() => {
    box().dispatchEvent(event)
  })
  return event
}
const optionIds = () => [...document.querySelectorAll('[data-mention-option]')].map((r) => r.getAttribute('data-mention-option'))

describe("team chat's box is the main composer", () => {
  it('shows "Message #channel", the agent and the members but me on @, and runs no record search', async () => {
    await render()
    expect(box().getAttribute('placeholder')).toBe('Message #general')
    type('@')
    await settle()
    expect(optionIds()).toEqual(['__agent__', 'm-rosa', 'm-joe'])
    expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith('/api/account/search'))).toBe(false)
    expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith('/api/account/skills'))).toBe(false)
  })

  it('a member picked: their id in mentions, the agent not called, the box cleared', async () => {
    await render()
    type('@ro')
    await settle()
    press('Enter')
    await settle()
    expect(box().value).toBe('@Rosa Lind ')
    type('can you look?')
    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: '@Rosa Lind can you look?', mentions: ['m-rosa'], mentionsAgent: false }])
    expect(box().value).toBe('')
    expect(container.textContent).not.toContain('Joseph is looking into it')
  })

  it('the agent picked: mentionsAgent, no member mention, and the "looking into it" line', async () => {
    await render()
    type('@jo')
    await settle()
    expect(optionIds()).toEqual(['__agent__', 'm-joe'])
    press('Enter')
    await settle()
    type('summarise this')
    press('Enter')
    await settle()
    expect(posts).toEqual([{ body: '@Joseph summarise this', mentions: [], mentionsAgent: true }])
    expect(container.textContent).toContain('Joseph is looking into it')
  })

  it('"@Joseph" typed by hand calls the agent; "@Joseph Lee" picked is the teammate, not the agent', async () => {
    await render()
    type('@Joseph what changed?')
    press('Enter')
    await settle()
    expect(posts[0]).toEqual({ body: '@Joseph what changed?', mentions: [], mentionsAgent: true })
    type('@joseph l')
    await settle()
    expect(optionIds()).toEqual(['m-joe'])
    press('Enter')
    await settle()
    type('thanks')
    press('Enter')
    await settle()
    expect(posts[1]).toEqual({ body: '@Joseph Lee thanks', mentions: ['m-joe'], mentionsAgent: false })
  })

  it('Shift+Enter is a new line, not a send', async () => {
    await render()
    type('one')
    const e = press('Enter', { shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(posts).toEqual([])
  })

  it('a failed send keeps the words and says so', async () => {
    postStatus = 500
    await render()
    type('hello')
    press('Enter')
    await settle()
    expect(posts).toHaveLength(1)
    expect(box().value).toBe('hello')
    expect(container.textContent).toContain("That didn't send. Try again.")
  })

  it('text only: + says why there are no files', async () => {
    await render()
    act(() => container.querySelector<HTMLButtonElement>('[data-team-chat-composer] button[aria-label="Add"]')!.click())
    await settle()
    expect(document.querySelector('[data-composer-unavailable="files"]')?.textContent).toContain('text only')
  })

  it('an archived channel has no box, only why', async () => {
    channels = [channel({ archived_at: '2026-11-09T11:00:00Z' })]
    await render()
    expect(container.textContent).toContain('This channel is archived.')
    expect(container.querySelector('[data-team-chat-composer]')).toBeNull()
  })
})
