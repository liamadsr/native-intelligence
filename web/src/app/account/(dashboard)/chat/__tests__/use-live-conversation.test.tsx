// @vitest-environment jsdom
/**
 * Locks the Realtime bridge generalization (F3, conversational onboarding).
 *
 * useLiveConversation was already generic on `conversationId`; F3 points it at
 * the adopted HOME conversation (not just a live capture). These tests drive the
 * hook with a home conversation id and prove the delivery mechanism the brief
 * relies on:
 *   - a server-written row arriving via Realtime INSERT is merged by message id;
 *   - the resync-on-SUBSCRIBED fetch closes the mount→subscribe gap;
 *   - a row that shares an existing message id REPLACES it in place (the
 *     placeholder→brief supersede), never duplicating a bubble;
 *   - events are buffered while a turn is streaming and flushed on settle.
 *
 * An ordinary chat (scope 'teammate-reports', bots v2 phase 7) takes only its
 * delegated teammates' reports, on INSERT, with no resync.
 *
 * A bot's own thread (scope 'relays', bots v4 A4) takes only what the main
 * chat's assistant relayed into it, on INSERT, and resyncs those rows alone,
 * reading in the thread's workspace.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- Fake Supabase realtime channel -----------------------------------------
type Handler = (payload: { new: { ui_message?: unknown } }) => void
const inserted: Handler[] = []
const updated: Handler[] = []
let subscribeCb: ((s: string) => void) | null = null
const removeChannel = vi.fn((_ch: { name: string }) => undefined)
/** Every topic a hook opened, in order. */
const opened: string[] = []

function makeChannel(name: string) {
  const channel = {
    name,
    on(_evt: string, cfg: { event: string }, handler: Handler) {
      if (cfg.event === 'INSERT') inserted.push(handler)
      if (cfg.event === 'UPDATE') updated.push(handler)
      return channel
    },
    subscribe(cb: (s: string) => void) {
      subscribeCb = cb
      return channel
    },
  }
  return channel
}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => (opened.push(name), makeChannel(name)),
    removeChannel,
  }),
}))

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

import { isApprovalResultMessage, isProvisionalReply, isServerTurnRow, useLiveConversation, type LiveConversation } from '../use-live-conversation'

function row(id: string, text: string) {
  return { ui_message: { id, role: 'assistant', parts: [{ type: 'text', text }] } }
}

function mount(initial: {
  conversationId: string | null
  status: string
  messages: UIMessage[]
  scope?: 'all' | 'relays' | 'server-turns'
  workspaceId?: string | null
  /** Call each setMessages updater twice, as React's StrictMode does (only the second result is kept). */
  doubleUpdater?: boolean
}) {
  const container = document.createElement('div')
  const root = createRoot(container)
  const state = { ...initial }
  const savedIds: string[] = []
  let live: LiveConversation | null = null
  function Harness() {
    live = useLiveConversation({
      conversationId: state.conversationId,
      status: state.status,
      setMessages: (updater) => {
        if (state.doubleUpdater) updater(state.messages)
        state.messages = updater(state.messages)
      },
      markSaved: (ids) => savedIds.push(...ids),
      scope: state.scope,
      workspaceId: state.workspaceId,
    })
    return null
  }
  const render = () => act(() => { root.render(h(Harness)) })
  render()
  return {
    set(next: Partial<typeof state>) {
      Object.assign(state, next)
      render()
    },
    messages: () => state.messages,
    savedIds: () => savedIds,
    live: () => live!,
    unmount: () => act(() => root.unmount()),
  }
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  inserted.length = 0
  updated.length = 0
  opened.length = 0
  subscribeCb = null
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) })
})
afterEach(() => vi.clearAllMocks())

