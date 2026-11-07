/**
 * The idle-compaction activity signal (src/lib/chat/idle-compaction-signal.ts).
 * Pinned: it sends `chat/session.activity` keyed by the conversation, with
 * ids only (no credential of any kind); mint and typing signals go at most
 * once a minute per conversation, a finished turn always; it runs after the
 * response; and a failed send never throws. allowPresencePing: at most 10
 * presence pings a minute per person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const send = vi.fn(async (_e: unknown): Promise<unknown> => undefined)
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (e: unknown) => send(e) } }))

const afterTasks: Array<() => unknown> = []
vi.mock('next/server', () => ({ after: (task: () => unknown) => afterTasks.push(task) }))

import {
  CHAT_SESSION_ACTIVITY_EVENT,
  PRESENCE_USER_LIMIT,
  allowPresencePing,
  resetChatActivityThrottle,
  signalChatSessionActivity,
} from '../idle-compaction-signal'

const BIND = { conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ws-1' }

async function flush() {
  for (const task of afterTasks.splice(0)) await task()
}
const sent = () => send.mock.calls.map(([e]) => e as { name: string; data: Record<string, unknown> })

beforeEach(() => {
  send.mockReset()
  send.mockResolvedValue(undefined)
  afterTasks.length = 0
  resetChatActivityThrottle()
})

describe('signalChatSessionActivity', () => {
  it('sends the activity event after the response, ids and source only', async () => {
    signalChatSessionActivity({ ...BIND, source: 'turn' })
    expect(send).not.toHaveBeenCalled()
    await flush()
    const [event] = sent()
    expect(event.name).toBe(CHAT_SESSION_ACTIVITY_EVENT)
    expect(event.data).toEqual({ ...BIND, source: 'turn' })
  })

  it('never forwards anything else a caller passes (no cred, jwt or bearer)', async () => {
    signalChatSessionActivity({ ...BIND, source: 'typing', cred: 'x', jwt: 'eyJ.x.y', bearer: 'b' } as never)
    await flush()
    expect(Object.keys(sent()[0].data).sort()).toEqual(['conversationId', 'source', 'userId', 'workspaceId'])
  })

  it('mint and typing share a once-a-minute throttle per conversation; a finished turn always goes', async () => {
    const now = 1_000_000
    signalChatSessionActivity({ ...BIND, source: 'typing', now })
    signalChatSessionActivity({ ...BIND, source: 'mint', now: now + 30_000 })
    signalChatSessionActivity({ ...BIND, source: 'typing', now: now + 59_000 })
    signalChatSessionActivity({ ...BIND, conversationId: 'conv-2', source: 'mint', now: now + 59_000 })
    signalChatSessionActivity({ ...BIND, source: 'turn', now: now + 59_500 })
    signalChatSessionActivity({ ...BIND, source: 'typing', now: now + 61_000 })
    await flush()
    expect(sent().map((e) => [e.data.conversationId, e.data.source])).toEqual([
      ['conv-1', 'typing'],
      ['conv-2', 'mint'],
      ['conv-1', 'turn'],
      ['conv-1', 'typing'],
    ])
  })

  it('a failed send never throws', async () => {
    send.mockRejectedValueOnce(new Error('inngest down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => signalChatSessionActivity({ ...BIND, source: 'turn' })).not.toThrow()
    await expect(flush()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[idle-compaction] activity signal failed:', 'inngest down')
    warn.mockRestore()
  })
})

describe('allowPresencePing', () => {
  it('takes 10 a minute per person, then refuses until the minute is up; people are separate', () => {
    const now = 5_000_000
    expect(PRESENCE_USER_LIMIT).toBe(10)
    for (let i = 0; i < 10; i++) expect(allowPresencePing('user-1', now + i)).toBe(true)
    expect(allowPresencePing('user-1', now + 30_000)).toBe(false)
    expect(allowPresencePing('user-2', now + 30_000)).toBe(true)
    expect(allowPresencePing('user-1', now + 60_000)).toBe(true)
  })
})
