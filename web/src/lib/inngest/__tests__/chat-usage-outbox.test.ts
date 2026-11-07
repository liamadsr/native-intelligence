import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The chat usage OUTBOX sweep — the server-side backstop for a report the
 * chat-agent's usage meter could not deliver (the session's last turn, an app
 * outage, a 409 / 401). Pinned:
 *   - it bills with the route's own logic: key recomputed from the report (a
 *     mismatched row is dropped), payer = a token whose HMAC verifies (expired
 *     included) else the session owner — never the row's claims;
 *   - once only: a turn the route already billed is a duplicate no-op, and the
 *     row is deleted either way;
 *   - a surface (device ask) row is settled without billing;
 *   - an unregistered session is retained, then dropped + alerted after a day;
 *   - a failed bill is retained for the next sweep;
 *   - rows younger than OUTBOX_MIN_AGE_MS are left to the hook's own re-send;
 *   - retained rows rotate behind fresh ones (fewest attempts first), so a
 *     stuck backlog cannot starve a new undelivered turn;
 *   - any sweep that bills alerts Sentry.
 */

const SECRET = 'outbox-sweep-secret-0123456789'
const NOW = Date.parse('2026-09-25T12:00:00.000Z')

type Outcome = 'logged' | 'duplicate' | 'retry-enqueued' | 'lost'
const claimed = new Set<string>()
const logUsage = vi.fn(async (_u: string, p: { idempotencyKey?: string }): Promise<Outcome> => {
  if (p.idempotencyKey && claimed.has(p.idempotencyKey)) return 'duplicate'
  if (p.idempotencyKey) claimed.add(p.idempotencyKey)
  return 'logged'
})
vi.mock('@/lib/ai/auth', () => ({ logUsage: (u: string, p: { idempotencyKey?: string }) => logUsage(u, p) }))
const sentryMessage = vi.fn()
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: (...a: unknown[]) => sentryMessage(...a) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))

interface Row {
  idempotency_key: string
  report: Record<string, unknown>
  run_token: string | null
  attempts: number
  last_error: string | null
  created_at: string
}
let rows: Row[] = []
const owners = new Map<string, string>()

function fakeSupabase() {
  return {
    from(table: string) {
      if (table === 'chat_conversations') {
        let sid = ''
        const c = {
          select: () => c,
          eq: (_col: string, v: string) => ((sid = v), c),
          limit: () => c,
          maybeSingle: async () => ({ data: owners.has(sid) ? { user_id: owners.get(sid), id: 'conversation-1', workspace_id: 'workspace-1' } : null, error: null }),
        }
        return c
      }
      if (table !== 'chat_usage_outbox') throw new Error(`unexpected table ${table}`)
      let before = ''
      let limitN = Infinity
      const orderBy: Array<'attempts' | 'created_at'> = []
      const cmp = (a: Row, b: Row) => {
        for (const col of orderBy) {
          const d = col === 'attempts' ? a.attempts - b.attempts : a.created_at.localeCompare(b.created_at)
          if (d !== 0) return d
        }
        return 0
      }
      const sel = {
        lt: (_c: string, v: string) => ((before = v), sel),
        order: (col: 'attempts' | 'created_at') => (orderBy.push(col), sel),
        limit: (n: number) => {
          limitN = n
          const data = rows
            .filter((r) => r.created_at < before)
            .sort(cmp)
            .slice(0, limitN)
            .map((r) => ({ ...r }))
          return Promise.resolve({ data, error: null })
        },
      }
      return {
        select: () => sel,
        delete: () => ({
          eq: async (_c: string, key: string) => {
            rows = rows.filter((r) => r.idempotency_key !== key)
            return { error: null }
          },
        }),
        update: (patch: Partial<Row>) => ({
          eq: async (_c: string, key: string) => {
            rows = rows.map((r) => (r.idempotency_key === key ? { ...r, ...patch } : r))
            return { error: null }
          },
        }),
      }
    },
  }
}

