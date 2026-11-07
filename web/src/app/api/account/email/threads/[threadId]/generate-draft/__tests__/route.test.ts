import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user' } } }) } }) }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'workspace' }))
vi.mock('@/lib/crm/email-drafts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crm/email-drafts')>()),
  generateEmailDrafts: mock.generate,
}))
import { POST as single } from '../route'
import { POST as batch } from '../../../../generate-drafts/route'
const request = (body: object) => new Request('http://localhost/api/drafts', { method: 'POST', body: JSON.stringify(body) }) as never
beforeEach(() => mock.generate.mockReset().mockResolvedValue({ drafts: [{ id: 'draft' }], count: 1 }))
describe('reply draft intent at HTTP boundaries', () => {
  it('marks the specific human draft endpoint explicit', async () => {
    expect((await single(request({ tone: 'brief' }), { params: Promise.resolve({ threadId: 'thread' }) })).status).toBe(200)
    expect(mock.generate).toHaveBeenCalledWith('user', 'workspace', {
      thread_ids: ['thread'], max_drafts: 1, tone: 'brief', replyIntent: 'explicit',
    })
  })
  it('passes a tone only when one of the three was asked for: otherwise the draft writes the way the person does', async () => {
    await single(request({ tone: 'shouty' }), { params: Promise.resolve({ threadId: 'thread' }) })
    expect(mock.generate).toHaveBeenLastCalledWith('user', 'workspace', expect.objectContaining({ tone: undefined }))
    await batch(request({ tone: 'casual' }))
    expect(mock.generate).toHaveBeenLastCalledWith('user', 'workspace', expect.objectContaining({ tone: 'casual' }))
    await batch(request({}))
    expect(mock.generate).toHaveBeenLastCalledWith('user', 'workspace', expect.objectContaining({ tone: undefined }))
  })
  it('does not let batch callers bypass classification by supplying thread IDs or an intent field', async () => {
    expect((await batch(request({ thread_ids: ['thread'], replyIntent: 'explicit', max_drafts: 1 }))).status).toBe(200)
    expect(mock.generate).toHaveBeenCalledWith('user', 'workspace', {
      // Still classified (no replyIntent); marked 'chat' so it never uses the automatic cap.
      thread_ids: ['thread'], max_drafts: 1, tone: undefined, origin: 'chat',
    })
  })
})
