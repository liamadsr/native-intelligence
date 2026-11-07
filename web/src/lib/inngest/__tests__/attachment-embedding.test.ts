/**
 * Tests for the attachment-index Inngest function — slice 0 of context
 * packages widened it from images+PDFs (filename-only chunk_text) to real
 * text extraction for pdf/docx/pptx/plain-text formats.
 *
 * Covers the per-format branches: image (unchanged single multimodal chunk),
 * pdf with text layer (multimodal chunk + text chunks, filename kept as
 * chunk 0's text so ingest_source never sees duplicated head content),
 * oversized pdf (embedPdf throws → text chunks still land), scanned pdf
 * (no text → old behavior), plain text (chunked + embedded), near-empty
 * text (terminal 'unsupported', NOT 'failed'), unsupported extension, and
 * the delete-before-insert reindex ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

const hoisted = vi.hoisted(() => ({
  attachmentRow: {} as Record<string, unknown>,
  statusUpdates: [] as Array<Record<string, unknown>>,
  insertedChunks: [] as Array<Record<string, unknown>>,
  ops: [] as string[],
  downloadBytes: Buffer.from('irrelevant'),
  embedImage: vi.fn(async () => [0.1, 0.2]),
  embedPdf: vi.fn(async () => [0.3, 0.4]),
  embedText: vi.fn(async () => [0.5, 0.6]),
  extractAttachmentText: vi.fn(async (): Promise<string | null> => null),
}))

vi.mock('./client', () => ({
  inngest: {
    createFunction: vi.fn((...args: unknown[]) => ({
      handler: args[args.length - 1],
    })),
  },
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((...args: unknown[]) => ({
      handler: args[args.length - 1],
    })),
  },
}))
vi.mock('@/lib/inngest/usage-guard', () => ({ guardBackgroundUsageOnPlan: vi.fn(async () => ({ chatgptPlan: false })) }))
vi.mock('@/lib/ai/gemini-embeddings', () => ({
  embedImage: hoisted.embedImage,
  embedPdf: hoisted.embedPdf,
  embedText: hoisted.embedText,
  EMBEDDABLE_EXTENSIONS: new Set(['png', 'jpg', 'jpeg', 'pdf']),
}))
vi.mock('@/lib/attachments/extract-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/extract-text')>()
  return {
    ...actual,
    extractAttachmentText: hoisted.extractAttachmentText,
  }
})
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'attachments') {
        const chain = {
          update: (payload: Record<string, unknown>) => {
            hoisted.statusUpdates.push(payload)
            return chain
          },
          select: () => chain,
          eq: () => chain,
          single: async () => ({ data: hoisted.attachmentRow, error: null }),
        }
        return chain
      }
      if (table === 'attachment_chunks') {
        const chain = {
          delete: () => {
            hoisted.ops.push('delete-chunks')
            return chain
          },
          insert: async (rows: Array<Record<string, unknown>>) => {
            hoisted.ops.push('insert-chunks')
            hoisted.insertedChunks.push(...rows)
            return { error: null }
          },
          eq: () => chain,
        }
        return chain
      }
      throw new Error(`unexpected table ${table}`)
    },
    storage: {
      from: () => ({
        download: async () => ({
          data: { arrayBuffer: async () => hoisted.downloadBytes },
          error: null,
        }),
      }),
    },
  }),
}))

const mod = await import('@/lib/inngest/attachment-embedding')
const handler = (mod.attachmentIndex as unknown as { handler: Function }).handler

function makeEvent(over: Partial<Record<string, unknown>> = {}) {
  return {
    event: {
      data: {
        attachmentId: 'att-1',
        userId: 'user-1',
        workspaceId: 'ws-1',
        projectId: null,
        ...over,
      },
    },
    step: createStepMock(),
  }
}

function setAttachment(over: Partial<Record<string, unknown>> = {}) {
  hoisted.attachmentRow = {
    id: 'att-1',
    file_name: 'deck.pdf',
    mime_type: 'application/pdf',
    file_extension: 'pdf',
    file_size_bytes: 1000,
    storage_path: 'ws-1/att-1',
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.statusUpdates = []
  hoisted.insertedChunks = []
  hoisted.ops = []
  hoisted.extractAttachmentText.mockResolvedValue(null)
})

describe('attachment-index — per-format branches', () => {
  it('image: single multimodal chunk with filename text', async () => {
    setAttachment({ file_name: 'shot.png', mime_type: 'image/png', file_extension: 'png' })
    const ctx = makeEvent()
    const out = await handler(ctx)
    expect(out.status).toBe('completed')
    expect(hoisted.embedImage).toHaveBeenCalledOnce()
    expect(hoisted.insertedChunks).toHaveLength(1)
    expect(hoisted.insertedChunks[0]).toMatchObject({
      chunk_index: 0,
      chunk_text: 'shot.png',
      chunk_type: 'image',
    })
  })

  it('pdf with text layer: multimodal chunk keeps FILENAME text; text chunks follow', async () => {
    setAttachment()
    hoisted.extractAttachmentText.mockResolvedValue('T'.repeat(5000))
    const out = await handler(makeEvent())
    expect(out).toMatchObject({ status: 'completed', chunksCreated: 3 })
    expect(hoisted.insertedChunks[0]).toMatchObject({
      chunk_index: 0,
      chunk_text: 'deck.pdf', // NOT the text head — ingest_source concatenates chunk_text
      chunk_type: 'full',
    })
    expect(hoisted.insertedChunks[1]).toMatchObject({ chunk_index: 1, chunk_type: 'text' })
    expect(hoisted.insertedChunks[2]).toMatchObject({ chunk_index: 2, chunk_type: 'text' })
    expect(hoisted.embedText).toHaveBeenCalledTimes(2)
  })

  it('oversized pdf (embedPdf throws) still indexes its text chunks', async () => {
    setAttachment()
    hoisted.embedPdf.mockRejectedValueOnce(new Error('PDF too large for embedding'))
    hoisted.extractAttachmentText.mockResolvedValue('T'.repeat(4000))
    const out = await handler(makeEvent())
    expect(out.status).toBe('completed')
    expect(hoisted.insertedChunks.every((c) => c.chunk_type === 'text')).toBe(true)
    expect(hoisted.insertedChunks[0].chunk_index).toBe(0)
    expect(hoisted.statusUpdates.at(-1)).toMatchObject({ embedding_status: 'completed' })
  })

  it('oversized pdf with NO text layer fails (nothing to index)', async () => {
    setAttachment()
    hoisted.embedPdf.mockRejectedValueOnce(new Error('PDF too large for embedding'))
    await expect(handler(makeEvent())).rejects.toThrow('PDF too large')
    expect(hoisted.statusUpdates.at(-1)).toMatchObject({ embedding_status: 'failed' })
  })

  it('scanned pdf (no text layer): degrades to the old single-chunk behavior', async () => {
    setAttachment()
    const out = await handler(makeEvent())
    expect(out).toMatchObject({ status: 'completed', chunksCreated: 1 })
    expect(hoisted.insertedChunks[0]).toMatchObject({
      chunk_text: 'deck.pdf',
      chunk_type: 'full',
    })
    expect(hoisted.embedText).not.toHaveBeenCalled()
  })

  it('plain text file: chunked text embeddings, no multimodal call', async () => {
    setAttachment({ file_name: 'notes.md', mime_type: 'text/markdown', file_extension: 'md' })
    hoisted.extractAttachmentText.mockResolvedValue('hello world, enough text to index')
    const out = await handler(makeEvent())
    expect(out).toMatchObject({ status: 'completed', chunksCreated: 1 })
    expect(hoisted.embedPdf).not.toHaveBeenCalled()
    expect(hoisted.insertedChunks[0]).toMatchObject({ chunk_index: 0, chunk_type: 'text' })
  })

  it("near-empty text file: terminal 'unsupported', never 'failed'", async () => {
    setAttachment({ file_name: 'tiny.csv', mime_type: 'text/csv', file_extension: 'csv' })
    hoisted.extractAttachmentText.mockResolvedValue(null)
    const out = await handler(makeEvent())
    expect(out.status).toBe('unsupported')
    expect(hoisted.insertedChunks).toHaveLength(0)
    expect(hoisted.statusUpdates.at(-1)).toMatchObject({ embedding_status: 'unsupported' })
    expect(hoisted.statusUpdates.every((u) => u.embedding_status !== 'failed')).toBe(true)
  })

  it('unknown extension: marked unsupported before any download', async () => {
    setAttachment({ file_name: 'app.exe', mime_type: 'application/x-thing', file_extension: 'exe' })
    const out = await handler(makeEvent())
    expect(out.status).toBe('unsupported')
    expect(hoisted.ops).toHaveLength(0)
  })
})

describe('attachment-index — mechanics', () => {
  it('deletes existing chunks before inserting (idempotent reindex)', async () => {
    setAttachment({ file_name: 'n.txt', mime_type: 'text/plain', file_extension: 'txt' })
    hoisted.extractAttachmentText.mockResolvedValue('enough text to be meaningfully indexed here')
    await handler(makeEvent())
    expect(hoisted.ops).toEqual(['delete-chunks', 'insert-chunks'])
  })

  it('fires reference-ingest only for project-attached PDFs', async () => {
    setAttachment()
    hoisted.extractAttachmentText.mockResolvedValue('T'.repeat(100))
    const withProject = makeEvent({ projectId: 'proj-1' })
    await handler(withProject)
    expect(withProject.step.sendEvent).toHaveBeenCalledWith(
      'send-reference-ingest',
      expect.objectContaining({ name: 'reference/ingest' }),
    )

    hoisted.extractAttachmentText.mockResolvedValue('T'.repeat(100))
    const noProject = makeEvent({ projectId: null })
    await handler(noProject)
    expect(noProject.step.sendEvent).not.toHaveBeenCalled()
  })
})
