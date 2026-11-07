/**
 * The presence store (src/lib/presence/store.ts) over a recording service
 * client: one upsert per ping that moves active_at only for `active`, the
 * seen marker's single conditional update (fenced on the person's home
 * thread, clamped to now, never moving backwards), the router's read, and
 * the 30-day prune.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PRESENCE_RETENTION_MS, markHomeSeen, prunePresence, readPresence, upsertPresence } from '../store'

type Op = [string, ...unknown[]]
interface Call {
  table: string
  ops: Op[]
}

function recorder(result: { data?: unknown; error?: { message: string } | null; count?: number | null } = {}) {
  const calls: Call[] = []
  const settled = { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null }
  const service = {
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
        get(_target, prop: string) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(settled).then(resolve, reject)
          return (...args: unknown[]) => {
            call.ops.push([prop, ...args])
            return chain
          }
        },
      })
      return chain
    },
  }
  return { service: service as unknown as SupabaseClient, calls }
}

const USER = 'user-1'
const CONV = '11111111-2222-4333-8444-555555555555'
const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const ISO_NOW = new Date(NOW).toISOString()

describe('upsertPresence', () => {
  it('one upsert on (user_id, client_id); active moves active_at and updated_at', async () => {
    const { service, calls } = recorder()
    await upsertPresence(service, USER, { clientId: 'client-abc1', surface: 'web', state: 'active' }, NOW)
    expect(calls).toEqual([
      {
        table: 'user_presence',
        ops: [
          [
            'upsert',
            { user_id: USER, client_id: 'client-abc1', surface: 'web', state: 'active', updated_at: ISO_NOW, active_at: ISO_NOW },
            { onConflict: 'user_id,client_id' },
          ],
        ],
      },
    ])
  })

  it('idle and locked leave active_at alone (it keeps when they were last active)', async () => {
    for (const state of ['idle', 'locked'] as const) {
      const { service, calls } = recorder()
      await upsertPresence(service, USER, { clientId: 'client-abc1', surface: 'desktop', state }, NOW)
      const row = calls[0].ops[0][1] as Record<string, unknown>
      expect(row).toEqual({ user_id: USER, client_id: 'client-abc1', surface: 'desktop', state, updated_at: ISO_NOW })
      expect('active_at' in row).toBe(false)
    }
  })

  it('never writes the seen (the route does that separately)', async () => {
    const { service, calls } = recorder()
    await upsertPresence(service, USER, { clientId: 'client-abc1', surface: 'web', state: 'active', seen: { conversationId: CONV, through: ISO_NOW } }, NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0].ops[0][1]).not.toHaveProperty('seen')
  })

  it('throws on a write error', async () => {
    const { service } = recorder({ error: { message: 'relation "user_presence" does not exist' } })
    await expect(upsertPresence(service, USER, { clientId: 'client-abc1', surface: 'web', state: 'active' }, NOW)).rejects.toThrow(/user_presence upsert failed/)
  })
})

/**
 * What PostgREST would do with markHomeSeen's update against one stored row:
 * the eq filters and the `seen_at.is.null,seen_at.lt.<time>` or-filter.
 */
function applySeen(row: { id: string; user_id: string; is_home: boolean | null; seen_at: string | null }, ops: Op[]) {
  const update = ops.find((op) => op[0] === 'update')![1] as { seen_at: string }
  const matches = ops.every((op) => {
    if (op[0] === 'eq') return (row as Record<string, unknown>)[op[1] as string] === op[2]
    if (op[0] === 'or') {
      const m = /^seen_at\.is\.null,seen_at\.lt\.(.+)$/.exec(op[1] as string)
      if (!m) throw new Error(`unexpected or filter ${String(op[1])}`)
      return row.seen_at === null || Date.parse(row.seen_at) < Date.parse(m[1])
    }
    return true
  })
  return matches ? { ...row, seen_at: update.seen_at } : row
}