describe('useLiveConversation — home conversation (F3)', () => {
  it('merges a Realtime INSERT of the brief into the panel and marks it saved', async () => {
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [] })
    await flush()
    act(() => inserted[0]?.({ new: row('onboarding-brief-w1', 'Welcome in') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['onboarding-brief-w1'])
    expect(hk.savedIds()).toContain('onboarding-brief-w1')
    hk.unmount()
  })

  it('resyncs on SUBSCRIBED, closing the mount→subscribe gap', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: 'onboarding-brief-w1', role: 'assistant', parts: [] }] }),
    })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [] })
    await act(async () => { subscribeCb?.('SUBSCRIBED'); await flush() })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/home-1')
    expect(hk.messages().map((m) => m.id)).toEqual(['onboarding-brief-w1'])
    hk.unmount()
  })

  it('replaces a placeholder in place when the real brief shares its id (supersede)', async () => {
    const placeholder = {
      id: 'onboarding-brief-w1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'one sec…' }],
      metadata: { onboarding_placeholder: true },
    } as unknown as UIMessage
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [placeholder] })
    await flush()
    act(() => inserted[0]?.({ new: row('onboarding-brief-w1', 'The real brief') }))
    const msgs = hk.messages()
    expect(msgs).toHaveLength(1)
    expect((msgs[0].parts[0] as { text: string }).text).toBe('The real brief')
    expect((msgs[0] as { metadata?: unknown }).metadata).toBeUndefined()
    hk.unmount()
  })

  it('buffers events while streaming and flushes them on settle', async () => {
    const hk = mount({ conversationId: 'home-1', status: 'streaming', messages: [] })
    await flush()
    act(() => inserted[0]?.({ new: row('guide-nudge-1', 'mid-turn nudge') }))
    // Buffered: not applied while streaming.
    expect(hk.messages()).toHaveLength(0)
    await act(async () => { hk.set({ status: 'ready' }); await flush() })
    expect(hk.messages().map((m) => m.id)).toEqual(['guide-nudge-1'])
    hk.unmount()
  })

  it('is inert when conversationId is null (normal chat)', async () => {
    const hk = mount({ conversationId: null, status: 'ready', messages: [] })
    await flush()
    expect(inserted).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
    hk.unmount()
  })
})

