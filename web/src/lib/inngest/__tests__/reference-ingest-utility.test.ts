/**
 * reference/ingest on the eve utility agent (WS-4 item 10).
 *
 * Pinned:
 *   - both model calls (classify+overview, per-segment structuring) go through
 *     runUtilityTask with their kinds, the caller's workspace/user, the same
 *     Zod schemas, and a message that is the PDF FILE PART followed by the
 *     same text the pre-port call sent;
 *   - the PDF rides inline (base64 data: URL) when small; a large segment goes
 *     by signed URL — of the attachment itself when the segment IS the whole
 *     file (nothing written), else of a temporary copy at a deterministic
 *     per-run, per-page-range path (upsert, so a retry overwrites it) that is
 *     removed after the call, success or failure — under `_system/`, never a
 *     user's own storage prefix;
 *   - each step's model timeout is measured from the step's start, so the
 *     download / slice / upload plus the call and its cancel fit in 300s;
 *   - the handler takes those paths on real multi-megabyte PDFs: a sliced
 *     segment of a multi-segment document NEVER gets the whole attachment's
 *     URL, a single-segment document does, and a failed segment call still
 *     removes its temporary copy;
 *   - a classify failure still throws out of the step (Inngest retries);
 *   - the 20 MiB gate stays Next-side (nothing is downloaded or sent above
 *     it), the job still logs no usage, and both kinds run on the
 *     Anthropic-only 'document_ingest' surface (the model reads the PDF).
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName } from 'pdf-lib'

const hoisted = vi.hoisted(() => ({
  createFunction: vi.fn((..._a: unknown[]) => ({})),
  runUtilityTask: vi.fn(),
  logUsage: vi.fn(async (..._a: unknown[]) => {}),
}))

vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: hoisted.createFunction } }))
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: hoisted.runUtilityTask }))
// Any usage write reached from the job (directly, aliased or through a helper)
// lands here; every handler run in this file asserts it never happens.
vi.mock('@/lib/ai/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/auth')>()),
  logUsage: hoisted.logUsage,
}))
vi.mock('../usage-guard', () => ({ guardBackgroundUsage: vi.fn(async () => {}) }))
vi.mock('@/lib/ai/embeddings', () => ({ indexDocument: vi.fn() }))
vi.mock('@/lib/wiki/wikilinks', () => ({ syncDocumentLinks: vi.fn() }))

const storage = {
  download: vi.fn(),
  upload: vi.fn(async (..._a: unknown[]) => ({ error: null })),
  createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}?sig=1` }, error: null })),
  remove: vi.fn(async (..._a: unknown[]) => ({ error: null })),
}

const attachmentRow = {
  id: 'att-1',
  file_name: 'spec.pdf',
  mime_type: 'application/pdf',
  file_size_bytes: 1000,
  storage_path: 'user-1/att-1.pdf',
  workspace_id: 'ws-1',
}

function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'in', 'contains']) c[m] = () => c
  c.maybeSingle = async () => ({ data: result })
  return c
}

const supabase = {
  from: (table: string) => chain(table === 'attachments' ? attachmentRow : null),
  storage: { from: () => storage },
}
vi.mock('@/lib/admin', () => ({ getServiceClient: () => supabase }))

const { INLINE_PDF_MAX_BYTES, SEGMENT_PDF_PAGES, pdfSegmentFilePart, stepModelTimeoutMs } = await import(
  '../reference-ingest'
)
const { UTILITY_KIND_SPECS } = await import('@/lib/eve/utility/spec')
const { SURFACE_MODELS } = await import('@/lib/ai/model-defaults')
const { STRONG_MODEL, getModelProvider } = await import('@/lib/ai/models')

type Handler = (args: { event: { data: unknown }; step: unknown; runId: string }) => Promise<Record<string, unknown>>
const handler = (hoisted.createFunction.mock.calls[0] as unknown[])[1] as Handler

async function pdfWithPages(n: number, padBytesPerPage = 0): Promise<Buffer> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < n; i++) {
    const page = doc.addPage()
    if (padBytesPerPage > 0) {
      // Incompressible bytes hung off each page, so every page range really is
      // this big and copyPages carries the padding into each slice.
      const pad = doc.context.register(doc.context.stream(new Uint8Array(randomBytes(padBytesPerPage))))
      page.node.set(PDFName.of('NiTestPad'), pad)
    }
  }
  return Buffer.from(await doc.save())
}

function serve(pdf: Buffer) {
  storage.download.mockResolvedValue({ data: new Blob([new Uint8Array(pdf)]), error: null })
}

const step = {
  run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  sendEvent: vi.fn(),
}
const event = { data: { workspaceId: 'ws-1', userId: 'user-1', attachmentId: 'att-1', projectId: null } }
const runId = 'run-1'

// The port adds no billing: no handler run below writes a usage row.
afterEach(() => {
  expect(hoisted.logUsage).not.toHaveBeenCalled()
  hoisted.logUsage.mockClear()
})

beforeEach(async () => {
  hoisted.runUtilityTask.mockReset()
  storage.upload.mockClear()
  storage.createSignedUrl.mockClear()
  storage.remove.mockClear()
  serve(await pdfWithPages(2))
})

describe('reference-ingest model calls run on the utility agent', () => {
  it('classify: kind, tenancy, schema, and the [pdf file part, text] message', async () => {
    hoisted.runUtilityTask.mockResolvedValueOnce({
      object: { is_reference: false, doc_kind: 'other', title: 'Deck', overview_markdown: '' },
    })
    const out = await handler({ event, step, runId })
    expect(out).toEqual({ status: 'skipped', reason: 'not_reference', doc_kind: 'other' })

    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(1)
    const args = hoisted.runUtilityTask.mock.calls[0][0] as Record<string, unknown>
    expect(args).toMatchObject({ kind: 'reference_ingest_outline', supabase, workspaceId: 'ws-1', userId: 'user-1' })
    const schema = args.outputSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
    // The pre-port OutlineResult: overview_markdown defaults to ''.
    expect(schema.safeParse({ is_reference: true, doc_kind: 'api_spec', title: 'X' }).data).toEqual({
      is_reference: true,
      doc_kind: 'api_spec',
      title: 'X',
      overview_markdown: '',
    })
    const message = args.message as Array<Record<string, unknown>>
    expect(message).toHaveLength(2)
    expect(message[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' })
    expect(String(message[0].data)).toMatch(/^data:application\/pdf;base64,JVBER/)
    // One segment → no "(showing pages …)" suffix, exactly as before.
    expect(message[1]).toEqual({ type: 'text', text: 'File name: spec.pdf' })
  })

  it('segments: one structuring call per segment with the pre-port text', async () => {
    hoisted.runUtilityTask
      .mockResolvedValueOnce({
        object: { is_reference: true, doc_kind: 'api_spec', title: 'Boutique API', overview_markdown: 'o' },
      })
      .mockResolvedValueOnce({ object: { pages: [] } })
    const out = await handler({ event, step, runId })
    // No pages → stops before any document write.
    expect(out).toEqual({ status: 'skipped', reason: 'no_pages', doc_kind: 'api_spec' })

    const args = hoisted.runUtilityTask.mock.calls[1][0] as Record<string, unknown>
    expect(args).toMatchObject({ kind: 'reference_ingest_segment', workspaceId: 'ws-1', userId: 'user-1' })
    const message = args.message as Array<Record<string, unknown>>
    expect(message[0]).toMatchObject({ type: 'file', mediaType: 'application/pdf' })
    expect(message[1]).toEqual({
      type: 'text',
      text: 'Document: Boutique API (api_spec). This excerpt is pages 1–2 of 2.',
    })
    const schema = args.outputSchema as { safeParse: (v: unknown) => { data?: unknown } }
    expect(schema.safeParse({}).data).toEqual({ pages: [] })
  })

  it('a PDF over 20 MiB is skipped Next-side, before any download or model call', async () => {
    const saved = attachmentRow.file_size_bytes
    storage.download.mockClear()
    attachmentRow.file_size_bytes = 20 * 1024 * 1024 + 1
    try {
      expect(await handler({ event, step, runId })).toEqual({ status: 'skipped', reason: 'too_large' })
    } finally {
      attachmentRow.file_size_bytes = saved
    }
    expect(storage.download).not.toHaveBeenCalled()
    expect(hoisted.runUtilityTask).not.toHaveBeenCalled()
  })

  it('logs no usage, as before the port, and calls no model outside the utility agent', () => {
    const src = readFileSync(join(__dirname, '../reference-ingest.ts'), 'utf8')
    expect(src).not.toMatch(/\blogUsage\s*\(/)
    expect(src).not.toMatch(/from ['"]@\/lib\/ai\/auth['"]/)
    expect(src).not.toMatch(/\bgenerate(Object|Text)\b|\bstreamText\b/)
    // The surface both kinds resolve on reads PDFs: Anthropic only.
    expect(UTILITY_KIND_SPECS.reference_ingest_outline.surface).toBe('document_ingest')
    expect(UTILITY_KIND_SPECS.reference_ingest_segment.surface).toBe('document_ingest')
    // The PDF is sent to the model itself: the Strong tier, an Anthropic model that reads PDFs.
    expect(SURFACE_MODELS.document_ingest).toBe(STRONG_MODEL)
    expect(getModelProvider(SURFACE_MODELS.document_ingest)).toBe('anthropic')
  })

  it('a failed classify call throws out of the step', async () => {
    hoisted.runUtilityTask.mockRejectedValueOnce(new Error('[utility] reference_ingest_outline session failed'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(handler({ event, step, runId })).rejects.toThrow(/session failed/)
    err.mockRestore()
  })
})

describe('reference-ingest handler — large PDFs (signed-URL paths)', () => {
  const TMP_1_25 = '_system/reference-ingest-tmp/att-1/run-1/1-25.pdf'
  const reference = { is_reference: true, doc_kind: 'api_spec', title: 'Boutique API', overview_markdown: 'o' }
  const fileData = (call: number) =>
    String(((hoisted.runUtilityTask.mock.calls[call][0] as { message: Array<{ data?: unknown }> }).message[0]).data)

  it('a multi-segment document: each sliced segment rides a temp copy, never the whole attachment', async () => {
    // 30 pages × 150 KB: pages 1–25 ≈ 3.75 MB (> INLINE_PDF_MAX_BYTES), 26–30 ≈ 0.75 MB.
    serve(await pdfWithPages(SEGMENT_PDF_PAGES + 5, 150_000))
    hoisted.runUtilityTask
      .mockResolvedValueOnce({ object: reference })
      .mockResolvedValueOnce({ object: { pages: [] } })
      .mockResolvedValueOnce({ object: { pages: [] } })
    const out = await handler({ event, step, runId })
    expect(out).toEqual({ status: 'skipped', reason: 'no_pages', doc_kind: 'api_spec' })
    expect(hoisted.runUtilityTask).toHaveBeenCalledTimes(3)

    // classify (pages 1–25) and segment 1 (pages 1–25): the temp copy's URL.
    expect(fileData(0)).toBe(`https://storage.test/${TMP_1_25}?sig=1`)
    expect(fileData(1)).toBe(`https://storage.test/${TMP_1_25}?sig=1`)
    for (const call of [0, 1, 2]) expect(fileData(call)).not.toContain('user-1/att-1.pdf')
    // segment 2 (pages 26–30) is small enough to go inline.
    expect(fileData(2)).toMatch(/^data:application\/pdf;base64,/)

    // The pre-port text parts, byte for byte: the classify call names the
    // first segment's range (multi-segment only), each structuring call its own.
    const textPart = (call: number) =>
      (hoisted.runUtilityTask.mock.calls[call][0] as { message: unknown[] }).message[1]
    expect(textPart(0)).toEqual({ type: 'text', text: 'File name: spec.pdf (showing pages 1–25 of 30)' })
    expect(textPart(1)).toEqual({
      type: 'text',
      text: 'Document: Boutique API (api_spec). This excerpt is pages 1–25 of 30.',
    })
    expect(textPart(2)).toEqual({
      type: 'text',
      text: 'Document: Boutique API (api_spec). This excerpt is pages 26–30 of 30.',
    })

    // Uploaded (upsert) for each call that needed it, and removed after each.
    expect(storage.upload.mock.calls.map((c) => [c[0], (c[2] as { upsert: boolean }).upsert])).toEqual([
      [TMP_1_25, true],
      [TMP_1_25, true],
    ])
    const uploaded = storage.upload.mock.calls[0][1] as Buffer
    expect(uploaded.length).toBeGreaterThan(INLINE_PDF_MAX_BYTES)
    expect((await PDFDocument.load(new Uint8Array(uploaded))).getPageCount()).toBe(SEGMENT_PDF_PAGES)
    expect(storage.remove.mock.calls).toEqual([[[TMP_1_25]], [[TMP_1_25]]])
  })

  it('a single-segment document over the inline limit rides the attachment’s own signed URL', async () => {
    // 20 pages × 200 KB ≈ 4 MB, one segment = the whole stored file.
    serve(await pdfWithPages(20, 200_000))
    hoisted.runUtilityTask
      .mockResolvedValueOnce({ object: reference })
      .mockResolvedValueOnce({ object: { pages: [] } })
    await handler({ event, step, runId })
    expect(fileData(0)).toBe('https://storage.test/user-1/att-1.pdf?sig=1')
    expect(fileData(1)).toBe('https://storage.test/user-1/att-1.pdf?sig=1')
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('a failed segment call still removes its temp copy, and the step throws', async () => {
    serve(await pdfWithPages(SEGMENT_PDF_PAGES + 5, 150_000))
    hoisted.runUtilityTask
      .mockResolvedValueOnce({ object: reference })
      .mockRejectedValueOnce(new Error('[utility] reference_ingest_segment timed out after 270000ms'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(handler({ event, step, runId })).rejects.toThrow(/timed out/)
    err.mockRestore()
    // classify's copy, then segment 1's — both removed despite the throw.
    expect(storage.remove.mock.calls).toEqual([[[TMP_1_25]], [[TMP_1_25]]])
  })

  it('a failed classify call still removes its temp copy', async () => {
    serve(await pdfWithPages(SEGMENT_PDF_PAGES + 5, 150_000))
    hoisted.runUtilityTask.mockRejectedValueOnce(new Error('[utility] reference_ingest_outline session failed'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(handler({ event, step, runId })).rejects.toThrow(/session failed/)
    err.mockRestore()
    expect(storage.remove.mock.calls).toEqual([[[TMP_1_25]]])
  })
})

describe('reference-ingest model timeouts fit the 300s step', () => {
  const SEGMENT_DEFAULT = UTILITY_KIND_SPECS.reference_ingest_segment.timeoutMs
  const OUTLINE_DEFAULT = UTILITY_KIND_SPECS.reference_ingest_outline.timeoutMs

  it('stepModelTimeoutMs: the kind default when the pre-work was quick, less when it was not, never under 30s', () => {
    const t0 = 1_000_000
    expect(stepModelTimeoutMs(SEGMENT_DEFAULT, t0, t0 + 2_000)).toBe(SEGMENT_DEFAULT)
    expect(stepModelTimeoutMs(OUTLINE_DEFAULT, t0, t0 + 60_000)).toBe(OUTLINE_DEFAULT)
    // 60s of download/slice/upload: the call gets what is left of 285s.
    expect(stepModelTimeoutMs(SEGMENT_DEFAULT, t0, t0 + 60_000)).toBe(225_000)
    expect(stepModelTimeoutMs(SEGMENT_DEFAULT, t0, t0 + 280_000)).toBe(30_000)
    // Pre-work + model call + the ≤5s post-timeout cancel stays under 300s.
    for (const pre of [0, 15_000, 24_000, 100_000, 250_000]) {
      expect(pre + stepModelTimeoutMs(SEGMENT_DEFAULT, t0, t0 + pre) + 5_000).toBeLessThanOrEqual(290_000)
    }
  })

  it('each step passes a timeout measured from the START of that step, not the kind default', async () => {
    let clock = 5_000_000
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    // Every download takes 100s of the step.
    const pdf = await pdfWithPages(2)
    storage.download.mockImplementation(async () => {
      clock += 100_000
      return { data: new Blob([new Uint8Array(pdf)]), error: null }
    })
    hoisted.runUtilityTask
      .mockResolvedValueOnce({
        object: { is_reference: true, doc_kind: 'api_spec', title: 'Boutique API', overview_markdown: 'o' },
      })
      .mockResolvedValueOnce({ object: { pages: [] } })
    try {
      await handler({ event, step, runId })
    } finally {
      now.mockRestore()
      serve(await pdfWithPages(2))
    }
    const timeouts = hoisted.runUtilityTask.mock.calls.map((c) => (c[0] as { timeoutMs?: number }).timeoutMs)
    // classify: min(150s default, 285s − 100s); segment: 285s − 100s < its 270s default.
    expect(timeouts).toEqual([OUTLINE_DEFAULT, 185_000])
  })
})

describe('pdfSegmentFilePart', () => {
  const base = {
    supabase: supabase as never,
    storagePath: 'user-1/att-1.pdf',
    attachmentId: 'att-1',
    runId: 'run-1',
    from: 26,
    to: 50,
  }

  it('inlines a small segment as a data: URL and stores nothing', async () => {
    const bytes = Buffer.from('%PDF-1.7 small')
    const { part, cleanup } = await pdfSegmentFilePart({ ...base, bytes, wholeFile: false })
    expect(part).toEqual({
      type: 'file',
      mediaType: 'application/pdf',
      data: `data:application/pdf;base64,${bytes.toString('base64')}`,
    })
    await cleanup()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('a large segment that is the whole file → signed URL of the attachment itself, nothing stored', async () => {
    const bytes = Buffer.alloc(INLINE_PDF_MAX_BYTES + 1)
    const { part, cleanup } = await pdfSegmentFilePart({ ...base, bytes, wholeFile: true })
    expect(part).toEqual({
      type: 'file',
      mediaType: 'application/pdf',
      data: 'https://storage.test/user-1/att-1.pdf?sig=1',
    })
    await cleanup()
    expect(storage.upload).not.toHaveBeenCalled()
    expect(storage.remove).not.toHaveBeenCalled()
  })

  it('a large sliced segment → temporary copy under the _system prefix, signed, removed by cleanup', async () => {
    const bytes = Buffer.alloc(INLINE_PDF_MAX_BYTES + 1)
    const { part, cleanup } = await pdfSegmentFilePart({ ...base, bytes, wholeFile: false })
    const [path, body, opts] = storage.upload.mock.calls[0] as [string, Buffer, Record<string, unknown>]
    // Deterministic per run + page range, and overwritten on retry: a step
    // killed before its `finally` leaves at most this one object behind.
    expect(path).toBe('_system/reference-ingest-tmp/att-1/run-1/26-50.pdf')
    // Never under a user's own prefix: the bucket's owner policies key on the
    // first folder, and the triggering user may not own the attachment.
    expect(path.split('/')[0]).toBe('_system')
    expect(body).toBe(bytes)
    expect(opts).toEqual({ contentType: 'application/pdf', upsert: true })
    expect(part.data).toBe(`https://storage.test/${path}?sig=1`)
    expect(storage.remove).not.toHaveBeenCalled()
    await cleanup()
    expect(storage.remove).toHaveBeenCalledWith([path])
  })

  it('a signing failure removes the temporary copy and throws', async () => {
    storage.createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'nope' } } as never)
    const bytes = Buffer.alloc(INLINE_PDF_MAX_BYTES + 1)
    await expect(pdfSegmentFilePart({ ...base, bytes, wholeFile: false })).rejects.toThrow(/sign PDF segment/)
    expect(storage.remove).toHaveBeenCalledTimes(1)
  })

  it('keeps the inline body under the 4.5 MB function request limit', () => {
    // base64 inflates 4/3; leave room for the rest of the create body.
    expect(Math.ceil(INLINE_PDF_MAX_BYTES / 3) * 4).toBeLessThan(4.5 * 1000 * 1000)
  })
})
