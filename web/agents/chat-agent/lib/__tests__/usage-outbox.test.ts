import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The usage meter's outbox write (lib/usage-outbox.ts): an undeliverable
 * report is written to chat_usage_outbox under the route's OWN idempotency key,
 * so the server-side sweep and any late re-send share one claim.
 *
 * Pinned: the key twin cannot drift from the route's chatUsageIdempotencyKey
 * (feature key 'ai_chat' byte-identical, compaction suffix included); the row
 * shape; ignore-on-conflict (a key already queued is left as is); and that the
 * write never throws — anything it could not write is handed back.
 */

const upsert = vi.fn()
const from = vi.fn(() => ({ upsert }))
const createClient = vi.fn((_url: string, _key: string, _opts: unknown) => ({ from }))
vi.mock('@supabase/supabase-js', () => ({ createClient: (u: string, k: string, o: unknown) => createClient(u, k, o) }))

import { usageReportKey, writeUsageOutbox, CHAT_USAGE_OUTBOX_TABLE } from '../usage-outbox'
import { chatUsageIdempotencyKey } from '@/lib/chat/chat-usage-meter'
import type { TurnUsageReport } from '../turn-usage'

const report = (over: Partial<TurnUsageReport> = {}): TurnUsageReport => ({
  sessionId: 'sess-1',
  turnId: 'turn_3',
  outcome: 'completed',
  modelId: 'deepseek/deepseek-v4-flash',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  webSearchCostUsd: null,
  steps: 1,
  toolCalls: 0,
  toolDiscoveries: 0,
  generationIds: [],
  durationMs: 5,
  compaction: null,
  ...over,
})

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  upsert.mockReset()
  upsert.mockReturnValue({ abortSignal: async () => ({ error: null }) })
  from.mockClear()
  createClient.mockClear()
})

describe('usageReportKey — twin of the route’s chatUsageIdempotencyKey', () => {
  it.each([
    ['a turn', report()],
    ['an automatic compaction', report({ compaction: { trigger: 'automatic', id: 's3:2' } })],
    ['a manual compaction', report({ compaction: { trigger: 'manual', id: 'mevt_abc' } })],
  ])('%s keys identically on both sides', (_label, r) => {
    expect(usageReportKey(r)).toBe(chatUsageIdempotencyKey(r))
  })

  it('a turn and its compaction never share a key', () => {
    expect(usageReportKey(report())).toBe('ai_chat:sess-1:turn_3')
    expect(usageReportKey(report({ compaction: { trigger: 'automatic', id: 's3:2' } }))).toBe(
      'ai_chat:sess-1:turn_3:compaction:s3:2',
    )
  })
})

describe('writeUsageOutbox', () => {
  it('writes one row per report under the route’s key, ignoring a key already queued, with the service role', async () => {
    const r = [report(), report({ turnId: 'turn_4' })]
    await expect(writeUsageOutbox(r, 'tok')).resolves.toEqual([])
    expect(createClient).toHaveBeenCalledWith('https://test.supabase.co', 'service', expect.anything())
    expect(from).toHaveBeenCalledWith(CHAT_USAGE_OUTBOX_TABLE)
    const [rows, opts] = upsert.mock.calls[0]
    expect(opts).toEqual({ onConflict: 'idempotency_key', ignoreDuplicates: true })
    expect(rows).toEqual([
      { idempotency_key: 'ai_chat:sess-1:turn_3', session_id: 'sess-1', turn_id: 'turn_3', report: r[0], run_token: 'tok' },
      { idempotency_key: 'ai_chat:sess-1:turn_4', session_id: 'sess-1', turn_id: 'turn_4', report: r[1], run_token: 'tok' },
    ])
  })

  it('a token-less session writes run_token null (the sweep bills the session owner)', async () => {
    await writeUsageOutbox([report()], '')
    expect(upsert.mock.calls[0][0][0].run_token).toBeNull()
  })

  it('nothing to write → no client, no call', async () => {
    await expect(writeUsageOutbox([], 'tok')).resolves.toEqual([])
    expect(createClient).not.toHaveBeenCalled()
  })

  it('hands back everything it could not write: a DB error, a throw, or no service env', async () => {
    const r = [report()]
    upsert.mockReturnValue({ abortSignal: async () => ({ error: { message: 'down' } }) })
    await expect(writeUsageOutbox(r, 'tok')).resolves.toEqual(r)
    upsert.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(writeUsageOutbox(r, 'tok')).resolves.toEqual(r)
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    await expect(writeUsageOutbox(r, 'tok')).resolves.toEqual(r)
  })
})
