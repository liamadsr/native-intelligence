/**
 * get_capture_transcript pages by default (~80K characters a call, with
 * next_offset), so a long meeting's transcript never lands whole in one tool
 * result; an explicit `limit` still reads exactly that many lines.
 * get_capture_content's include_transcript returns the same first page.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createCaptureTools, TRANSCRIPT_PAGE_CHARS, transcriptPageEnd } from '../captures'

vi.mock('../_shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared')>()),
  resolveEntityWorkspace: vi.fn(async () => ({ workspaceId: 'ws-1' })),
  captureVisibleToRequester: vi.fn(async () => true),
}))

/** The page inside its untrusted-content marker (the transcript is other speakers' words, A5). */
function body(wrapped: unknown): string {
  const text = wrapped as string
  expect(text.startsWith('[UNTRUSTED TRANSCRIPT CONTENT')).toBe(true)
  expect(text.endsWith('\n[END UNTRUSTED CONTENT]')).toBe(true)
  return text.slice(text.indexOf('\n') + 1, -'\n[END UNTRUSTED CONTENT]'.length)
}

const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/** A transcript of `n` lines, each 1,000 characters (a newline between them). */
const longTranscript = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, '0')} ${'x'.repeat(995)}`).join('\n')

function supabaseWith(transcript: string | null) {
  const row = { id: 'cap-1', title: 'Standup', transcript, duration_seconds: 2400, ai_summary: 's', participants: [] }
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'in', 'or', 'order', 'limit']) chain[m] = vi.fn(() => chain)
  chain.single = vi.fn(async () => ({ data: row, error: null }))
  chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }))
  chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  return { from: vi.fn(() => chain), rpc: vi.fn(async () => ({ data: [], error: null })) }
}

async function run(name: 'get_capture_transcript' | 'get_capture_content', transcript: string | null, args: Record<string, unknown>) {
  const t = createCaptureTools('user-1', supabaseWith(transcript) as never, 'ws-1')
  const parsed = (t[name].inputSchema as unknown as { parse: (v: unknown) => unknown }).parse({ capture_id: 'cap-1', ...args })
  return (await t[name].execute!(parsed as never, EXEC_OPTS)) as Record<string, unknown>
}

describe('get_capture_transcript paging', () => {
  it('returns a page of whole lines within the character budget, with next_offset', async () => {
    const r = await run('get_capture_transcript', longTranscript(200), {})
    // 79 lines of 1,000 chars + 78 newlines = 79,078 ≤ 80K; an 80th would pass it.
    expect(r).toMatchObject({ success: true, total_lines: 200, offset: 0, returned_lines: 79, has_more: true, next_offset: 79 })
    expect(body(r.transcript).length).toBeLessThanOrEqual(TRANSCRIPT_PAGE_CHARS)
  })

  it('walks the whole transcript with next_offset, every line exactly once', async () => {
    const full = longTranscript(200)
    const pages: string[] = []
    let offset = 0
    for (let guard = 0; guard < 10; guard++) {
      const r = await run('get_capture_transcript', full, { offset })
      pages.push(body(r.transcript))
      if (!r.has_more) {
        expect(r.next_offset).toBeUndefined()
        break
      }
      offset = r.next_offset as number
    }
    expect(pages).toHaveLength(3)
    expect(pages.join('\n')).toBe(full)
  })

  it('a short transcript comes back whole, with has_more false', async () => {
    const r = await run('get_capture_transcript', 'A: hi\nB: hello', {})
    expect(r).toMatchObject({ returned_lines: 2, has_more: false })
    expect(body(r.transcript)).toBe('A: hi\nB: hello')
    expect(r.next_offset).toBeUndefined()
  })

  it('an explicit limit reads exactly that many lines, past the budget', async () => {
    const r = await run('get_capture_transcript', longTranscript(200), { limit: 200 })
    expect(r).toMatchObject({ returned_lines: 200, has_more: false })
    const tail = await run('get_capture_transcript', longTranscript(200), { offset: 150, limit: 10 })
    expect(tail).toMatchObject({ offset: 150, returned_lines: 10, has_more: true, next_offset: 160 })
  })

  it('always advances: a single line longer than the budget is returned on its own', () => {
    const lines = ['y'.repeat(TRANSCRIPT_PAGE_CHARS + 5), 'next']
    expect(transcriptPageEnd(lines, 0)).toBe(1)
    expect(transcriptPageEnd(lines, 1)).toBe(2)
    expect(transcriptPageEnd(lines, 2)).toBe(2)
  })
})

describe('get_capture_content include_transcript', () => {
  it('returns the first page and where get_capture_transcript continues', async () => {
    const r = await run('get_capture_content', longTranscript(200), { include_transcript: true })
    const capture = r.capture as Record<string, unknown>
    expect(body(capture.transcript).split('\n')).toHaveLength(79)
    expect(capture).toMatchObject({ transcript_has_more: true, transcript_next_offset: 79, transcript_total_lines: 200 })
  })

  it('a short transcript comes back whole with no paging fields', async () => {
    const r = await run('get_capture_content', 'A: hi', { include_transcript: true })
    const capture = r.capture as Record<string, unknown>
    expect(body(capture.transcript)).toBe('A: hi')
    expect(capture.transcript_has_more).toBeUndefined()
  })
})
