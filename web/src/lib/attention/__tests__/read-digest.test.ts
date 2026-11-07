/**
 * read-digest.ts: a run whose cards all settled with no click (migration 352's
 * triggers, the TTL groom) has its owner's unread notices read on the
 * flow-schedule tick, through the same helper a person's settle uses; a
 * failure to read them logs one line and never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => {
    throw new Error('the tick passes its own client')
  },
}))

import { DIGEST_SWEEP_LOOKBACK_MS, DIGEST_SWEEP_SETTLE_MS, readDigestOnceSettled, readSettledRunDigests } from '../read-digest'

const NOW = new Date('2026-10-18T12:00:00.000Z')

type Filters = Array<[string, string, unknown]>

interface FakeOptions {
  /** What the settled-card scan returns. */
  settled?: Array<{ member_id: string | null; work_item_id: string | null }>
  /** Pending cards, as (member_id, work_item_id). */
  pending?: Array<{ member_id: string; work_item_id: string }>
  /** Unread notices, as (id, recipient_id, target_id). */
  notices?: Array<{ id: string; recipient_id: string; target_id: string }>
  scanError?: string
  /** Every notification update throws. */
  markThrows?: boolean
}

/** A PostgREST-shaped fake for the three reads/writes the sweep makes. */
function fake(opts: FakeOptions) {
  const scans: Filters[] = []
  const unread = new Map((opts.notices ?? []).map((n) => [n.id, n]))
  const read: string[] = []
  const client = {
    from(table: string) {
      const filters: Filters = []
      let update: Record<string, unknown> | null = null
      const eqValue = (col: string) => filters.find(([op, c]) => op === 'eq' && c === col)?.[2]
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (values: Record<string, unknown>) => {
          update = values
          return chain
        },
        order: () => chain,
      }
      for (const op of ['eq', 'neq', 'gte', 'lte', 'or', 'not']) {
        chain[op] = (col: string, ...rest: unknown[]) => {
          filters.push([op, col, rest.length === 1 ? rest[0] : rest])
          return chain
        }
      }
      chain.limit = async () => {
        if (table !== 'attention_item') throw new Error(`unexpected limit on ${table}`)
        if (eqValue('status') === 'pending') {
          const hit = (opts.pending ?? []).filter(
            (p) => p.member_id === eqValue('member_id') && p.work_item_id === eqValue('payload->>work_item_id'),
          )
          return { data: hit.map(() => ({ id: 'pending-card' })), error: null }
        }
        scans.push(filters)
        if (opts.scanError) return { data: null, error: { message: opts.scanError } }
        return { data: opts.settled ?? [], error: null }
      }
      // notification: update(...).eq(...).select('id') is awaited.
      chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        if (table !== 'notification' || !update) return reject(new Error(`unexpected await on ${table}`))
        if (opts.markThrows) return reject(new Error('notification write failed'))
        const hits = [...unread.values()].filter(
          (n) => n.recipient_id === eqValue('recipient_id') && n.target_id === eqValue('target_id'),
        )
        for (const n of hits) {
          unread.delete(n.id)
          read.push(n.id)
        }
        resolve({ data: hits.map((n) => ({ id: n.id })), error: null })
      }
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, scans, read }
}

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
})

describe('readSettledRunDigests (the tick)', () => {
  it('reads the owner’s notices for a run whose cards a trigger settled, and nobody else’s', async () => {
    const { client, scans, read } = fake({
      settled: [
        { member_id: 'mem-1', work_item_id: 'job-1' },
        { member_id: 'mem-1', work_item_id: 'job-1' },
      ],
      notices: [
        { id: 'n-digest', recipient_id: 'mem-1', target_id: 'job-1' },
        { id: 'n-other-run', recipient_id: 'mem-1', target_id: 'job-2' },
        { id: 'n-theirs', recipient_id: 'mem-9', target_id: 'job-1' },
      ],
    })
    expect(await readSettledRunDigests(client, NOW)).toEqual({ runs: 1, read: 1 })
    expect(read).toEqual(['n-digest'])

    // One scan: settled (not pending) cards, in the lookback, settled with no
    // click (migration 352's stamp, or expired), naming a run.
    expect(scans).toHaveLength(1)
    expect(scans[0]).toEqual(
      expect.arrayContaining([
        ['neq', 'status', 'pending'],
        ['gte', 'resolved_at', new Date(NOW.getTime() - DIGEST_SWEEP_LOOKBACK_MS).toISOString()],
        // A card settled under a minute ago waits a tick (a failed accept hands it back).
        ['lte', 'resolved_at', new Date(NOW.getTime() - DIGEST_SWEEP_SETTLE_MS).toISOString()],
        ['or', 'status.eq.expired,payload->>resolved_with_proposal.not.is.null', []],
        ['not', 'payload->>work_item_id', ['is', null]],
      ]),
    )
  })

  it('leaves the digest unread while another of the run’s cards still waits', async () => {
    const { client, read } = fake({
      settled: [{ member_id: 'mem-1', work_item_id: 'job-1' }],
      pending: [{ member_id: 'mem-1', work_item_id: 'job-1' }],
      notices: [{ id: 'n-digest', recipient_id: 'mem-1', target_id: 'job-1' }],
    })
    expect(await readSettledRunDigests(client, NOW)).toEqual({ runs: 1, read: 0 })
    expect(read).toEqual([])
  })

  it('a failed scan logs one line, reads nothing and never throws', async () => {
    const { client, read } = fake({ scanError: 'statement timeout' })
    expect(await readSettledRunDigests(client, NOW)).toEqual({ runs: 0, read: 0 })
    expect(read).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[attention-items] settled digest sweep failed')
  })

  it('a failed mark-read is swallowed: the tick goes on to the next run', async () => {
    const { client } = fake({
      settled: [
        { member_id: 'mem-1', work_item_id: 'job-1' },
        { member_id: 'mem-2', work_item_id: 'job-2' },
      ],
      markThrows: true,
    })
    await expect(readSettledRunDigests(client, NOW)).resolves.toEqual({ runs: 2, read: 0 })
    // markItemNoticesRead logs its own line per failed write.
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('skips a row that names no owner or no run', async () => {
    const { client } = fake({ settled: [{ member_id: null, work_item_id: 'job-1' }, { member_id: 'mem-1', work_item_id: null }] })
    expect(await readSettledRunDigests(client, NOW)).toEqual({ runs: 0, read: 0 })
  })
})

describe('readDigestOnceSettled (the shared helper)', () => {
  it('a card that names no run reads nothing', async () => {
    const { client, read } = fake({ notices: [{ id: 'n', recipient_id: 'mem-1', target_id: 'job-1' }] })
    expect(await readDigestOnceSettled(client, { member_id: 'mem-1', payload: {} }, { writer: client })).toBe(0)
    expect(read).toEqual([])
  })

  it('a writer that cannot be made is swallowed (the settle already happened)', async () => {
    const { client } = fake({})
    // No writer: getServiceClient() is called, and throws here.
    expect(await readDigestOnceSettled(client, { member_id: 'mem-1', payload: { work_item_id: 'job-1' } })).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
