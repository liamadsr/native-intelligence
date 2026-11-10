/**
 * Drift lock: the chat-agent's device-token resolver (resolveDeviceTokenSession,
 * agents/chat-agent/lib/auth.ts) is a hand-copy of the Next side's
 * resolveDeviceToken (src/lib/device-tokens.ts) — the eve bundle cannot import
 * from src/. /api/device/ask resolves the device's workspace with the Next copy
 * and registers the session under it; the channel's ACL admits the device with
 * the agent copy. If the two ever resolve differently (one adds a check the
 * other lacks), every device ask 403s at the ACL, or the channel admits a device
 * the Next side refuses.
 *
 * Both resolvers run here over the SAME mocked device_token / member rows and
 * must agree on every case: live with an active workspace, live without one
 * (oldest membership), expired, unknown, and a lookup error. The member mock
 * APPLIES the order/limit it is given over several memberships stored newest
 * first, and both sides' fallback query shapes are compared, so dropping or
 * flipping `.order('created_at', { ascending: true })` or `.limit(1)` on
 * either side fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

interface DeviceRow {
  id: string
  user_id: string
  active_workspace_id: string | null
  expires_at: string | null
}
interface MemberRow {
  user_id: string
  workspace_id: string
  created_at: string
}
const db: {
  devices: Record<string, DeviceRow>
  members: MemberRow[]
  deviceLookupError: boolean
} = { devices: {}, members: [], deviceLookupError: false }

/** Every query either resolver issued, in order — the shape each must agree on. */
interface RecordedQuery {
  table: string
  select?: string
  eqs: Array<[string, unknown]>
  order?: [string, unknown]
  limit?: number
}
let recorded: RecordedQuery[] = []

const hashOf = (t: string) => createHash('sha256').update(t).digest('hex')

/**
 * A query builder that APPLIES what it is told — eq filters, order, limit —
 * over in-memory rows, and answers maybeSingle like PostgREST: more than one
 * row is an error. So a resolver that drops `.order(...)`, flips its
 * direction, or drops `.limit(1)` gets a DIFFERENT answer, not a silent pass.
 */
function from(table: string) {
  const q: RecordedQuery = { table, eqs: [] }
  recorded.push(q)
  const val = (col: string) => q.eqs.find(([c]) => c === col)?.[1] as string
  const chain: Record<string, unknown> = {
    select: (cols: string) => {
      q.select = cols
      return chain
    },
    update: () => chain,
    eq: (c: string, v: unknown) => {
      q.eqs.push([c, v])
      return chain
    },
    order: (col: string, opts: unknown) => {
      q.order = [col, opts]
      return chain
    },
    limit: (n: number) => {
      q.limit = n
      return chain
    },
    // The Next side's fire-and-forget last_used_at update is awaited via then().
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
    maybeSingle: async () => {
      if (table === 'device_token') {
        if (db.deviceLookupError) return { data: null, error: { message: 'db down' } }
        return { data: db.devices[val('token_hash')] ?? null, error: null }
      }
      if (table === 'member') {
        let rows = db.members.filter((m) => q.eqs.every(([c, v]) => (m as unknown as Record<string, unknown>)[c] === v))
        if (q.order) {
          const [col, opts] = q.order
          const asc = (opts as { ascending?: boolean } | undefined)?.ascending !== false
          rows = [...rows].sort((a, b) => {
            const x = (a as unknown as Record<string, string>)[col]
            const y = (b as unknown as Record<string, string>)[col]
            return asc ? x.localeCompare(y) : y.localeCompare(x)
          })
        }
        if (q.limit !== undefined) rows = rows.slice(0, q.limit)
        if (rows.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }
        return { data: rows[0] ? { workspace_id: rows[0].workspace_id } : null, error: null }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return chain
}

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ from })) }))
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ from }) }))

import { resolveDeviceTokenSession } from '../auth'
import { resolveDeviceToken } from '@/lib/device-tokens'

