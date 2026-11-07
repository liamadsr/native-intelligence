// @vitest-environment jsdom
/**
 * Locks the autosave id-set dedup (plan WS-1e): the count-based slice broke the
 * moment a live-capture agent message arrived over Realtime (it shifted the
 * base and re-sent the tail → duplicate rows on reload). The saved-id set +
 * skipping server-written (live_capture) messages make persistence idempotent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { useChatAutoSave } from '../use-chat-auto-save'
import { openedCardMessage } from '@/lib/chat-cards/opened-card'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fetchMock = vi.fn()
globalThis.fetch = fetchMock as never

function msg(id: string, role: 'user' | 'assistant', extra?: Record<string, unknown>): UIMessage {
  return { id, role, parts: [{ type: 'text', text: id }], ...extra } as UIMessage
}

type AutoSaveApi = ReturnType<typeof useChatAutoSave>

/** Drives the hook across renders and exposes the last save call + the hook API. */
function mount() {
  const container = document.createElement('div')
  const root = createRoot(container)
  let props: { messages: UIMessage[]; status: string; conversationId?: string } = {
    messages: [],
    status: 'ready',
  }
  let api: AutoSaveApi | null = null
  function Harness() {
    api = useChatAutoSave(props.messages, props.status, props.conversationId)
    return null
  }
  const render = () => act(() => { root.render(h(Harness)) })
  render()
  return {
    set(next: Partial<typeof props>) {
      props = { ...props, ...next }
      render()
    },
    api(): AutoSaveApi {
      if (!api) throw new Error('hook not mounted')
      return api
    },
    unmount() { act(() => root.unmount()) },
  }
}

function lastBody(): { messages: UIMessage[] } | null {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) return null
  return JSON.parse((call[1] as RequestInit).body as string)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ conversationId: 'conv-1' }) })
})
afterEach(() => vi.clearAllMocks())