import { sweepChatUsageOutbox, OUTBOX_MIN_AGE_MS, OUTBOX_MAX_AGE_MS, OUTBOX_BATCH } from '../chat-usage-outbox'
import { mintChatRunToken } from '@/lib/chat/chat-run-token'

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
function report(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    turnId: 'turn_7',
    outcome: 'completed',
    modelId: 'deepseek/deepseek-v4-flash',
    inputTokens: 500,
    outputTokens: 40,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    webSearchCostUsd: null,
    steps: 1,
    toolCalls: 0,
    toolDiscoveries: 0,
    generationIds: [],
    durationMs: 10,
    compaction: null,
    ...over,
  }
}
function row(r: Record<string, unknown>, opts: { token?: string | null; ageMs?: number; key?: string } = {}): Row {
  const compaction = r.compaction as { id: string } | null
  const key = opts.key ?? `ai_chat:${r.sessionId}:${r.turnId}${compaction ? `:compaction:${compaction.id}` : ''}`
  return {
    idempotency_key: key,
    report: r,
    run_token: opts.token === undefined ? null : opts.token,
    attempts: 0,
    last_error: null,
    created_at: iso(opts.ageMs ?? 5 * 60 * 1000),
  }
}
/** A token minted at `at` (ms since epoch): validly signed, expiring 60 minutes later. */
function mintedAt(at: number, mint: () => string): string {
  vi.useFakeTimers()
  vi.setSystemTime(at)
  try {
    return mint()
  } finally {
    vi.useRealTimers()
  }
}
const sweep = () => sweepChatUsageOutbox(fakeSupabase() as never, NOW)

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  rows = []
  owners.clear()
  owners.set('sess-1', 'owner-1')
  claimed.clear()
  logUsage.mockClear()
  sentryMessage.mockClear()
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

