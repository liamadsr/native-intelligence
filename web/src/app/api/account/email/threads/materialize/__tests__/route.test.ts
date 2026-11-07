/**
 * POST /api/account/email/threads/materialize: indexes a search result for the
 * caller in the current workspace (materializeSearchHit) and maps the outcome:
 * the row id, 404 for a mailbox it can't read or a thread that's gone, 400 for
 * a malformed body.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const materializeSearchHit = vi.fn()
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: {}, user: { id: 'u1' }, workspaceId: 'ws-a' }) }))
vi.mock('@/lib/email/materialize-thread', () => ({ materializeSearchHit }))

const { POST } = await import('../route')
const post = (body: unknown) =>
  POST(new Request('http://x/api/account/email/threads/materialize', { method: 'POST', body: JSON.stringify(body) }) as never)

beforeEach(() => materializeSearchHit.mockReset())

describe('POST /api/account/email/threads/materialize', () => {
  it('indexes the hit for the caller in this workspace and returns its row id', async () => {
    materializeSearchHit.mockResolvedValue({ ok: true, id: 'idx-1', created: true })
    const res = await post({ threadId: 'thr-old', accountId: 'acct-g' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'idx-1' })
    expect(materializeSearchHit).toHaveBeenCalledWith({ userId: 'u1', workspaceId: 'ws-a', accountId: 'acct-g', threadId: 'thr-old' })
  })

  it("a mailbox this workspace can't read, or a gone thread, is not found", async () => {
    materializeSearchHit.mockResolvedValue({ ok: false, reason: 'not_readable' })
    expect((await post({ threadId: 't', accountId: 'a' })).status).toBe(404)
    materializeSearchHit.mockResolvedValue({ ok: false, reason: 'gone' })
    expect((await post({ threadId: 't', accountId: 'a' })).status).toBe(404)
  })

  it('a malformed body is refused without a lookup', async () => {
    expect((await post({ threadId: 't' })).status).toBe(400)
    expect((await post({ threadId: '', accountId: 'a' })).status).toBe(400)
    expect(materializeSearchHit).not.toHaveBeenCalled()
  })
})
