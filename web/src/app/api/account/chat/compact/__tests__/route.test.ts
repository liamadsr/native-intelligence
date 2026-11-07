/**
 * POST /api/account/chat/compact — compact one of the caller's chat
 * conversations now (src/lib/chat/manual-compaction.ts, mocked here). Pinned:
 *   - auth through requireWorkspace; the caller's own RLS client, user and
 *     workspace go to compactConversationNow, never the body's;
 *   - 400 on a bad body, before anything runs;
 *   - each outcome's status: 404 not the caller's (or a capture's), 409
 *     TURN_RUNNING while a reply runs, 429 RATE_LIMITED past the limits, 200
 *     { outcome } for what happened or nothing to do, 500 otherwise;
 *   - one log line per request;
 *   - maxDuration is a literal (Next reads it statically) covering
 *     MANUAL_COMPACTION_MAX_DURATION_S.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), compact: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
// manual-compaction.ts's own imports reach the usage limits: never the real billing module here.
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: vi.fn() }))
vi.mock('@/lib/chat/manual-compaction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/manual-compaction')>()),
  compactConversationNow: hoisted.compact,
}))

import { POST, maxDuration } from '@/app/api/account/chat/compact/route'
import { MANUAL_COMPACTION_MAX_DURATION_S, type ManualCompactionOutcome } from '@/lib/chat/manual-compaction'

const WS = 'a1000000-0000-4000-8000-000000000001'
const USER = 'b1000000-0000-4000-8000-000000000001'
const CONV = 'c1000000-0000-4000-8000-000000000001'
const supabase = { from: vi.fn() }

let log: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: { id: USER }, workspaceId: WS })
  hoisted.compact.mockResolvedValue({ outcome: 'compacted', inputTokens: 186_000 })
})

const post = (body: unknown, raw = false) =>
  POST(buildRequest({ url: 'https://dial8.ai/api/account/chat/compact', body, raw }) as unknown as NextRequest)

describe('POST /api/account/chat/compact', () => {
  it('auth: a failed requireWorkspace is returned as is, nothing compacted', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }))
    expect((await post({ conversationId: CONV })).status).toBe(401)
    expect(hoisted.compact).not.toHaveBeenCalled()
  })

  it('400 on a bad body, nothing compacted', async () => {
    for (const [body, raw] of [
      [{}, false],
      [{ conversationId: 'conv-1' }, false],
      [{ conversationId: 42 }, false],
      ['not json', true],
    ] as const) {
      const res = await post(body, raw)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await readJson(res)).toMatchObject({ code: 'BAD_REQUEST' })
    }
    expect(hoisted.compact).not.toHaveBeenCalled()
  })

  it('compacts the caller’s conversation on their own client, user and workspace (never the body’s), and logs one line', async () => {
    const res = await post({ conversationId: CONV, userId: 'attacker', workspaceId: 'ws-x' })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ outcome: 'compacted' })
    expect(hoisted.compact).toHaveBeenCalledTimes(1)
    expect(hoisted.compact).toHaveBeenCalledWith(supabase, { conversationId: CONV, userId: USER, workspaceId: WS })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(`[manual-compaction] conversation=${CONV} input=186000 outcome=compacted`)
  })

  it.each<ManualCompactionOutcome>([
    'compacted',
    'kept_history',
    'queued_behind_turn',
    'requested',
    'compacting',
    'already_compacted',
    'no_recent_step',
    'no_events',
    'no_session',
    'session_inactive',
  ])('200 { outcome: %s }', async (outcome) => {
    hoisted.compact.mockResolvedValue({ outcome })
    const res = await post({ conversationId: CONV })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ outcome })
  })

  it.each<[ManualCompactionOutcome, number, string]>([
    ['not_found', 404, 'NOT_FOUND'],
    ['capture_conversation', 404, 'NOT_FOUND'],
    ['turn_running', 409, 'TURN_RUNNING'],
    ['recent_activity', 409, 'TURN_RUNNING'],
    ['usage_limited', 429, 'RATE_LIMITED'],
    ['lookup_failed', 500, 'INTERNAL'],
    ['usage_check_failed', 500, 'INTERNAL'],
    ['server_auth_failed', 500, 'INTERNAL'],
    ['forbidden', 500, 'INTERNAL'],
    ['error', 500, 'INTERNAL'],
  ])('%s → %i %s', async (outcome, status, code) => {
    hoisted.compact.mockResolvedValue({ outcome })
    const res = await post({ conversationId: CONV })
    expect(res.status).toBe(status)
    const body = (await readJson(res)) as { error: string; code: string; outcome?: unknown }
    expect(body.code).toBe(code)
    expect(typeof body.error).toBe('string')
    expect(body).not.toHaveProperty('outcome')
  })

  it('maxDuration is a literal Next can read, covering the whole wait', () => {
    expect(maxDuration).toBeGreaterThanOrEqual(MANUAL_COMPACTION_MAX_DURATION_S)
    const src = readFileSync(join(process.cwd(), 'src/app/api/account/chat/compact/route.ts'), 'utf8')
    const match = /^export const maxDuration = (\d+)$/m.exec(src)
    expect(match, 'maxDuration must stay a numeric literal').not.toBeNull()
    expect(Number(match![1])).toBe(maxDuration)
  })
})