describe('useChatAutoSave — id-set dedup', () => {
  it('a server-written (live_capture) message interleaved between turns is never re-saved', async () => {
    const h = mount()
    // Turn 1: user + assistant → streaming → ready. Creates the conversation.
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1) // POST create
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history')

    // A live-agent say_to_user arrives via Realtime — born-saved (live_capture).
    const injected = msg('s1', 'assistant', { metadata: { live_capture: true } })
    h.set({
      messages: [msg('u1', 'user'), msg('a1', 'assistant'), injected],
      status: 'ready',
    })

    // Turn 2: user + assistant.
    h.set({
      messages: [
        msg('u1', 'user'), msg('a1', 'assistant'), injected,
        msg('u2', 'user'), msg('a2', 'assistant'),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })

    // The PATCH must contain ONLY u2 + a2 — never the already-saved u1/a1 and
    // never the server-written s1 (the old count-slice would have re-sent them).
    const body = lastBody()
    const ids = body?.messages.map((m) => m.id) ?? []
    expect(ids).toEqual(['u2', 'a2'])
    expect(ids).not.toContain('s1')
    h.unmount()
  })

  it('does not save when the only new message is server-written', async () => {
    const h = mount()
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    fetchMock.mockClear()

    // Only a live_capture message appears, then status settles again.
    h.set({
      messages: [
        msg('u1', 'user'), msg('a1', 'assistant'),
        msg('s1', 'assistant', { metadata: { live_capture: true } }),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
    h.unmount()
  })

  // Phase 4: eve-routed turns are projected into chat_messages by the SERVER
  // (eve-message-writer), tagged metadata.eve_written===true. The client must
  // skip them exactly like it skips live_capture rows — else it double-writes /
  // races the server row on reload.
  it('never re-saves an eve-written (metadata.eve_written) assistant message', async () => {
    const h = mount()
    // Turn 1 (cloud/eve-user shape): user + eve-written assistant → creates conv.
    // Only the USER message is client-saved; the assistant is server-written.
    h.set({
      messages: [
        msg('u1', 'user'),
        msg('a1', 'assistant', { metadata: { eve_written: true } }),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1) // POST create
    // The create body carries u1 but NOT the server-written a1.
    const createBody = lastBody()
    const createIds = createBody?.messages.map((m) => m.id) ?? []
    expect(createIds).toEqual(['u1'])
    expect(createIds).not.toContain('a1')

    // Turn 2: another user + eve-written assistant.
    h.set({
      messages: [
        msg('u1', 'user'), msg('a1', 'assistant', { metadata: { eve_written: true } }),
        msg('u2', 'user'), msg('a2', 'assistant', { metadata: { eve_written: true } }),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    // The PATCH carries ONLY the new user message u2 — never any eve-written row.
    const body = lastBody()
    const ids = body?.messages.map((m) => m.id) ?? []
    expect(ids).toEqual(['u2'])
    expect(ids).not.toContain('a2')
    expect(ids).not.toContain('a1')
    h.unmount()
  })

  it('does not save when the only new message is eve-written', async () => {
    const h = mount()
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    fetchMock.mockClear()

    // A lone eve-written assistant lands (e.g. an unprompted server message),
    // then status settles — nothing to persist client-side.
    h.set({
      messages: [
        msg('u1', 'user'), msg('a1', 'assistant'),
        msg('e1', 'assistant', { metadata: { eve_written: true } }),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).not.toHaveBeenCalled()
    h.unmount()
  })
})

// Phase 4 conversation-split fix: the eve transport's mint CREATES the durable
// conversation row on a fresh chat, then hands its id to adoptServerConversationId.
// From that point the client auto-save must PATCH onto THAT row (not POST a fresh
// conversation) — so the user message + the server-projected assistant turn share
// one row. This is the fix for "mint claims row A, client persists to row B".
describe('useChatAutoSave — adoptServerConversationId (conversation-split fix)', () => {
  it('PATCHes the first user turn onto the adopted (mint) row instead of POSTing a fresh one', async () => {
    const h = mount()
    // The eve transport's onConversationEnsured fires during the first send (before
    // the turn settles), binding the auto-save to the mint's row.
    act(() => { h.api().adoptServerConversationId('conv-mint-A') })

    // Turn 1: user + eve-written assistant → streaming → ready.
    h.set({
      messages: [
        msg('u1', 'user'),
        msg('a1', 'assistant', { metadata: { eve_written: true } }),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })

    // The save is a PATCH to the ADOPTED row — never a create POST (which would
    // have minted a divergent row B).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history/conv-mint-A')
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH')
    // Only the client-owned user message rides along; the eve-written assistant is skipped.
    const ids = lastBody()?.messages.map((m) => m.id) ?? []
    expect(ids).toEqual(['u1'])
    h.unmount()
  })

  it('is a no-op once a conversation is already tracked (never re-homes an established thread)', async () => {
    const h = mount()
    // Establish a conversation via the normal create path.
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history') // POST create
    fetchMock.mockClear()

    // A late adopt with a DIFFERENT id must be ignored (guarded by the tracked id).
    act(() => { h.api().adoptServerConversationId('conv-other') })

    // Turn 2 → PATCH onto the ORIGINAL created conversation, not the adopt id.
    h.set({
      messages: [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user'), msg('a2', 'assistant')],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history/conv-1')
    h.unmount()
  })
})

/**
 * Retention (2026-09 desktop heap fix) trims the client's live message array —
 * capping the count and shrinking oversized string tool outputs on OLDER
 * messages. Autosave must not notice: it diffs by message ID, and every message
 * retention is allowed to touch was already POSTed/PATCHed with its full
 * content. A regression here would either re-send a truncated copy over the
 * durable row, or resurrect the dropped prefix as "unsaved" on the next turn.
 */
describe('useChatAutoSave — safe under message retention', () => {
  const toolMsg = (id: string, output: string): UIMessage =>
    ({
      id,
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: `c-${id}`, state: 'output-available', input: {}, output },
      ],
    }) as unknown as UIMessage

  it('never re-sends a saved message whose tool output was later truncated', async () => {
    const h = mount()
    const full = 'x'.repeat(50_000)
    h.set({ messages: [msg('u1', 'user'), toolMsg('a1', full)], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockClear()

    // Retention rewrites a1's part in place (new object, SAME id) and a new
    // turn completes.
    h.set({
      messages: [
        msg('u1', 'user'),
        toolMsg('a1', 'x'.repeat(4_096) + '\n…[truncated]'),
        msg('u2', 'user'),
        msg('a2', 'assistant'),
      ],
      status: 'streaming',
    })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })

    const ids = lastBody()?.messages.map((m) => m.id) ?? []
    expect(ids).toEqual(['u2', 'a2'])
    expect(ids).not.toContain('a1')
    h.unmount()
  })

  it('dropping the oldest messages does not resurrect them as unsaved', async () => {
    const h = mount()
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    fetchMock.mockClear()

    // The cap drops u1/a1 from the client array; the next turn saves only itself.
    h.set({ messages: [msg('u2', 'user'), msg('a2', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(lastBody()?.messages.map((m) => m.id)).toEqual(['u2', 'a2'])
    h.unmount()
  })
})

describe('useChatAutoSave — the conversation it binds to', () => {
  it('when the row is minted server-side — once, never re-homed', () => {
    const h = mount()
    act(() => { h.api().adoptServerConversationId('conv-mint-A') })
    act(() => { h.api().adoptServerConversationId('conv-other') })
    expect(h.api().getConversationId()).toBe('conv-mint-A')
    h.unmount()
  })

  it('not for a create a New chat abandoned', async () => {
    const h = mount()
    let resolveCreate!: (v: unknown) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolveCreate = r }))
    h.set({ messages: [msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    h.set({ status: 'ready' })
    act(() => { h.api().clearConversation() })
    await act(async () => {
      resolveCreate({ ok: true, json: async () => ({ conversationId: 'conv-abandoned' }) })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(h.api().getConversationId()).toBeNull()
    h.unmount()
  })
})

describe('useChatAutoSave — persistNow (a card opened from /, no turn)', () => {
  it('saves a turnless message at once, creating the conversation on a new chat', async () => {
    const h = mount()
    const card = msg('opened-card-1', 'user')
    await act(async () => {
      h.api().persistNow([card])
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat-history')
    expect(lastBody()!.messages.map((m) => m.id)).toEqual(['opened-card-1'])
    await act(async () => { await Promise.resolve() })
    expect(h.api().getConversationId()).toBe('conv-1')

    // The next turn's save writes only what is new: the card is not sent again.
    h.set({ messages: [card, msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => { h.set({ status: 'ready' }); await Promise.resolve() })
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/account/chat-history/conv-1')
    expect(lastBody()!.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('holds a persist while a save is out, then writes it onto the same conversation', async () => {
    let release!: () => void
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ conversationId: 'conv-1' }) }) }),
    )
    const h = mount()
    const first = msg('opened-card-1', 'user')
    const second = msg('opened-card-2', 'user')
    act(() => h.api().persistNow([first]))
    act(() => h.api().persistNow([first, second]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/account/chat-history/conv-1')
    expect(lastBody()!.messages.map((m) => m.id)).toEqual(['opened-card-2'])
  })

  it('names a conversation that so far holds only a page for that page', async () => {
    const h = mount()
    const card = openedCardMessage({ id: 'p1', spec: { kind: 'list', title: 'My actions', entity_type: 'action', filters: [] }, number: 1, page: 'actions' })
    await act(async () => {
      h.api().persistNow([card])
      await Promise.resolve()
    })
    expect((lastBody() as unknown as { title: string }).title).toBe('My actions')
  })

  it('a failed create leaves the card unsaved, and the next save creates the conversation with it', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    const h = mount()
    const card = msg('opened-card-1', 'user')
    await act(async () => {
      h.api().persistNow([card])
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(h.api().getConversationId()).toBeNull()
    expect(h.api().pendingCreate()).toBeNull()

    // The next turn's save retries: a new conversation, the card in it.
    h.set({ messages: [card, msg('u1', 'user'), msg('a1', 'assistant')], status: 'streaming' })
    await act(async () => {
      h.set({ status: 'ready' })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/account/chat-history')
    expect(lastBody()!.messages.map((m) => m.id)).toEqual(['opened-card-1', 'u1', 'a1'])
    expect(h.api().getConversationId()).toBe('conv-1')
  })

  it('hands out the create in flight, resolving to its conversation', async () => {
    let answer!: () => void
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => { answer = () => resolve({ ok: true, json: async () => ({ conversationId: 'conv-9' }) }) }),
    )
    const h = mount()
    act(() => h.api().persistNow([msg('opened-card-1', 'user')]))
    const pending = h.api().pendingCreate()
    expect(pending).not.toBeNull()
    await act(async () => {
      answer()
      await expect(pending).resolves.toBe('conv-9')
    })
    expect(h.api().pendingCreate()).toBeNull()
  })
})
