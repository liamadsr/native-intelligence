/**
 * Opening an email_thread mention (migration 673, decision 1): a grantee opens
 * the read-only shared viewer; the OWNER opens the thread in Mail (its index id
 * looked up to a provider thread id); neither opens nothing. The window opens
 * and the fetch are stubbed. Made-up ids.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const openTarget = vi.fn((..._a: unknown[]) => true)
vi.mock('@/lib/chat-cards/open-card', () => ({
  openTarget: (...a: unknown[]) => openTarget(...a),
  originCardOf: () => null,
}))
const openConversation = vi.fn()
vi.mock('@/lib/chat/open-conversation', () => ({ openConversation: (...a: unknown[]) => openConversation(...a) }))
const openSharedEmailThread = vi.fn()
vi.mock('@/lib/email-share/open-shared-thread', () => ({ openSharedEmailThread: (...a: unknown[]) => openSharedEmailThread(...a) }))
vi.mock('../open-entity', () => ({ entityOpenTarget: vi.fn(() => null) }))

import { openMention } from '../open-mention'

const resp = (ok: boolean, status: number, body: unknown = {}) => ({ ok, status, json: async () => body }) as Response
function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => handler(url)))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const ref = { type: 'email_thread', id: 'idx1', label: 'Harbor renewal' }

describe('openMention for email_thread', () => {
  it('a grantee opens the read-only shared viewer', async () => {
    stubFetch((url) => (url.includes('/thread-shares?thread=') ? resp(true, 200) : resp(false, 404)))
    const ok = await openMention(ref, 'chip')
    expect(ok).toBe(true)
    expect(openSharedEmailThread).toHaveBeenCalledWith('idx1')
    expect(openTarget).not.toHaveBeenCalled()
  })

  it('the owner opens the thread in Mail (openTarget with the looked-up provider thread id)', async () => {
    stubFetch((url) => {
      if (url.includes('/thread-shares?thread=')) return resp(false, 404)
      if (url.includes('/threads/lookup')) return resp(true, 200, { id: 'idx1', provider_thread_id: 'thr-1' })
      return resp(false, 404)
    })
    const ok = await openMention(ref, 'chip')
    expect(ok).toBe(true)
    expect(openTarget).toHaveBeenCalledWith({ type: 'mail', threadId: 'thr-1', title: 'Harbor renewal' }, { from: 'chip', origin: null })
    expect(openSharedEmailThread).not.toHaveBeenCalled()
  })

  it('neither a grantee nor the owner: nothing opens', async () => {
    stubFetch(() => resp(false, 404))
    const ok = await openMention(ref, 'chip')
    expect(ok).toBe(false)
    expect(openTarget).not.toHaveBeenCalled()
    expect(openSharedEmailThread).not.toHaveBeenCalled()
  })
})