describe('useLiveConversation — the home thread hears its teammates (bots v2 phase 7)', () => {
  function report(id: string, text: string) {
    return {
      ui_message: {
        id,
        role: 'assistant',
        parts: [{ type: 'text', text }],
        metadata: { eve_written: true, kind: 'teammate_report' },
      },
    }
  }
  const own = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Have the Writer draft the Q3 recap' }] } as UIMessage

  it('shows a teammate report inserted into the open conversation, after what is there', async () => {
    const hk = mount({ conversationId: 'conv-1', status: 'ready', messages: [own], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: report('teammate-report-run-1-needs_review', 'Quill finished **Q3 recap** — ready for your review.') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['u1', 'teammate-report-run-1-needs_review'])
    expect(hk.savedIds()).toEqual(['teammate-report-run-1-needs_review'])
    hk.unmount()
  })

  it('ignores every other row of the conversation: the panel already holds its own turns', async () => {
    const hk = mount({ conversationId: 'conv-1', status: 'ready', messages: [own], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: row('u1', 'the stored copy of my own message') }))
    act(() => inserted[0]?.({ new: { ui_message: { id: 'eve-msg-1', role: 'assistant', parts: [], metadata: { eve_written: true } } } }))
    expect(hk.messages()).toEqual([own])
    hk.unmount()
  })

  it('two panels on one chat open their own channels: closing one leaves the other subscribed', async () => {
    const a = mount({ conversationId: 'conv-1', status: 'ready', messages: [], scope: 'server-turns' })
    const b = mount({ conversationId: 'conv-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    expect(opened).toHaveLength(2)
    for (const name of opened) expect(name).toMatch(/^server-turns:conv-1:[0-9a-f-]{36}$/)
    expect(opened[0]).not.toBe(opened[1])
    a.unmount()
    // Only the closed panel's own channel was removed.
    expect(removeChannel.mock.calls.map(([ch]) => ch.name)).toEqual([opened[0]])
    b.unmount()
    expect(removeChannel.mock.calls.map(([ch]) => ch.name)).toEqual([opened[0], opened[1]])
  })

  it('a live capture’s full bridge is per panel too', async () => {
    const a = mount({ conversationId: 'cap-conv', status: 'ready', messages: [] })
    const b = mount({ conversationId: 'cap-conv', status: 'ready', messages: [] })
    await flush()
    expect(opened).toHaveLength(2)
    for (const name of opened) expect(name).toMatch(/^live-convo:cap-conv:[0-9a-f-]{36}$/)
    expect(opened[0]).not.toBe(opened[1])
    a.unmount()
    b.unmount()
  })

  it('holds a report that lands mid-turn until the turn settles', async () => {
    const hk = mount({ conversationId: 'conv-1', status: 'streaming', messages: [own], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: report('teammate-report-run-1-failed', "Quill couldn't finish **Q3 recap**.") }))
    expect(hk.messages()).toEqual([own])
    await act(async () => { hk.set({ status: 'ready' }); await flush() })
    expect(hk.messages().map((m) => m.id)).toEqual(['u1', 'teammate-report-run-1-failed'])
    hk.unmount()
  })
})

describe('useLiveConversation — a bot’s own thread (scope relays, bots v4 A4)', () => {
  const relayRow = (id: string, text: string, role = 'assistant') => ({
    ui_message: { id, role, parts: [{ type: 'text', text }], metadata: { eve_written: true, relay: { id: 'relay-1', from: 'main_chat' } } },
  })

  it('merges only relayed rows, on INSERT (never UPDATE), leaving the thread’s own turns alone', async () => {
    const own = { id: 'own-1', role: 'assistant', parts: [{ type: 'text', text: 'live' }] } as UIMessage
    const hk = mount({ conversationId: 'thread-1', status: 'ready', messages: [own], scope: 'relays' })
    await flush()
    expect(updated).toHaveLength(0)
    expect(opened[0]).toMatch(/^relays:thread-1:[0-9a-f-]{36}$/)
    act(() => inserted[0]?.({ new: row('own-1', 'stored copy') }))
    act(() => inserted[0]?.({ new: relayRow('relay-relay-1-message', 'From your main chat: hi', 'user') }))
    act(() => inserted[0]?.({ new: relayRow('relay-relay-1-reply', 'Hello.') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['own-1', 'relay-relay-1-message', 'relay-relay-1-reply'])
    expect((hk.messages()[0].parts[0] as { text: string }).text).toBe('live')
  })

  it('resyncs relayed rows alone on SUBSCRIBED, reading in the thread’s workspace', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [row('other', 'x').ui_message, relayRow('relay-relay-1-reply', 'Hello.').ui_message] }),
    })
    const hk = mount({ conversationId: 'thread-1', status: 'ready', messages: [], scope: 'relays', workspaceId: 'ws-2' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/thread-1?limit=100', { headers: { 'x-workspace-id': 'ws-2' } })
    expect(hk.messages().map((m) => m.id)).toEqual(['relay-relay-1-reply'])
  })

  it('never floors a relay resync: the thread holds its whole history, so a relay it lacks is new, however long ago it was written', async () => {
    // An empty kept thread, shown again an hour after two relays landed in it.
    const at = (id: string, ms: number) => ({ ...relayRow(id, 'x').ui_message, metadata: { ...relayRow(id, 'x').ui_message.metadata, createdAt: new Date(ms).toISOString() } })
    const hourAgo = Date.now() - 60 * 60_000
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [at('relay-relay-1-message', hourAgo), at('relay-relay-1-reply', hourAgo + 1_000)] }) })
    const hk = mount({ conversationId: 'thread-1', status: 'ready', messages: [], scope: 'relays' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['relay-relay-1-message', 'relay-relay-1-reply'])
  })

  it('buffers relayed rows while the thread streams its own turn, and merges them when it settles', async () => {
    const hk = mount({ conversationId: 'thread-1', status: 'streaming', messages: [], scope: 'relays' })
    await flush()
    act(() => inserted[0]?.({ new: relayRow('relay-relay-1-reply', 'Hello.') }))
    expect(hk.messages()).toEqual([])
    hk.set({ status: 'ready' })
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['relay-relay-1-reply'])
  })
})