describe('markHomeSeen', () => {
  const home = { id: CONV, user_id: USER, is_home: true as boolean | null, seen_at: null as string | null }

  it('one conditional update of chat_conversations, fenced on id, owner and is_home', async () => {
    const { service, calls } = recorder()
    await markHomeSeen(service, USER, CONV, '2026-10-31T11:58:00.000Z', NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('chat_conversations')
    expect(calls[0].ops).toEqual([
      ['update', { seen_at: '2026-10-31T11:58:00.000Z' }],
      ['eq', 'id', CONV],
      ['eq', 'user_id', USER],
      ['eq', 'is_home', true],
      ['or', 'seen_at.is.null,seen_at.lt.2026-10-31T11:58:00.000Z'],
    ])
  })

  it('clamps a time past now to now (a client clock running ahead)', async () => {
    const { service, calls } = recorder()
    await markHomeSeen(service, USER, CONV, '2026-10-31T13:00:00.000Z', NOW)
    expect(calls[0].ops[0]).toEqual(['update', { seen_at: ISO_NOW }])
    expect(applySeen(home, calls[0].ops).seen_at).toBe(ISO_NOW)
  })

  it('normalizes an offset time', async () => {
    const { service, calls } = recorder()
    await markHomeSeen(service, USER, CONV, '2026-10-31T07:58:00-04:00', NOW)
    expect(calls[0].ops[0]).toEqual(['update', { seen_at: '2026-10-31T11:58:00.000Z' }])
  })

  it('moves forward, and never backwards or sideways', async () => {
    let row = { ...home }
    const report = async (through: string) => {
      const { service, calls } = recorder()
      await markHomeSeen(service, USER, CONV, through, NOW)
      row = applySeen(row, calls[0].ops)
    }
    await report('2026-10-31T11:50:00.000Z')
    expect(row.seen_at).toBe('2026-10-31T11:50:00.000Z')
    await report('2026-10-31T11:55:00.000Z')
    expect(row.seen_at).toBe('2026-10-31T11:55:00.000Z')
    await report('2026-10-31T11:40:00.000Z')
    expect(row.seen_at).toBe('2026-10-31T11:55:00.000Z')
    await report('2026-10-31T11:55:00.000Z')
    expect(row.seen_at).toBe('2026-10-31T11:55:00.000Z')
  })

  it("touches nothing on another person's thread or a thread that isn't home", async () => {
    const { service, calls } = recorder()
    await markHomeSeen(service, USER, CONV, '2026-10-31T11:58:00.000Z', NOW)
    expect(applySeen({ ...home, user_id: 'someone-else' }, calls[0].ops).seen_at).toBeNull()
    expect(applySeen({ ...home, is_home: null }, calls[0].ops).seen_at).toBeNull()
    expect(applySeen({ ...home, id: '99999999-2222-4333-8444-555555555555' }, calls[0].ops).seen_at).toBeNull()
  })

  it('refuses a through that is not a time, and throws on a write error', async () => {
    const { service, calls } = recorder()
    await expect(markHomeSeen(service, USER, CONV, 'later', NOW)).rejects.toThrow()
    expect(calls).toHaveLength(0)
    const failing = recorder({ error: { message: 'column "seen_at" does not exist' } })
    await expect(markHomeSeen(failing.service, USER, CONV, ISO_NOW, NOW)).rejects.toThrow(/seen_at update failed/)
  })
})

describe('readPresence', () => {
  it("reads the person's rows, newest first", async () => {
    const rows = [{ client_id: 'client-abc1', surface: 'web', state: 'active', active_at: ISO_NOW, updated_at: ISO_NOW }]
    const { service, calls } = recorder({ data: rows })
    expect(await readPresence(service, USER)).toEqual(rows)
    expect(calls[0]).toEqual({
      table: 'user_presence',
      ops: [
        ['select', 'client_id, surface, state, active_at, updated_at'],
        ['eq', 'user_id', USER],
        ['order', 'updated_at', { ascending: false }],
      ],
    })
  })

  it('throws on a read error', async () => {
    const { service } = recorder({ error: { message: 'boom' } })
    await expect(readPresence(service, USER)).rejects.toThrow(/user_presence read failed/)
  })
})

describe('prunePresence', () => {
  it('deletes rows untouched for 30 days and returns how many', async () => {
    const { service, calls } = recorder({ count: 4 })
    expect(await prunePresence(service, NOW)).toBe(4)
    expect(calls[0]).toEqual({
      table: 'user_presence',
      ops: [
        ['delete', { count: 'exact' }],
        ['lt', 'updated_at', new Date(NOW - PRESENCE_RETENTION_MS).toISOString()],
      ],
    })
    expect(PRESENCE_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('throws on a delete error', async () => {
    const { service } = recorder({ error: { message: 'boom' } })
    await expect(prunePresence(service, NOW)).rejects.toThrow(/user_presence prune failed/)
  })
})
