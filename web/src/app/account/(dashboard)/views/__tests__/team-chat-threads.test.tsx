// @vitest-environment jsdom
/**
 * Team chat's threads, reactions and typing line (../team-chat-view.tsx,
 * migrations 556, 557, 559). A root with replies shows its thread bar (how
 * many, who, the person's unread); a press opens the thread beside the
 * channel, reads it, and its box replies in it; a thread's reply never lands
 * in the channel's own list. Reactions are chips with counts, lit when the
 * person reacted, live; nothing is drawn without any. "X is typing" shows
 * while a teammate types and goes when they stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', useWorkspaceEdition: () => null }))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/voice/assistant-name-store', () => ({ useAssistantName: () => ({ name: 'Joseph' }) }))
vi.mock('@/lib/cached-fetch', () => ({
  cachedJson: async () => ({ members: [{ id: 'm-me', display_name: 'Jordan Ellery' }, { id: 'm-rosa', display_name: 'Rosa Lind' }, { id: 'm-ben', display_name: 'Ben Ortiz' }] }),
}))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}), useOptionalRecordingStable: () => null }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
// Realtime: postgres changes kept by table, broadcasts by event; what the page sends on a topic, kept.
const rt = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  topics: [] as string[],
  sent: [] as unknown[],
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (topic: string, opts?: { config?: { private?: boolean } }) => {
      rt.topics.push(`${topic}${opts?.config?.private ? ' (private)' : ''}`)
      const channel = {
        on: (kind: string, filter: { table?: string; event?: string }, cb: (payload: unknown) => void) => {
          rt.handlers.set(kind === 'broadcast' ? `broadcast:${filter.event}` : String(filter.table), cb)
          return channel
        },
        subscribe: (cb?: (status: string) => void) => {
          cb?.('SUBSCRIBED')
          return channel
        },
        send: async (message: unknown) => {
          rt.sent.push(message)
          return 'ok'
        },
      }
      return channel
    },
    removeChannel: async () => {},
    realtime: { setAuth: async () => {} },
  }),
}))

import { TeamChatView } from '../team-chat-view'

const msg = (over: Record<string, unknown>) => ({
  channel_id: 'c-general',
  author_kind: 'member',
  author_member_id: 'm-rosa',
  agent_for_member_id: null,
  agent_name: null,
  in_reply_to: null,
  thread_root_id: null,
  client_id: null,
  body: '',
  mentions: [],
  mentions_agent: false,
  attachments: [],
  link_preview: null,
  created_at: '2026-11-09T10:00:00Z',
  edited_at: null,
  deleted_at: null,
  ...over,
})
const ROOT = msg({ id: 'root-1', body: 'Shall we ship on Friday?' })
const PLAIN = msg({ id: 'plain-1', author_member_id: 'm-ben', body: 'Lunch is here: https://menu.example.test/today. Not javascript:alert(1)', created_at: '2026-11-09T10:30:00Z' })
const REPLY = msg({ id: 'reply-1', author_member_id: 'm-ben', thread_root_id: 'root-1', body: 'Friday works.', created_at: '2026-11-09T10:05:00Z' })

let requests: Array<{ url: string; method: string; body: unknown }> = []
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  requests = []
  rt.handlers.clear()
  rt.topics = []
  rt.sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ url, method: init?.method ?? 'GET', body })
      if (url === '/api/account/team-chat/channels') {
        return new Response(
          JSON.stringify({
            channels: [{ id: 'c-general', kind: 'channel', name: 'general', topic: null, team_id: null, dm_member_id: null, last_message_at: null, archived_at: null, unread: 0, mentions: 0, thread_unread: 1, thread_mentions: 0 }],
            threads: [{ root_id: 'root-1', channel_id: 'c-general', unread: 1, mentions: 0 }],
            memberId: 'm-me',
          }),
        )
      }
      if (url.includes('?thread=root-1')) return new Response(JSON.stringify({ root: ROOT, messages: [REPLY], reactions: [] }))
      if (/channels\/c-general\/messages$/.test(url) && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: msg({ id: 'reply-2', author_member_id: 'm-me', thread_root_id: body.thread ?? null, client_id: body.clientId, body: body.body, created_at: '2026-11-09T10:40:00Z' }) }))
      }
      if (/channels\/c-general\/messages$/.test(url)) {
        return new Response(
          JSON.stringify({
            messages: [ROOT, PLAIN],
            threads: [{ root_id: 'root-1', channel_id: 'c-general', reply_count: 2, last_reply_at: '2026-11-09T10:20:00Z', participant_ids: ['m-ben', 'm-rosa'] }],
            reactions: [
              { message_id: 'plain-1', member_id: 'm-rosa', emoji: '🎉', active: true },
              { message_id: 'plain-1', member_id: 'm-me', emoji: '🎉', active: true },
              { message_id: 'plain-1', member_id: 'm-ben', emoji: '👀', active: true },
            ],
          }),
        )
      }
      return new Response('{}')
    }),
  )
  // Wide: the thread sits beside the channel.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
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

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function render() {
  await act(async () => root.render(<TeamChatView />))
  await settle()
}
const row = (id: string) => container.querySelector(`[data-team-chat-message="${id}"]`)!
// One emoji's chip on a message (found by its attribute's value, not a selector: jsdom's selectors trip on emoji).
const chip = (id: string, emoji: string) => [...row(id).querySelectorAll<HTMLButtonElement>('[data-team-chat-reaction]')].find((c) => c.getAttribute('data-team-chat-reaction') === emoji) ?? null
const threadPane = () => container.querySelector('[data-team-chat-thread-pane]')
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
function typeInto(ta: HTMLTextAreaElement, text: string) {
  act(() => {
    ta.focus()
    setter.call(ta, text)
    ta.setSelectionRange(text.length, text.length)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('threads', () => {
  it('a root shows its thread bar (count, unread); a message without replies has none', async () => {
    await render()
    const bar = row('root-1').querySelector('[data-team-chat-thread-bar]')!
    expect(bar.textContent).toContain('2 replies')
    expect(bar.textContent).toContain('1 new')
    expect(row('plain-1').querySelector('[data-team-chat-thread-bar]')).toBeNull()
    // The list's badge counts the thread's unread reply.
    expect(container.querySelector('[data-team-chat-row="c-general"]')).not.toBeNull()
  })

  it('opening the thread loads it beside the channel and reads it; its reply never lands in the channel', async () => {
    await render()
    act(() => (row('root-1').querySelector('[data-team-chat-thread-bar]') as HTMLButtonElement).click())
    await settle()
    expect(threadPane()).not.toBeNull()
    expect(threadPane()!.textContent).toContain('Shall we ship on Friday?')
    expect(threadPane()!.textContent).toContain('Friday works.')
    expect(requests.some((r) => r.url === '/api/account/team-chat/threads/root-1/read' && r.method === 'POST')).toBe(true)
    // Read: the bar's "new" is gone.
    expect(row('root-1').querySelector('[data-team-chat-thread-bar]')!.textContent).not.toContain('new')
    // The channel's own list holds the root and the plain message only.
    const channelList = container.querySelector('section ul')!
    expect(channelList.querySelector('[data-team-chat-message="reply-1"]')).toBeNull()
  })

  it('the thread’s box replies in the thread; a live reply goes to the open thread, not the channel', async () => {
    await render()
    act(() => (row('root-1').querySelector('[data-team-chat-thread-bar]') as HTMLButtonElement).click())
    await settle()
    const ta = threadPane()!.querySelector('[data-team-chat-composer] textarea') as HTMLTextAreaElement
    expect(ta.getAttribute('placeholder')).toBe('Reply in thread…')
    typeInto(ta, 'I will tell the client')
    act(() => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle()
    const post = requests.find((r) => r.method === 'POST' && r.url.endsWith('/channels/c-general/messages'))!
    expect(post.body).toMatchObject({ body: 'I will tell the client', thread: 'root-1' })
    expect(threadPane()!.querySelector('[data-team-chat-message="reply-2"]')).not.toBeNull()

    act(() => rt.handlers.get('team_chat_message')!({ eventType: 'INSERT', new: msg({ id: 'reply-3', author_member_id: 'm-rosa', thread_root_id: 'root-1', body: 'Great.', created_at: '2026-11-09T10:45:00Z' }) }))
    expect(threadPane()!.querySelector('[data-team-chat-message="reply-3"]')).not.toBeNull()
    expect(container.querySelector('section ul')!.querySelector('[data-team-chat-message="reply-3"]')).toBeNull()
    // The summary follows the live thread row.
    act(() => rt.handlers.get('team_chat_thread')!({ eventType: 'UPDATE', new: { root_id: 'root-1', channel_id: 'c-general', reply_count: 4, last_reply_at: '2026-11-09T10:45:00Z', participant_ids: ['m-rosa', 'm-me', 'm-ben'] } }))
    expect(row('root-1').querySelector('[data-team-chat-thread-bar]')!.textContent).toContain('4 replies')
  })
})

describe('links', () => {
  it('an http(s) link in the words is a link (a new tab, no opener, no referrer); no other scheme is', async () => {
    await render()
    const links = [...row('plain-1').querySelectorAll<HTMLAnchorElement>('[data-team-chat-link]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://menu.example.test/today'])
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')
    expect(row('plain-1').textContent).toContain('today. Not javascript:alert(1)')
  })
})

describe('reactions', () => {
  it('chips per emoji with counts, lit when the person reacted; none drawn on a message without any', async () => {
    await render()
    const chips = [...row('plain-1').querySelectorAll('[data-team-chat-reaction]')]
    expect(chips.map((c) => c.textContent)).toEqual(['🎉2', '👀1'])
    expect(chips[0].getAttribute('aria-pressed')).toBe('true')
    expect(chips[1].getAttribute('aria-pressed')).toBe('false')
    expect(row('root-1').querySelector('[data-team-chat-reactions]')).toBeNull()
  })

  it('a press on their lit chip takes theirs off (at once, then the server), and a live change from someone else shows', async () => {
    await render()
    act(() => chip('plain-1', '🎉')!.click())
    await settle()
    expect(requests.find((r) => r.url === '/api/account/team-chat/messages/plain-1/reactions')?.body).toEqual({ emoji: '🎉', on: false })
    expect(chip('plain-1', '🎉')!.textContent).toBe('🎉1')
    // Ben takes his back (an UPDATE, never a DELETE): the chip goes.
    act(() => rt.handlers.get('team_chat_reaction')!({ eventType: 'UPDATE', new: { message_id: 'plain-1', member_id: 'm-ben', emoji: '👀', active: false } }))
    expect(chip('plain-1', '👀')).toBeNull()
  })
})

describe('typing', () => {
  it('joins the channel’s private topic; a teammate typing shows by name, and goes when they stop', async () => {
    await render()
    expect(rt.topics).toContain('team-chat-typing:c-general (private)')
    expect(container.querySelector('[data-team-chat-typing]')).toBeNull()
    act(() => rt.handlers.get('broadcast:typing')!({ payload: { member_id: 'm-rosa', thread: null, typing: true } }))
    expect(container.querySelector('[data-team-chat-typing]')?.textContent).toBe('Rosa Lind is typing…')
    act(() => rt.handlers.get('broadcast:typing')!({ payload: { member_id: 'm-rosa', thread: null, typing: false } }))
    expect(container.querySelector('[data-team-chat-typing]')).toBeNull()
  })

  it('the person’s own typing goes out throttled, as a member id and the place, never their words', async () => {
    await render()
    const ta = container.querySelector('[data-team-chat-composer] textarea') as HTMLTextAreaElement
    typeInto(ta, 'h')
    typeInto(ta, 'he')
    typeInto(ta, 'hel')
    expect(rt.sent).toEqual([{ type: 'broadcast', event: 'typing', payload: { member_id: 'm-me', thread: null, typing: true } }])
  })
})