const LIVE = 'nid_live-with-workspace'
const NO_WS = 'nid_live-no-active-workspace'
const EXPIRED = 'nid_expired'
const UNKNOWN = 'nid_unknown'

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  db.devices = {
    [hashOf(LIVE)]: { id: 'd1', user_id: 'user-1', active_workspace_id: 'ws-picked', expires_at: null },
    [hashOf(NO_WS)]: { id: 'd2', user_id: 'user-1', active_workspace_id: null, expires_at: '2999-01-01T00:00:00Z' },
    [hashOf(EXPIRED)]: { id: 'd3', user_id: 'user-1', active_workspace_id: 'ws-picked', expires_at: '2020-01-01T00:00:00Z' },
  }
  // Stored NEWEST first, so an unordered read (or a flipped direction) picks
  // the wrong workspace; only ORDER BY created_at ASC LIMIT 1 finds ws-oldest.
  db.members = [
    { user_id: 'user-1', workspace_id: 'ws-newest', created_at: '2026-09-01T00:00:00Z' },
    { user_id: 'user-1', workspace_id: 'ws-middle', created_at: '2026-05-01T00:00:00Z' },
    { user_id: 'user-1', workspace_id: 'ws-oldest', created_at: '2026-01-01T00:00:00Z' },
    { user_id: 'user-2', workspace_id: 'ws-other', created_at: '2025-01-01T00:00:00Z' },
  ]
  db.deviceLookupError = false
  recorded = []
})

/** Both resolvers on one token, normalized to (userId, workspaceId) | null. */
async function both(token: string) {
  recorded = []
  const next = await resolveDeviceToken(token)
  const nextQueries = recorded
  recorded = []
  const agent = await resolveDeviceTokenSession(
    new Request('https://app/eve/chat-agent/v1/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
  )
  const agentQueries = recorded
  return {
    next: next ? { userId: next.userId, workspaceId: next.workspaceId ?? '' } : null,
    agent,
    nextMember: nextQueries.filter((q) => q.table === 'member'),
    agentMember: agentQueries.filter((q) => q.table === 'member'),
  }
}

describe('resolveDeviceToken (Next) ≡ resolveDeviceTokenSession (chat-agent)', () => {
  it.each([
    ['live, active workspace', LIVE, { userId: 'user-1', workspaceId: 'ws-picked' }],
    ['live, no active workspace → oldest membership', NO_WS, { userId: 'user-1', workspaceId: 'ws-oldest' }],
    ['expired', EXPIRED, null],
    ['unknown', UNKNOWN, null],
  ])('%s', async (_label, token, expected) => {
    const { next, agent } = await both(token)
    expect(next).toEqual(expected)
    expect(agent).toEqual(expected)
  })

  it('no membership at all: both resolve the user with no workspace', async () => {
    db.members = []
    const { next, agent } = await both(NO_WS)
    expect(next).toEqual({ userId: 'user-1', workspaceId: '' })
    expect(agent).toEqual(next)
  })

  it('a device_token lookup error: both refuse', async () => {
    db.deviceLookupError = true
    const { next, agent } = await both(LIVE)
    expect(next).toBeNull()
    expect(agent).toBeNull()
  })

  it('the fallback membership query is IDENTICAL on both sides: member, workspace_id, eq user_id, ORDER BY created_at ASC, LIMIT 1', async () => {
    const { nextMember, agentMember } = await both(NO_WS)
    const expected: RecordedQuery[] = [
      {
        table: 'member',
        select: 'workspace_id',
        eqs: [['user_id', 'user-1']],
        order: ['created_at', { ascending: true }],
        limit: 1,
      },
    ]
    expect(nextMember).toEqual(expected)
    expect(agentMember).toEqual(expected)
  })

  it('an active workspace never costs a membership query on either side', async () => {
    const { nextMember, agentMember } = await both(LIVE)
    expect(nextMember).toEqual([])
    expect(agentMember).toEqual([])
  })
})
