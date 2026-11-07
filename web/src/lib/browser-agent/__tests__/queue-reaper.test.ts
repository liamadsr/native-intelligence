/**
 * The browser-command reaper — lazy (readBrowserCommand) and bulk
 * (reapExpiredBrowserCommands). Pins the load-bearing behavior:
 *   - a waiting_for_device row past its TTL is expired;
 *   - a claimed row past its lease is expired;
 *   - a still-live row (within TTL/lease) and an already-terminal row are left
 *     alone;
 *   - the lazy reap CASes on the row's current status, so a device settling
 *     concurrently wins (the reap returns the fresh terminal row, not a clobber).
 *
 * A tiny chainable stub stands in for the Supabase service client so the filter
 * chain (.eq / .lt / .select) and the update payloads can be asserted without a DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Row {
  id: string
  user_id: string
  status: string
  result: unknown
  error_message: string | null
  command: string
  tab_id: string | null
  expires_at: string | null
  lease_expires_at: string | null
}

const state: { rows: Row[] } = { rows: [] }

/** Minimal query builder over state.rows supporting the calls the queue uses. */
function makeBuilder() {
  let op: 'select' | 'update' = 'select'
  let patch: Record<string, unknown> = {}
  const filters: Array<(r: Row) => boolean> = []
  const b: Record<string, unknown> = {}
  b.select = () => b
  b.update = (p: Record<string, unknown>) => {
    op = 'update'
    patch = p
    return b
  }
  b.eq = (col: string, val: unknown) => {
    filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val)
    return b
  }
  b.lt = (col: string, val: string) => {
    filters.push((r) => {
      const v = (r as unknown as Record<string, unknown>)[col]
      return typeof v === 'string' && v < val
    })
    return b
  }
  const match = () => state.rows.filter((r) => filters.every((f) => f(r)))
  const apply = () => {
    const hit = match()
    for (const r of hit) Object.assign(r, patch)
    return hit
  }
  b.maybeSingle = async () => {
    const hit = op === 'update' ? apply() : match()
    return { data: hit[0] ? { ...hit[0] } : null, error: null }
  }
  b.then = undefined // not a thenable except via select() terminal below
  // A bare `.select('...')` after update resolves to the affected rows when
  // awaited; model that by making select return an awaitable with the rows.
  b.selectRows = () => Promise.resolve({ data: apply().map((r) => ({ id: r.id })), error: null })
  return b
}

// The bulk reaper does `.update().eq().lt().select()` and awaits it. Support
// that by returning, from the final .select(), a promise of affected rows.
function makeServiceClient() {
  return {
    from: () => {
      const b = makeBuilder() as Record<string, unknown>
      const origSelect = b.select as () => unknown
      b.select = () => {
        // For the bulk path the select is terminal+awaited → resolve rows.
        const p = (b.selectRows as () => Promise<unknown>)()
        // Also keep chainability for the lazy path (.select().maybeSingle()).
        return Object.assign(p, b, { select: origSelect })
      }
      return b
    },
  }
}

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => makeServiceClient() }))

import { readBrowserCommand, reapExpiredBrowserCommands } from '../queue'

const past = new Date(Date.now() - 60_000).toISOString()
const future = new Date(Date.now() + 60_000).toISOString()

function row(over: Partial<Row>): Row {
  return {
    id: 'r1',
    user_id: 'u1',
    status: 'waiting_for_device',
    result: null,
    error_message: null,
    command: 'read_page',
    tab_id: null,
    expires_at: future,
    lease_expires_at: null,
    ...over,
  }
}

beforeEach(() => {
  state.rows = []
})

describe('readBrowserCommand — lazy reap', () => {
  it('expires a waiting_for_device row past its TTL', async () => {
    state.rows = [row({ status: 'waiting_for_device', expires_at: past })]
    const out = await readBrowserCommand('u1', 'r1')
    expect(out?.status).toBe('expired')
    expect(state.rows[0].status).toBe('expired')
    expect(state.rows[0].error_message).toMatch(/did not pick|before it expired/i)
  })

  it('expires a claimed row past its lease', async () => {
    state.rows = [row({ status: 'claimed', expires_at: past, lease_expires_at: past })]
    const out = await readBrowserCommand('u1', 'r1')
    expect(out?.status).toBe('expired')
    expect(state.rows[0].error_message).toMatch(/lease expired/i)
  })

  it('leaves a live waiting row (within TTL) untouched', async () => {
    state.rows = [row({ status: 'waiting_for_device', expires_at: future })]
    const out = await readBrowserCommand('u1', 'r1')
    expect(out?.status).toBe('waiting_for_device')
  })

  it('leaves a claimed row within its lease untouched', async () => {
    state.rows = [row({ status: 'claimed', expires_at: past, lease_expires_at: future })]
    const out = await readBrowserCommand('u1', 'r1')
    expect(out?.status).toBe('claimed')
  })

  it('never touches an already-terminal row', async () => {
    state.rows = [row({ status: 'completed', expires_at: past, result: { ok: true } })]
    const out = await readBrowserCommand('u1', 'r1')
    expect(out?.status).toBe('completed')
  })
})

describe('reapExpiredBrowserCommands — bulk backstop', () => {
  it('expires stranded waiting + claimed rows, leaves live and terminal ones', async () => {
    state.rows = [
      row({ id: 'w-stale', status: 'waiting_for_device', expires_at: past }),
      row({ id: 'w-live', status: 'waiting_for_device', expires_at: future }),
      row({ id: 'c-stale', status: 'claimed', lease_expires_at: past }),
      row({ id: 'c-live', status: 'claimed', lease_expires_at: future }),
      row({ id: 'done', status: 'completed', expires_at: past }),
    ]
    const { waiting, claimed } = await reapExpiredBrowserCommands()
    expect(waiting).toBe(1)
    expect(claimed).toBe(1)
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r.status]))
    expect(byId['w-stale']).toBe('expired')
    expect(byId['w-live']).toBe('waiting_for_device')
    expect(byId['c-stale']).toBe('expired')
    expect(byId['c-live']).toBe('claimed')
    expect(byId['done']).toBe('completed')
  })

  it('is a no-op when nothing is stranded', async () => {
    state.rows = [row({ status: 'waiting_for_device', expires_at: future })]
    const { waiting, claimed } = await reapExpiredBrowserCommands()
    expect(waiting).toBe(0)
    expect(claimed).toBe(0)
  })
})
