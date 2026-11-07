/**
 * What became of a chat ask once its card left the shared source (P13,
 * ask-outcome.ts): the row's status, read once and batched, said in one line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetAskOutcomesForTests, approvalOutcome, askOutcomeLine, cardOutcome, knownAskOutcome, loadAskOutcome } from '../ask-outcome'

afterEach(() => __resetAskOutcomesForTests())

describe('the outcome of a row', () => {
  it('an approval: ran, refused or failed, declined, expired, still waiting, or someone else’s', () => {
    expect(approvalOutcome({ status: 'approved', success: true })).toBe('approved')
    expect(approvalOutcome({ status: 'approved', success: null })).toBe('approved')
    expect(approvalOutcome({ status: 'approved', success: false })).toBe('failed')
    expect(approvalOutcome({ status: 'approved', is_error: true })).toBe('failed')
    expect(approvalOutcome({ status: 'failed' })).toBe('failed')
    expect(approvalOutcome({ status: 'denied' })).toBe('declined')
    expect(approvalOutcome({ status: 'expired' })).toBe('expired')
    expect(approvalOutcome({ status: 'pending' })).toBe('waiting')
    // Pending, but its wait is over (the hourly sweep hasn't marked it yet): expired.
    expect(approvalOutcome({ status: 'pending', expires_at: '2026-10-20T10:00:00.000Z' }, Date.parse('2026-10-20T11:00:00.000Z'))).toBe('expired')
    expect(approvalOutcome({ status: 'pending', expires_at: '2026-10-20T12:00:00.000Z' }, Date.parse('2026-10-20T11:00:00.000Z'))).toBe('waiting')
    expect(approvalOutcome(null)).toBe('theirs')
  })

  it('a question card: answered, dismissed, expired', () => {
    expect(cardOutcome({ status: 'accepted' })).toBe('answered')
    expect(cardOutcome({ status: 'dismissed' })).toBe('dismissed')
    expect(cardOutcome({ status: 'expired' })).toBe('expired')
    expect(cardOutcome({ status: 'pending', expires_at: '2026-10-20T10:00:00.000Z' }, Date.parse('2026-10-20T11:00:00.000Z'))).toBe('expired')
    expect(cardOutcome(undefined)).toBe('theirs')
  })

  it('each says itself in one line', () => {
    expect(askOutcomeLine('approved')).toBe('Approved. It ran.')
    expect(askOutcomeLine('declined')).toBe('Declined. Nothing ran.')
    expect(askOutcomeLine('expired')).toBe('Expired. Nothing ran.')
    expect(askOutcomeLine('theirs')).toBe('Waiting on someone else’s yes.')
  })
})

describe('loadAskOutcome', () => {
  function client(rows: { tool_approval?: unknown[]; attention_item?: unknown[] }) {
    const reads: Array<{ table: string; ids: string[] }> = []
    const from = vi.fn((table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          reads.push({ table, ids })
          return { data: (rows[table as keyof typeof rows] ?? []).filter((r) => ids.includes((r as { id: string }).id)), error: null }
        },
      }),
    }))
    return { client: () => ({ from }) as never, reads }
  }

  it('one read per table for every ask settled in the same tick; a settled one is never read again', async () => {
    const { client: c, reads } = client({
      tool_approval: [{ id: 'a1', status: 'approved', success: true }, { id: 'a2', status: 'denied', success: null }],
      attention_item: [{ id: 'c1', status: 'accepted' }],
    })
    const [one, two, three, mine] = await Promise.all([
      loadAskOutcome(c, { approvalId: 'a1', cardId: 'x1' }),
      loadAskOutcome(c, { approvalId: 'a2' }),
      loadAskOutcome(c, { cardId: 'c1' }),
      loadAskOutcome(c, { approvalId: 'a3' }),
    ])
    expect([one, two, three, mine]).toEqual(['approved', 'declined', 'answered', 'theirs'])
    expect(reads).toEqual([
      { table: 'tool_approval', ids: ['a1', 'a2', 'a3'] },
      { table: 'attention_item', ids: ['c1'] },
    ])
    expect(knownAskOutcome({ approvalId: 'a1' })).toBe('approved')
    // Someone else's is never kept: it is read again next time.
    expect(knownAskOutcome({ approvalId: 'a3' })).toBeUndefined()
    await loadAskOutcome(c, { approvalId: 'a1' })
    expect(reads).toHaveLength(2)
    // The person just acted: fresh.
    await loadAskOutcome(c, { approvalId: 'a1' }, { fresh: true })
    expect(reads).toHaveLength(3)
  })

  it('a pending one is read again next time; a failed read says waiting', async () => {
    const { client: c, reads } = client({ tool_approval: [{ id: 'a1', status: 'pending' }] })
    expect(await loadAskOutcome(c, { approvalId: 'a1' })).toBe('waiting')
    expect(await loadAskOutcome(c, { approvalId: 'a1' })).toBe('waiting')
    expect(reads).toHaveLength(2)
    const broken = () => ({ from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) }) }) as never
    expect(await loadAskOutcome(broken, { approvalId: 'a9' })).toBe('waiting')
  })
})
