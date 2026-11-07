import { describe, it, expect, vi, beforeEach } from 'vitest'

const USER = '11111111-1111-4111-8111-111111111111'
const VICTIM = '22222222-2222-4222-8222-222222222222'

const list = vi.fn()
const createSignedUrl = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
    storage: { from: () => ({ list, createSignedUrl, remove: vi.fn(async () => ({})) }) },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))

import { POST } from '../route'

function req(body: unknown) {
  return new Request('http://localhost/api/ai/chat/upload', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as never
}

describe('POST /api/ai/chat/upload path guard', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue({ data: [{ name: 'abc.md', metadata: { size: 5 } }], error: null })
    createSignedUrl.mockReset().mockResolvedValue({ data: { signedUrl: 'https://signed' }, error: null })
  })

  it.each([
    `${USER}/chat-uploads/../../${VICTIM}/chat-uploads/abc.md`,
    `${USER}/chat-uploads/%2e%2e/%2e%2e/${VICTIM}/chat-uploads/abc.md`,
    `${USER}/chat-uploads/nested/abc.md`,
  ])('rejects %s before touching storage', async (storage_path) => {
    const res = await POST(req({ storage_path, file_name: 'abc.md' }))
    expect(res.status).toBe(400)
    expect(list).not.toHaveBeenCalled()
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('accepts the caller\'s own upload', async () => {
    const res = await POST(req({ storage_path: `${USER}/chat-uploads/abc.md`, file_name: 'abc.md' }))
    expect(res.status).toBe(200)
    expect(createSignedUrl).toHaveBeenCalledWith(`${USER}/chat-uploads/abc.md`, 3600)
  })
})
