// @vitest-environment jsdom
/**
 * The main chat's context on the client (context-client.ts): one read at a
 * time, a fresh read serving a reopen, a read for a conversation the chat has
 * left dropped; Compact now's answer as the card's note, and the size read
 * again after it (now and as after a reply); one compaction per conversation
 * in flight, kept across the card switching conversations; another
 * conversation's never moving the card; `/compact` recognised only on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compactChatContext,
  compactionNote,
  getChatContextState,
  isCompactCommand,
  readChatContext,
  resetChatContext,
  setContextConversation,
} from '../context-client'

const USAGE = { model: 'deepseek-v4-flash', usedTokens: 45_200, windowTokens: 250_000, compactAtTokens: 225_000, idleCompactTokens: 150_000, modelWindowTokens: 1_000_000, parts: null, measuredAt: null, compactedAt: null }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

beforeEach(() => {
  resetChatContext()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isCompactCommand', () => {
  it('is `/compact` on its own, any case, spaces round it; nothing else', () => {
    expect(['/compact', ' /COMPACT ', '/Compact\n'].map(isCompactCommand)).toEqual([true, true, true])
    expect(['/compact now', 'please /compact', '/compacts', 'compact', '/'].map(isCompactCommand)).toEqual([false, false, false, false, false])
  })
})

describe('compactionNote', () => {
  it('says what each answer came to', () => {
    expect(compactionNote(200, { outcome: 'compacted' })).toEqual({ text: 'Compacted. The next message starts from a summary.', tone: 'muted' })
    expect(compactionNote(200, { outcome: 'requested' }).text).toBe('Compacting. It finishes in the background.')
    expect(compactionNote(200, { outcome: 'queued_behind_turn' }).text).toBe('Compacting. It finishes in the background.')
    expect(compactionNote(200, { outcome: 'already_compacted' }).text).toBe('Already compacted: nothing new since.')
    expect(compactionNote(200, { outcome: 'compacting' })).toEqual({ text: 'Already compacting. It finishes in the background.', tone: 'muted' })
    expect(compactionNote(200, { outcome: 'no_recent_step' }).text).toBe('Nothing to compact yet.')
    expect(compactionNote(200, { outcome: 'kept_history' }).tone).toBe('attention')
    expect(compactionNote(409, { error: 'x' })).toEqual({ text: 'A reply is still running. Compact once it finishes.', tone: 'attention' })
    expect(compactionNote(429, { error: 'Limit reached.' })).toEqual({ text: 'Limit reached.', tone: 'attention' })
    expect(compactionNote(500, null).text).toBe("Couldn't compact. Try again in a moment.")
    expect(compactionNote(0, null).tone).toBe('attention')
  })
})

describe('readChatContext', () => {
  it('reads once at a time, and a fresh read serves a reopen; force reads again', async () => {
    fetchMock.mockImplementation(async () => json({ context: USAGE }))
    await Promise.all([readChatContext('c-1'), readChatContext('c-1')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/account/chat/context?conversationId=c-1')
    expect(getChatContextState()).toMatchObject({ conversationId: 'c-1', loaded: true, context: USAGE })
    await readChatContext('c-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await readChatContext('c-1', { force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a read answering for a conversation the chat has left is dropped', async () => {
    let answer: (r: Response) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    const read = readChatContext('c-1')
    setContextConversation('c-2')
    answer(json({ context: USAGE }))
    await read
    expect(getChatContextState()).toMatchObject({ conversationId: 'c-2', loaded: false, context: null })
  })

  it('a failed read keeps what the card had', async () => {
    fetchMock.mockImplementationOnce(async () => json({ context: USAGE }))
    await readChatContext('c-1')
    fetchMock.mockImplementationOnce(async () => json({ error: 'x' }, 500))
    await readChatContext('c-1', { force: true })
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('offline')
    })
    await readChatContext('c-1', { force: true })
    expect(getChatContextState().context).toEqual(USAGE)
  })
})

describe('compactChatContext', () => {
  it('posts the conversation, shows it compacting, then its outcome, and reads the size again', async () => {
    const seen: boolean[] = []
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/account/chat/compact') {
        seen.push(getChatContextState().compacting)
        return json({ outcome: 'compacted' })
      }
      return json({ context: { ...USAGE, usedTokens: null, compactedAt: '2026-10-22T12:05:00.000Z' } })
    })
    setContextConversation('c-1')
    const note = await compactChatContext('c-1')
    expect(seen).toEqual([true])
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ conversationId: 'c-1' }) })
    expect(note.text).toBe('Compacted. The next message starts from a summary.')
    expect(getChatContextState()).toMatchObject({ compacting: false, note, context: { compactedAt: '2026-10-22T12:05:00.000Z' } })
  })

  it('reads the size again as after a reply: its usage row can land after the answer', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(async (url) => (url === '/api/account/chat/compact' ? json({ outcome: 'compacted' }) : json({ context: USAGE })))
      setContextConversation('c-1')
      await compactChatContext('c-1')
      const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/account/chat/context')).length
      expect(reads()).toBe(1)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(reads()).toBe(2)
      await vi.advanceTimersByTimeAsync(4_500)
      expect(reads()).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays compacting through a switch away and back, so a second click can’t send a second one', async () => {
    let answer: (r: Response) => void = () => {}
    fetchMock.mockImplementation(async (url) => (url === '/api/account/chat/compact' ? new Promise<Response>((resolve) => (answer = resolve)) : json({ context: USAGE })))
    setContextConversation('c-1')
    const first = compactChatContext('c-1')
    expect(getChatContextState().compacting).toBe(true)
    setContextConversation(null) // a bot's page up
    setContextConversation('c-1') // and back
    expect(getChatContextState().compacting).toBe(true)
    expect(await compactChatContext('c-1')).toEqual({ text: 'Already compacting.', tone: 'muted' })
    answer(json({ outcome: 'compacted' }))
    await first
    expect(getChatContextState().compacting).toBe(false)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/account/chat/compact')).toHaveLength(1)
  })

  it('another conversation’s (a bot thread’s /compact) never moves the card', async () => {
    fetchMock.mockImplementation(async (url) => (url === '/api/account/chat/compact' ? json({ outcome: 'compacted' }) : json({ context: USAGE })))
    await readChatContext('c-1')
    const note = await compactChatContext('bot-thread')
    expect(note.text).toBe('Compacted. The next message starts from a summary.')
    expect(getChatContextState()).toMatchObject({ conversationId: 'c-1', compacting: false, note: null, context: USAGE })
  })

  it('one at a time', async () => {
    let answer: (r: Response) => void = () => {}
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)))
    fetchMock.mockImplementation(async () => json({ context: USAGE }))
    setContextConversation('c-1')
    const first = compactChatContext('c-1')
    expect(await compactChatContext('c-1')).toEqual({ text: 'Already compacting.', tone: 'muted' })
    answer(json({ outcome: 'requested' }))
    expect((await first).text).toBe('Compacting. It finishes in the background.')
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/account/chat/compact')).toHaveLength(1)
  })

  it('a network failure is a note, never a throw', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/account/chat/compact') throw new TypeError('offline')
      return json({ context: USAGE })
    })
    setContextConversation('c-1')
    await expect(compactChatContext('c-1')).resolves.toEqual({ text: "Couldn't compact. Try again in a moment.", tone: 'attention' })
    expect(getChatContextState().compacting).toBe(false)
  })
})