describe('sweepChatUsageOutbox', () => {
  it('retains stable attribution, runtime timestamps and command links through the durable retry path', async () => {
    const id = '12345678-1234-1234-1234-123456789abc'
    rows = [row(report({ browserCommandIds: [id], inputTokensReported: true, outputTokensReported: true,
      firstEventAt: '2026-09-25T11:59:00.000Z', terminalAt: '2026-09-25T11:59:01.000Z' }))]
    await sweep()
    const params = logUsage.mock.calls[0][1] as unknown as Record<string, unknown>
    expect(params.metadata).toMatchObject({ parent_run_id: 'ai_chat:sess-1:turn_7', usage_key: 'ai_chat:sess-1:turn_7',
      conversation_id: 'conversation-1', workspace_id: 'workspace-1', browser_command_ids: [id],
      runtime_first_event_at: '2026-09-25T11:59:00.000Z', runtime_terminal_at: '2026-09-25T11:59:01.000Z', usage_unknown: false })
    expect(claimed.size).toBe(1)
  })
  it('bills an undelivered turn to the session OWNER under the route’s key, deletes the row, and alerts', async () => {
    rows = [row(report())]
    const res = await sweep()
    expect(res).toEqual({ scanned: 1, billed: 1, settled: 0, retained: 0, dropped: 0 })
    expect(logUsage).toHaveBeenCalledTimes(1)
    const [userId, params] = logUsage.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(userId).toBe('owner-1')
    expect(params).toMatchObject({ feature: 'ai_chat', inputTokens: 500, idempotencyKey: 'ai_chat:sess-1:turn_7' })
    expect(rows).toEqual([])
    expect(sentryMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not deliver/),
      expect.objectContaining({ level: 'warning' }),
    )
  })

  it('a turn the route ALREADY billed is a duplicate no-op — the row is still cleared, nothing alerted', async () => {
    claimed.add('ai_chat:sess-1:turn_7')
    rows = [row(report())]
    expect(await sweep()).toMatchObject({ billed: 0, settled: 1 })
    expect(rows).toEqual([])
    expect(sentryMessage).not.toHaveBeenCalled()
  })

  const tokenUser = () => mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'token-user' })
  const HOUR = 60 * 60 * 1000

  it('pays by a token whose HMAC verifies — EXPIRED within the grace when queued — even when no conversation registers the session', async () => {
    // Queued 5 min ago by a turn whose token expired 15 min before that.
    const queuedAgo = 5 * 60 * 1000
    rows = [row(report({ sessionId: 'sess-unregistered' }), { token: mintedAt(NOW - queuedAgo - HOUR - 15 * 60 * 1000, tokenUser), ageMs: queuedAgo })]
    expect(await sweep()).toMatchObject({ billed: 1 })
    expect(logUsage.mock.calls[0][0]).toBe('token-user')
  })

  it('judges the token at the row’s queue time, not the sweep’s: a row swept 23 h late still pays by its token', async () => {
    // Queued 23 h ago, 20 min after its token expired: inside the grace then,
    // nearly a day past it now. The real clock is the sweep's, so only the
    // queue time can tell the two apart.
    const queuedAt = NOW - 23 * HOUR
    const token = mintedAt(queuedAt - HOUR - 20 * 60 * 1000, tokenUser)
    rows = [row(report({ sessionId: 'sess-unregistered' }), { token, ageMs: 23 * HOUR })]
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      expect(await sweep()).toMatchObject({ billed: 1, retained: 0 })
    } finally {
      vi.useRealTimers()
    }
    expect(logUsage.mock.calls[0][0]).toBe('token-user')
  })

  it('a token already past the grace when queued counts as none: the owner pays, and an unregistered session is retained, never billed to the token’s user', async () => {
    // Queued 5 min ago, an hour after its token expired.
    const queuedAgo = 5 * 60 * 1000
    const stale = mintedAt(NOW - queuedAgo - 2 * HOUR, tokenUser)
    rows = [row(report(), { token: stale, ageMs: queuedAgo }), row(report({ sessionId: 'sess-unregistered' }), { token: stale, ageMs: queuedAgo })]
    expect(await sweep()).toMatchObject({ billed: 1, retained: 1 })
    expect(logUsage.mock.calls.map(([u]) => u)).toEqual(['owner-1'])
  })

  it('never trusts an unverifiable token (a forged one falls to the owner)', async () => {
    const forged = `${Buffer.from(JSON.stringify({ conversationId: 'c', workspaceId: 'w', userId: 'attacker', exp: NOW + 1e6 })).toString('base64url')}.x`
    rows = [row(report(), { token: forged })]
    await sweep()
    expect(logUsage.mock.calls[0][0]).toBe('owner-1')
  })

  it('a device-ask (surface) row is settled without billing — /api/device/ask bills it', async () => {
    rows = [row(report(), { token: mintChatRunToken({ conversationId: 'c', workspaceId: 'w', userId: 'u', surface: 'device_ask' }) })]
    expect(await sweep()).toMatchObject({ billed: 0, settled: 1 })
    expect(logUsage).not.toHaveBeenCalled()
    expect(rows).toEqual([])
  })

  it('an unregistered session with no verifiable token is retained, then dropped + alerted after OUTBOX_MAX_AGE_MS', async () => {
    rows = [row(report({ sessionId: 'sess-x' }))]
    expect(await sweep()).toMatchObject({ retained: 1 })
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: 'session unregistered' })
    rows = [row(report({ sessionId: 'sess-x' }), { ageMs: OUTBOX_MAX_AGE_MS + 1000 })]
    expect(await sweep()).toMatchObject({ dropped: 1 })
    expect(rows).toEqual([])
    expect(sentryMessage).toHaveBeenCalledWith(expect.stringMatching(/unattributable/), expect.objectContaining({ level: 'error' }))
    expect(logUsage).not.toHaveBeenCalled()
  })

  it('a LOST bill is retained for the next sweep (the keyed RPC left no claim)', async () => {
    logUsage.mockImplementationOnce(async () => 'lost')
    rows = [row(report())]
    expect(await sweep()).toMatchObject({ retained: 1, billed: 0 })
    expect(rows[0].attempts).toBe(1)
    expect(await sweep()).toMatchObject({ billed: 1 })
    expect(rows).toEqual([])
  })

  it('a malformed report, or one whose key does not match it, is dropped (never billed on a guess) and alerted', async () => {
    rows = [row(report({ inputTokens: -1 })), row(report({ turnId: 'turn_8' }), { key: 'ai_chat:sess-1:turn_999' })]
    expect(await sweep()).toMatchObject({ dropped: 2 })
    expect(logUsage).not.toHaveBeenCalled()
    expect(sentryMessage).toHaveBeenCalledTimes(2)
  })

  it('a compaction row bills under its compaction key', async () => {
    rows = [row(report({ outputTokens: 0, compaction: { trigger: 'manual', id: 'mevt_1' } }))]
    await sweep()
    expect((logUsage.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      idempotencyKey: 'ai_chat:sess-1:turn_7:compaction:mevt_1',
    })
  })

  it('a stuck backlog (a full batch of retained rows) cannot starve a fresh undelivered turn', async () => {
    // OUTBOX_BATCH older rows on a session nobody owns yet: retained every sweep.
    rows = Array.from({ length: OUTBOX_BATCH }, (_, i) =>
      row(report({ sessionId: 'sess-orphan', turnId: `turn_${i}` }), { ageMs: 60 * 60 * 1000 + i * 1000 }),
    )
    expect(await sweep()).toMatchObject({ scanned: OUTBOX_BATCH, retained: OUTBOX_BATCH })
    // A newer undeliverable turn arrives; the stuck rows are older AND still a full batch.
    rows.push(row(report({ turnId: 'turn_fresh' })))
    const res = await sweep()
    expect(res).toMatchObject({ billed: 1 })
    expect(rows.find((r) => r.report.turnId === 'turn_fresh')).toBeUndefined()
    expect((logUsage.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      idempotencyKey: 'ai_chat:sess-1:turn_fresh',
    })
  })

  it('leaves a row younger than OUTBOX_MIN_AGE_MS to the hook’s own re-send', async () => {
    rows = [row(report(), { ageMs: OUTBOX_MIN_AGE_MS - 1000 })]
    expect(await sweep()).toMatchObject({ scanned: 0 })
    expect(rows).toHaveLength(1)
  })
})
