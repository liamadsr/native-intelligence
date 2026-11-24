// @vitest-environment jsdom
/**
 * A meeting guest's message in the members' view (../team-chat-view.tsx,
 * migration 670): the guest's name with a small "Guest" label, initials and
 * never a photo, no Edit, no "Reply in thread" (a guest never sees a
 * thread), no "Make a task" (its words would be the title), and Delete for any member (the route's guest case takes it down);
 * two guests are never one author; one sent while the conversation is open
 * arrives over Realtime like any message; and while the meeting's live call
 * has a guest let in, one quiet line by the composer says they read the chat.
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
// The team calls provider: off (as outside it), or, for one test, in the meeting's live call with its lobby.
const calls = vi.hoisted(() => ({ value: null as Record<string, unknown> | null, kind: 'channel' as 'channel' | 'meeting' }))
vi.mock('@/components/team-calls/team-calls-provider', async (orig) => {
  const real = await orig<typeof import('@/components/team-calls/team-calls-provider')>()
  return { ...real, useTeamCalls: () => ({ ...real.useTeamCalls(), ...(calls.value ?? {}) }) }
})
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
          rt.handlers.set(kind === 'broadcast' ? `broadcast:${filter.event}` : filter.event === 'DELETE' ? `${String(filter.table)}:DELETE` : String(filter.table), cb)
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
  guest_id: null,
  guest_name: null,
  ...over,
})
const guestMsg = (over: Record<string, unknown>) => msg({ author_kind: 'guest', author_member_id: null, guest_id: 'g-sam', guest_name: 'Sam Ruiz', ...over })
const ROOT = msg({ id: 'root-1', author_member_id: 'm-me', body: 'Welcome to the review' })
const PLAIN = guestMsg({ id: 'plain-1', body: 'Thanks for having me', created_at: '2026-11-09T10:01:00Z' })
const LEE = guestMsg({ id: 'guest-2', guest_id: 'g-lee', guest_name: 'Lee Park', body: 'Hello from Lee', created_at: '2026-11-09T10:02:00Z' })

let requested: Array<{ url: string; method: string }> = []
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  rt.handlers.clear()
  rt.topics = []
  rt.sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requested.push({ url, method: init?.method ?? 'GET' })
      if (url === '/api/account/team-chat/channels') {
        return new Response(
          JSON.stringify({
            channels: [{ id: 'c-general', kind: calls.kind, name: 'general', topic: null, team_id: null, dm_member_id: null, last_message_at: null, archived_at: null, unread: 0, mentions: 0, thread_unread: 0, thread_mentions: 0 }],
            threads: [],
            memberId: 'm-me',
          }),
        )
      }
      if (/channels\/c-general\/messages$/.test(url)) {
        return new Response(
          JSON.stringify({
            messages: [ROOT, PLAIN, LEE],
            threads: [],
            reactions: [],
          }),
        )
      }
      return new Response('{}')
    }),
  )
  // Wide: one pane beside the list.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1200 })
  calls.value = null
  calls.kind = 'channel'
  requested = []
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

describe('a meeting guest’s message', () => {
  it('shows the guest’s name and a Guest label, initials and no photo, and no Edit, no thread reply, no task', async () => {
    await render()
    const guest = row('plain-1')
    expect(guest.textContent).toContain('Sam Ruiz')
    expect(guest.querySelector('[data-team-chat-guest]')!.textContent).toBe('Guest')
    expect(guest.textContent).not.toContain('Teammate')
    expect(guest.querySelector('img')).toBeNull()
    expect(guest.textContent).toContain('SR')
    expect(guest.querySelector('[aria-label="Edit message"]')).toBeNull()
    expect(guest.querySelector('[aria-label="Reply in thread"]')).toBeNull()
    // Never a task titled with a guest's words (it is no record: 670).
    expect(guest.querySelector('[aria-label="Make a task"]')).toBeNull()
    expect(row('root-1').querySelector('[aria-label="Make a task"]')).not.toBeNull()
    // A member's own message keeps its tools.
    expect(row('root-1').querySelector('[aria-label="Edit message"]')).not.toBeNull()
    expect(row('root-1').querySelector('[aria-label="Reply in thread"]')).not.toBeNull()
    expect(row('root-1').querySelector('[data-team-chat-guest]')).toBeNull()
  })

  it('any member may take a guest’s message down: Delete asks the route, and it reads as deleted', async () => {
    await render()
    const del = row('plain-1').querySelector('[aria-label="Delete message"]') as HTMLButtonElement
    expect(del).not.toBeNull()
    await act(async () => del.click())
    await settle()
    expect(requested).toContainEqual({ url: '/api/account/team-chat/messages/plain-1', method: 'DELETE' })
    expect(row('plain-1').textContent).toContain('This message was deleted.')
    // Another guest's message: Delete too.
    expect(row('guest-2').querySelector('[aria-label="Delete message"]')).not.toBeNull()
  })

  it('guests let into the meeting’s live call: one quiet line by the composer; none without one', async () => {
    calls.kind = 'meeting'
    calls.value = { available: true, active: { callId: 'call-1', channelId: 'c-general', channelKind: 'meeting', guests: [{ id: 'g-sam', state: 'waiting', call_id: null, in_call: false }] } }
    await render()
    expect(container.querySelector('[data-team-chat-guests-read]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)
    calls.value = { available: true, active: { callId: 'call-1', channelId: 'c-general', channelKind: 'meeting', guests: [{ id: 'g-sam', state: 'admitted', call_id: 'call-1', in_call: true }] } }
    await render()
    expect(container.querySelector('[data-team-chat-guests-read]')!.textContent).toBe('Guests in this call can read this chat.')
  })

  it('two guests a minute apart are two authors: each shows their own name', async () => {
    await render()
    expect(row('guest-2').textContent).toContain('Lee Park')
    expect(row('guest-2').querySelector('[data-team-chat-guest]')).not.toBeNull()
  })

  it('arrives live, as any message does (Realtime delivers the service role’s insert)', async () => {
    await render()
    act(() => rt.handlers.get('team_chat_message')!({ eventType: 'INSERT', new: guestMsg({ id: 'guest-3', body: 'Can you share the deck?', created_at: '2026-11-09T10:50:00Z' }) }))
    expect(row('guest-3').textContent).toContain('Can you share the deck?')
    expect(row('guest-3').textContent).toContain('Sam Ruiz')
  })
})
