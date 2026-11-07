/**
 * read_chat_file / attach_chat_file hand a model-chosen storage_path to
 * service-role storage. storage-js joins it into the object URL without
 * encoding, so `<uid>/chat-uploads/../../<victim>/...` and the `%2e%2e`
 * spelling both resolve to another user's object. Only a single object name
 * directly inside the caller's own chat-uploads folder may pass.
 */
import { describe, it, expect, vi } from 'vitest'
import { wrapUntrusted } from '@/lib/email/untrusted'
import type { ToolExecutionOptions } from 'ai'
import { createAttachmentTools } from '../attachments'
import { isOwnChatUploadPath } from '@/lib/chat/upload-allowlist'

vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER = '11111111-1111-4111-8111-111111111111'
const VICTIM = '22222222-2222-4222-8222-222222222222'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const TRAVERSALS = [
  `${USER}/chat-uploads/../../${VICTIM}/chat-uploads/f.md`,
  `${USER}/chat-uploads/%2e%2e/%2e%2e/${VICTIM}/chat-uploads/f.md`,
  `${USER}/chat-uploads/%2E%2E/%2E%2E/${VICTIM}/chat-uploads/f.md`,
  `${USER}/chat-uploads/..%2f..%2f${VICTIM}/chat-uploads/f.md`,
  `${USER}/chat-uploads/..\\..\\${VICTIM}\\chat-uploads\\f.md`,
  `${USER}/chat-uploads/sub/f.md`,
  `${USER}/chat-uploads/`,
  `${VICTIM}/chat-uploads/f.md`,
]

function storageClient() {
  const download = vi.fn(async () => ({ data: new Blob(['secret']), error: null }))
  const client = {
    from: vi.fn(),
    storage: { from: vi.fn(() => ({ download })) },
  }
  return { client: client as never, download }
}

describe('isOwnChatUploadPath', () => {
  it('accepts one object in the caller folder', () => {
    expect(isOwnChatUploadPath(USER, `${USER}/chat-uploads/3f2a-9c.md`)).toBe(true)
    expect(isOwnChatUploadPath(USER, `${USER}/chat-uploads/a_b-c.1.json`)).toBe(true)
  })

  it.each(TRAVERSALS)('rejects %s', (p) => {
    expect(isOwnChatUploadPath(USER, p)).toBe(false)
  })
})

describe('read_chat_file traversal guard', () => {
  it.each(TRAVERSALS)('never downloads %s', async (storage_path) => {
    const { client, download } = storageClient()
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.read_chat_file.execute!({ storage_path }, EXEC)) as { success: boolean }
    expect(res.success).toBe(false)
    expect(download).not.toHaveBeenCalled()
  })

  it('still reads the caller\'s own upload', async () => {
    const { client, download } = storageClient()
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.read_chat_file.execute!({ storage_path: `${USER}/chat-uploads/abc.md` }, EXEC)) as {
      success: boolean
      content?: string
    }
    expect(res).toMatchObject({ success: true, content: wrapUntrusted('secret', 'FILE') })
    expect(download).toHaveBeenCalledWith(`${USER}/chat-uploads/abc.md`)
  })
})

describe('attach_chat_file traversal guard', () => {
  it.each(TRAVERSALS)('never registers %s', async (storage_path) => {
    const { client } = storageClient()
    const tools = createAttachmentTools(USER, client, 'ws-1')
    const res = (await tools.attach_chat_file.execute!(
      { storage_path, file_name: 'f.md', file_size: 1, mime_type: 'text/markdown', capture_id: 'cap-1' },
      EXEC,
    )) as { success: boolean }
    expect(res.success).toBe(false)
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })
})