describe('useLiveConversation — the home thread (scope server-turns, A4 slice 5)', () => {
  const homeTurnRow = (rowId: string, text: string) => ({
    ui_message: { id: `home-turn:${rowId}`, role: 'assistant', parts: [{ type: 'text', text }], metadata: { eve_written: true, kind: 'home_turn' } },
  })
  const reportRow = (id: string) => ({
    ui_message: { id: `teammate-report-${id}`, role: 'assistant', parts: [{ type: 'text', text: 'Quill finished it' }], metadata: { kind: 'teammate_report' } },
  })

  it('merges reports and server turns, on INSERT only, leaving the thread’s own turns alone', async () => {
    const own = { id: 'own-1', role: 'assistant', parts: [{ type: 'text', text: 'live' }] } as UIMessage
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [own], scope: 'server-turns' })
    await flush()
    expect(updated).toHaveLength(0)
    expect(opened[0]).toMatch(/^server-turns:home-1:[0-9a-f-]{36}$/)
    act(() => inserted[0]?.({ new: row('own-1', 'stored copy') }))
    act(() => inserted[0]?.({ new: reportRow('run-1-needs_review') }))
    act(() => inserted[0]?.({ new: homeTurnRow('r1', 'Your researcher finished the list.') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['own-1', 'teammate-report-run-1-needs_review', 'home-turn:r1'])
    expect((hk.messages()[0].parts[0] as { text: string }).text).toBe('live')
    expect(hk.savedIds()).toEqual(['teammate-report-run-1-needs_review', 'home-turn:r1'])
  })

  it('resyncs server-written rows alone on SUBSCRIBED', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [row('other', 'x').ui_message, homeTurnRow('r2', 'Heads up').ui_message] }),
    })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/home-1?limit=100')
    expect(hk.messages().map((m) => m.id)).toEqual(['home-turn:r2'])
  })

  it('never appends a report older than what the chat holds (Oct 18 preps below Oct 26, 2026-10-26)', async () => {
    const at = (id: string, iso: string) => ({ ...reportRow(id).ui_message, metadata: { kind: 'teammate_report', createdAt: iso } })
    // The chat opened on its newest page: today's messages.
    const today = { id: 'own-today', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { createdAt: '2026-10-26T20:00:00.000Z' } } as UIMessage
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [at('prep-oct18', '2026-10-18T15:45:31.000Z'), at('gap-row', '2026-10-26T20:05:00.000Z')] }),
    })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [today], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['own-today', 'teammate-report-gap-row'])
    // A live INSERT is never held back by the floor.
    act(() => inserted[0]?.({ new: { ui_message: at('late', '2026-10-26T19:00:00.000Z') } }))
    expect(hk.messages().map((m) => m.id)).toEqual(['own-today', 'teammate-report-gap-row', 'teammate-report-late'])
  })

  it('keeps the floor when React calls the updater twice (StrictMode): the resync marks are read outside it', async () => {
    const at = (id: string, iso: string) => ({ ...reportRow(id).ui_message, metadata: { kind: 'teammate_report', createdAt: iso } })
    const today = { id: 'own-today', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { createdAt: '2026-10-26T20:00:00.000Z' } } as UIMessage
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [at('prep-oct18', '2026-10-18T15:45:31.000Z')] }) })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [today], scope: 'server-turns', doubleUpdater: true })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['own-today'])
  })

  it('into an empty chat, a resync takes only rows from around when it mounted', async () => {
    const now = Date.now()
    const at = (id: string, ms: number) => ({ ...reportRow(id).ui_message, metadata: { kind: 'teammate_report', createdAt: new Date(ms).toISOString() } })
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [at('old', now - 8 * 86_400_000), at('fresh', now - 60_000)] }) })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['teammate-report-fresh'])
  })

  it('takes an approval’s outcome too (approvals.ts writes it into the home thread), live and on resync', async () => {
    const approvalRow = (id: string) => ({
      ui_message: {
        id: `approval-${id}`,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done: send_email ran after you approved it.' }],
        metadata: { kind: 'approval_result', approval_id: id },
      },
    })
    expect(isServerTurnRow(approvalRow('a1').ui_message)).toBe(true)
    // P13: what the server asks or tells in the home thread shows live too.
    for (const kind of ['ask_card', 'ask_cards', 'ci_red']) expect(isServerTurnRow({ id: 'x', role: 'assistant', parts: [], metadata: { kind } })).toBe(true)
    // The morning tidy's message lands while the home thread is open (src/lib/email/auto-archive.ts).
    expect(isServerTurnRow({ id: 'email-auto-archive:b-1', role: 'assistant', parts: [], metadata: { kind: 'email_auto_archive', batch_id: 'b-1' } })).toBe(true)
    // So does a to-do arriving mail marked done (src/lib/email/action-done-from-mail.ts).
    expect(isServerTurnRow({ id: 'action-done-from-mail:r-1', role: 'assistant', parts: [], metadata: { kind: 'action_done_from_mail', record_id: 'r-1' } })).toBe(true)
    expect(isServerTurnRow({ id: 'x', role: 'assistant', parts: [], metadata: { kind: 'greeting' } })).toBe(false)
    expect(isApprovalResultMessage({ metadata: { kind: 'approval_result' } })).toBe(true)
    expect(isApprovalResultMessage({ metadata: { kind: 'greeting' } })).toBe(false)
    expect(isApprovalResultMessage(null)).toBe(false)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [approvalRow('a0').ui_message] }) })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    act(() => inserted[0]?.({ new: approvalRow('a1') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['approval-a0', 'approval-a1'])
  })

  it('holds a server turn that lands mid-turn until the thread’s own turn settles', async () => {
    const hk = mount({ conversationId: 'home-1', status: 'streaming', messages: [], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: homeTurnRow('r3', 'Heads up') }))
    expect(hk.messages()).toEqual([])
    expect(hk.live().buffered('home-turn:r3')).toBe(true)
    hk.set({ status: 'ready' })
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['home-turn:r3'])
    expect(hk.live().buffered('home-turn:r3')).toBe(false)
  })

  // PROD 2026-10-31: a home turn never reached the open desktop chat; the
  // router's banner about it came 2 minutes later, and the chat reads it in.
  it('catchUp makes the resync read on demand, through the same merge', async () => {
    const own = { id: 'own-1', role: 'assistant', parts: [{ type: 'text', text: 'live' }], metadata: { createdAt: new Date().toISOString() } } as UIMessage
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [own], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    fetchMock.mockClear()
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [row('own-1', 'stored copy').ui_message, homeTurnRow('wf', 'Whole Foods moved to 4').ui_message] }) })
    await act(async () => {
      await hk.live().catchUp()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/account/chat-history/home-1?limit=100')
    expect(hk.messages().map((m) => m.id)).toEqual(['own-1', 'home-turn:wf'])
    expect((hk.messages()[0].parts[0] as { text: string }).text).toBe('live')
  })

  it('takes a guest’s note and a guest’s request (the router banners both), live and on catch-up', async () => {
    const note = { ui_message: { id: 'guest-message:n1', role: 'assistant', parts: [], metadata: { kind: 'guest_message', guest_id: 'g1' } } }
    const request = { ui_message: { id: 'guest-request:g2', role: 'assistant', parts: [], metadata: { kind: 'guest_request', guest_id: 'g2' } } }
    const activity = { ui_message: { id: 'guest-activity:g1', role: 'assistant', parts: [], metadata: { kind: 'guest_activity', guest_id: 'g1' } } }
    expect(isServerTurnRow(note.ui_message)).toBe(true)
    expect(isServerTurnRow(request.ui_message)).toBe(true)
    // Rewritten in place as the stretch grows; this scope hears inserts only.
    expect(isServerTurnRow(activity.ui_message)).toBe(false)
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: note }))
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [note.ui_message, request.ui_message, activity.ui_message] }) })
    await act(async () => {
      await hk.live().catchUp()
    })
    expect(hk.messages().map((m) => m.id)).toEqual(['guest-message:n1', 'guest-request:g2'])
  })

  it('a read still out when the chat moves to another conversation merges nothing into it', async () => {
    let answer!: (v: unknown) => void
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    let read: Promise<void> | null = null
    act(() => {
      read = hk.live().catchUp()
    })
    hk.set({ conversationId: 'conv-2' })
    await act(async () => {
      answer({ ok: true, json: async () => ({ messages: [homeTurnRow('old', 'From the old thread').ui_message] }) })
      await read
    })
    expect(hk.messages()).toEqual([])
  })

  it('a late status from a removed channel never stands for the next one', async () => {
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    const first = subscribeCb!
    hk.set({ conversationId: 'conv-2' })
    act(() => subscribeCb?.('SUBSCRIBED'))
    act(() => first('CLOSED'))
    expect(hk.live().channelStatus()).toBe('SUBSCRIBED')
  })

  it('reports the channel’s last status, and catches up nothing once unmounted', async () => {
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    expect(hk.live().channelStatus()).toBeNull()
    act(() => subscribeCb?.('CHANNEL_ERROR'))
    expect(hk.live().channelStatus()).toBe('CHANNEL_ERROR')
    const live = hk.live()
    hk.unmount()
    fetchMock.mockClear()
    await live.catchUp()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('useLiveConversation — a reply the reply backup wrote (scope server-turns)', () => {
  const provisional = (id: string, text: string) => ({
    ui_message: { id, role: 'assistant', parts: [{ type: 'text', text }], metadata: { eve_written: true, eve_provisional: true } },
  })

  it('recognizes only a provisional reply', () => {
    expect(isProvisionalReply(provisional('r', 'x').ui_message)).toBe(true)
    expect(isProvisionalReply({ metadata: { eve_written: true } })).toBe(false)
    expect(isProvisionalReply(null)).toBe(false)
  })

  it('shows the reply of a turn whose page died (the reloaded thread lacks it), after what is there', async () => {
    const asked = { id: 'user-msg-1', role: 'user', parts: [{ type: 'text', text: 'Rewrite the steps' }] } as UIMessage
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [asked], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: provisional('eve-msg-1', 'I rewrote all three steps.') }))
    expect(hk.messages().map((m) => m.id)).toEqual(['user-msg-1', 'eve-msg-1'])
    expect(hk.savedIds()).toEqual(['eve-msg-1'])
  })

  it('never swaps in the stored copy of a reply this page is rendering, live or after its turn settles', async () => {
    const own = { id: 'eve-msg-2', role: 'assistant', parts: [{ type: 'text', text: 'live copy' }] } as UIMessage
    const hk = mount({ conversationId: 'home-1', status: 'streaming', messages: [own], scope: 'server-turns' })
    await flush()
    act(() => inserted[0]?.({ new: provisional('eve-msg-2', 'server copy') }))
    hk.set({ status: 'ready' })
    await flush()
    act(() => inserted[0]?.({ new: provisional('eve-msg-2', 'server copy again') }))
    expect(hk.messages()).toHaveLength(1)
    expect((hk.messages()[0].parts[0] as { text: string }).text).toBe('live copy')
  })

  it('resyncs a provisional reply on SUBSCRIBED too', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [row('other', 'x').ui_message, provisional('eve-msg-3', 'late').ui_message] }) })
    const hk = mount({ conversationId: 'home-1', status: 'ready', messages: [], scope: 'server-turns' })
    await flush()
    act(() => subscribeCb?.('SUBSCRIBED'))
    await flush()
    expect(hk.messages().map((m) => m.id)).toEqual(['eve-msg-3'])
  })
})
