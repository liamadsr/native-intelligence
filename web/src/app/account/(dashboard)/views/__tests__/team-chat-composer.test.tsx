// @vitest-environment jsdom
/**
 * Team chat's box (../team-chat-view.tsx) is the main chat's composer
 * (ChatInput) with its own `@` list: the person's agent, then the members but
 * them. What it posts: the members picked whose "@Name" is still in the words
 * (`mentions`), and whether the agent is called (`mentionsAgent`: "@Joseph"
 * in the words, picked or typed). A send is optimistic: its bubble at once,
 * under the client id the page minted, and the row (from the answer or
 * Realtime, whichever comes first) takes its place, never a second bubble; a
 * failed one says so on the bubble, and Retry sends it again with the same
 * id. Files upload at once into the channel's folder and ride with the send.
 * An archived channel has no box, only why.
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
// The realtime channel (its handlers kept by table, so a test can send what the database would) and storage.
const supa = vi.hoisted(() => ({
  handlers: new Map<string, (payload: unknown) => void>(),
  uploads: [] as Array<{ path: string; type: string }>,
  removed: [] as string[],
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const channel = {
      on: (_event: string, filter: { table?: string }, cb: (payload: unknown) => void) => {
        if (filter?.table) supa.handlers.set(filter.table, cb)
        return channel
      },
      subscribe: () => channel,
      send: async () => 'ok',
    }
    const bucket = {
      upload: async (path: string, _file: unknown, opts: { contentType: string }) => {
        supa.uploads.push({ path, type: opts.contentType })
        return { data: { path }, error: null }
      },
      remove: async (paths: string[]) => {
        supa.removed.push(...paths)
        return { data: [], error: null }
      },
      createSignedUrls: async (paths: string[]) => ({ data: paths.map((path) => ({ path, signedUrl: `https://files.test/${path}`, error: null })), error: null }),
    }
    return {
      channel: () => channel,
      removeChannel: async () => {},
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u-me' } } } }) },
      storage: { from: () => bucket },
    }
  },
}))
vi.mock('@/hooks/recording-context', () => ({ useRecordingStable: () => ({}), useOptionalRecordingStable: () => null }))
// What the desktop's voice can do (useVoiceAvailability): set per test.
const voiceState = vi.hoisted(() => ({
  current: { hasVoice: false, visible: false, dictation: false, conversation: false, blocked: null, status: {} } as Record<string, unknown>,
}))
vi.mock('@/hooks/use-voice-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-voice-availability')>()),
  useVoiceAvailability: () => voiceState.current,
}))
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
  thread_unread: 0,
  thread_mentions: 0,
  ...over,
})

let posts: Array<{ body: string; mentions: string[]; mentionsAgent: boolean }> = []
// The client id of each post, in order (a retry sends the same one).
let clientIds: string[] = []
let postStatus = 200
// Held: the answer waits until the test lets it go (what Realtime does meanwhile is up to the test).
let holdPost: Promise<void> | null = null
let channels: unknown[] = [channel()]
let container: HTMLDivElement
let root: Root
let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  posts = []
  clientIds = []
  postStatus = 200
  holdPost = null
  supa.handlers.clear()
  supa.uploads = []
  supa.removed = []
  channels = [channel()]
  fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/team-chat/channels') return new Response(JSON.stringify({ channels, threads: [], memberId: 'm-me' }))
    if (/channels\/c-general\/messages$/.test(url) && init?.method === 'POST') {
      const { clientId, ...sent } = JSON.parse(String(init.body)) as { body: string; mentions: string[]; mentionsAgent: boolean; clientId: string }
      posts.push(sent)
      clientIds.push(clientId)
      if (holdPost) await holdPost
      if (postStatus !== 200) return new Response('{}', { status: postStatus })
      const message = {
        id: `msg-${clientIds.indexOf(clientId) + 1}`,
        client_id: clientId,
        channel_id: 'c-general',
        author_kind: 'member',
        author_member_id: 'm-me',
        agent_for_member_id: null,
        agent_name: null,
        in_reply_to: null,
        thread_root_id: null,
        body: sent.body,
        mentions: sent.mentions,
        // The server's own read: the flag, or "@Joseph" in the words.
        mentions_agent: sent.mentionsAgent || /(^|\s)@Joseph(?! Lee)\b/.test(sent.body),
        attachments: [],
        link_preview: null,
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

  it('a record found by typing (a deal): its "@label" in the words, sent as a record mention', async () => {
    const searched: string[] = []
    const base = fetchSpy.getMockImplementation()!
    fetchSpy.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/account/search')) {
        searched.push(String(url))
        const results = { deal: [{ kind: 'deal', id: 'd0000000-0000-4000-8000-000000000001', pipelineId: 'p0000000-0000-4000-8000-000000000001', title: 'Fernhill renewal', status: 'Proposal sent', score: 0.85 }] }
        return new Response(JSON.stringify({ query: 'fern', results }))
      }
      return base(url, init)
    })
    await render()
    type('@fern')
    await settle(200)
    // Searched for the one picker's kinds (contacts and files among them; a teammate's
    // own contact is left out of the list), never agents or messages.
    expect(searched.length).toBeGreaterThan(0)
    const types = new URL(searched[searched.length - 1], 'http://x').searchParams.get('types')!.split(',')
    expect(types).toEqual(expect.arrayContaining(['deal', 'contact', 'attachment', 'calendar_event']))
    expect(types).not.toContain('agent')
    expect(types).not.toContain('team_chat_message')
    press('Enter')
    await settle()
    expect(box().value).toBe('@Fernhill renewal ')
    type('is due')
    press('Enter')
    await settle()
    expect(posts[0]).toEqual({
      body: '@Fernhill renewal is due',
      mentions: [],
      mentionsAgent: false,
      // A deal is its pipeline's row (Tables, phase 7).
      records: [{ type: 'data_row', id: 'd0000000-0000-4000-8000-000000000001', label: 'Fernhill renewal' }],
    })
  })

  it('Shift+Enter is a new line, not a send', async () => {
    await render()
    type('one')
    const e = press('Enter', { shiftKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(posts).toEqual([])
  })

  it('a send is drawn at once, and its row (Realtime first, then the answer) takes the bubble’s place: one element, never two', async () => {
    let release!: () => void
    holdPost = new Promise<void>((r) => (release = r))
    await render()
    type('shipping today')
    press('Enter')
    await settle()
    // The bubble, before any answer, and the box free again.
    const bubble = container.querySelector('[data-team-chat-message^="pending:"]')
    expect(bubble?.textContent).toContain('shipping today')
    expect(bubble?.getAttribute('data-pending')).toBe('sending')
    expect(box().value).toBe('')
    // Realtime brings the row before the answer does.
    const row = {
      id: 'msg-1',
      client_id: clientIds[0],
      channel_id: 'c-general',
      author_kind: 'member',
      author_member_id: 'm-me',
      agent_for_member_id: null,
      agent_name: null,
      in_reply_to: null,
      thread_root_id: null,
      body: 'shipping today',
      mentions: [],
      mentions_agent: false,
      attachments: [],
      link_preview: null,
      created_at: '2026-11-09T10:00:00Z',
      edited_at: null,
      deleted_at: null,
    }
    act(() => supa.handlers.get('team_chat_message')!({ eventType: 'INSERT', new: row }))
    const stored = container.querySelector('[data-team-chat-message="msg-1"]')
    // The same element, now the row: no remount, so no flicker.
    expect(stored).toBe(bubble)
    expect(stored?.hasAttribute('data-pending')).toBe(false)
    release()
    await settle()
    expect(container.querySelectorAll('[data-team-chat-message]')).toHaveLength(1)
    expect(container.querySelector('[data-team-chat-message="msg-1"]')).toBe(bubble)
  })

  it('a failed send says so on its bubble; Retry sends it again with the same client id, and the row replaces it', async () => {
    postStatus = 500
    await render()
    type('hello')
    press('Enter')
    await settle()
    expect(posts).toHaveLength(1)
    expect(container.querySelector('[data-team-chat-message^="pending:"]')?.getAttribute('data-pending')).toBe('failed')
    expect(container.querySelector('[data-team-chat-failed]')?.textContent).toContain('Not sent.')
    postStatus = 200
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[data-team-chat-failed] button')].find((b) => b.textContent?.includes('Retry'))!.click())
    await settle()
    expect(clientIds).toHaveLength(2)
    expect(clientIds[1]).toBe(clientIds[0])
    expect(container.querySelectorAll('[data-team-chat-message]')).toHaveLength(1)
    expect(container.querySelector('[data-team-chat-message="msg-1"]')?.textContent).toContain('hello')
    expect(container.querySelector('[data-team-chat-failed]')).toBeNull()
  })

  it('a file picked uploads at once into the channel’s folder (the person’s sub-folder) and rides with the send; a file of another kind is refused', async () => {
    await render()
    const input = container.querySelector<HTMLInputElement>('[data-team-chat-composer] input[type="file"]')!
    expect(input.accept).toContain('.pdf')
    expect(input.accept).not.toContain('.svg')
    const pdf = new File([new Uint8Array(1200)], 'Quote.pdf', { type: 'application/pdf' })
    const page = new File(['<html>'], 'page.html', { type: 'text/html' })
    Object.defineProperty(input, 'files', { configurable: true, value: [pdf, page] })
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(supa.uploads).toHaveLength(1)
    expect(supa.uploads[0].path).toMatch(/^c-general\/u-me\/[0-9a-f-]{36}\.pdf$/)
    expect(supa.uploads[0].type).toBe('application/pdf')
    expect(container.querySelector('[data-team-chat-composer]')?.textContent).toContain('That kind of file can’t be shared here')
    press('Enter')
    await settle()
    const sent = posts[0] as unknown as { body: string; attachments: Array<Record<string, unknown>> }
    expect(sent.body).toBe('')
    expect(sent.attachments).toEqual([{ path: supa.uploads[0].path, name: 'Quote.pdf', size: 1200, type: 'application/pdf' }])
  })

  it('an upload never sent is taken back when the box goes (another channel, the thread closed); one sent stays', async () => {
    await render()
    const input = () => container.querySelector<HTMLInputElement>('[data-team-chat-composer] input[type="file"]')!
    const attach = async (name: string) => {
      Object.defineProperty(input(), 'files', { configurable: true, value: [new File([new Uint8Array(10)], name, { type: 'application/pdf' })] })
      act(() => input().dispatchEvent(new Event('change', { bubbles: true })))
      await settle()
    }
    await attach('sent.pdf')
    press('Enter')
    await settle()
    await attach('left.pdf')
    expect(supa.uploads).toHaveLength(2)
    await act(async () => root.render(<div />))
    await settle()
    expect(supa.removed).toEqual([supa.uploads[1].path])
  })

  it('dictation, where the desktop has it: the mic in the box, and no voice mode (a channel is no conversation with the agent)', async () => {
    voiceState.current = { hasVoice: true, visible: true, dictation: true, conversation: true, blocked: null, status: {} }
    await render()
    const composer = container.querySelector('[data-team-chat-composer]')!
    expect(composer.querySelector('[data-voice-control="dictation"]')).not.toBeNull()
    expect(composer.querySelector('[data-voice-control="conversation"]')).toBeNull()
    voiceState.current = { hasVoice: false, visible: false, dictation: false, conversation: false, blocked: null, status: {} }
  })

  it('one row, as a modern chat box: +, the field, the mic, then send', async () => {
    voiceState.current = { hasVoice: true, visible: true, dictation: true, conversation: true, blocked: null, status: {} }
    await render()
    const row = container.querySelector('[data-team-chat-composer] [data-composer-controls]')!
    expect(row.getAttribute('data-composer-layout')).toBe('inline')
    const order = [
      row.querySelector('button[aria-label="Add"]'),
      row.querySelector('textarea'),
      row.querySelector('[data-voice-control="dictation"]'),
      row.querySelector('button[aria-label="Send message"]'),
    ]
    expect(order.every(Boolean)).toBe(true)
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    voiceState.current = { hasVoice: false, visible: false, dictation: false, conversation: false, blocked: null, status: {} }
  })

  it('no dictation where the desktop has none (a browser): no mic', async () => {
    await render()
    expect(container.querySelector('[data-team-chat-composer] [data-voice-control="dictation"]')).toBeNull()
  })

  it('an archived channel has no box, only why', async () => {
    channels = [channel({ archived_at: '2026-11-09T11:00:00Z' })]
    await render()
    expect(container.textContent).toContain('This channel is archived.')
    expect(container.querySelector('[data-team-chat-composer]')).toBeNull()
  })
})
