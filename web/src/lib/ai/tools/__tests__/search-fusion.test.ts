/**
 * Unit tests for the pure RRF fusion helpers used by the `find` tool.
 * No DB, no network — just the ranking math.
 */
import { describe, it, expect } from 'vitest'
import {
  RRF_K,
  fuseWorkspaces,
  fuseByRank,
  resolveRecencyWeight,
  type FusableRow,
} from '../search-fusion'

const row = (over: Partial<FusableRow> & Pick<FusableRow, 'result_type' | 'result_id'>): FusableRow => ({
  ...over,
})

describe('fuseWorkspaces', () => {
  it('sorts a single workspace by score desc and trims to limit', () => {
    const rows: FusableRow[] = [
      row({ result_type: 'claim', result_id: 'a', score: 0.1, workspace_id: 'w1' }),
      row({ result_type: 'claim', result_id: 'b', score: 0.9, workspace_id: 'w1' }),
      row({ result_type: 'claim', result_id: 'c', score: 0.5, workspace_id: 'w1' }),
    ]
    const out = fuseWorkspaces([rows], 2)
    expect(out.map((r) => r.result_id)).toEqual(['b', 'c'])
  })

  it('merges rows across workspaces by score', () => {
    const w1: FusableRow[] = [row({ result_type: 'claim', result_id: 'a', score: 0.3, workspace_id: 'w1' })]
    const w2: FusableRow[] = [
      row({ result_type: 'claim', result_id: 'x', score: 0.8, workspace_id: 'w2' }),
      row({ result_type: 'claim', result_id: 'y', score: 0.2, workspace_id: 'w2' }),
    ]
    const out = fuseWorkspaces([w1, w2], 10)
    expect(out.map((r) => r.result_id)).toEqual(['x', 'a', 'y'])
  })

  it('dedupes the same (workspace,type,id) keeping the higher score', () => {
    const dup: FusableRow[] = [
      row({ result_type: 'capture', result_id: 'a', score: 0.2, workspace_id: 'w1' }),
      row({ result_type: 'capture', result_id: 'a', score: 0.7, workspace_id: 'w1' }),
    ]
    const out = fuseWorkspaces([dup], 10)
    expect(out).toHaveLength(1)
    expect(out[0].score).toBe(0.7)
  })

  it('does NOT dedupe the same id across different workspaces', () => {
    const w1: FusableRow[] = [row({ result_type: 'capture', result_id: 'a', score: 0.5, workspace_id: 'w1' })]
    const w2: FusableRow[] = [row({ result_type: 'capture', result_id: 'a', score: 0.6, workspace_id: 'w2' })]
    const out = fuseWorkspaces([w1, w2], 10)
    expect(out).toHaveLength(2)
  })

  it('treats a missing score as 0', () => {
    const rows: FusableRow[] = [
      row({ result_type: 'claim', result_id: 'a', workspace_id: 'w1' }),
      row({ result_type: 'claim', result_id: 'b', score: 0.1, workspace_id: 'w1' }),
    ]
    const out = fuseWorkspaces([rows], 10)
    expect(out.map((r) => r.result_id)).toEqual(['b', 'a'])
  })
})

describe('fuseByRank', () => {
  it('fuses two streams by rank using 1/(k+rank)', () => {
    const streamA: FusableRow[] = [
      row({ result_type: 'claim', result_id: 'a', workspace_id: 'w1' }),
      row({ result_type: 'claim', result_id: 'b', workspace_id: 'w1' }),
    ]
    const streamB: FusableRow[] = [
      row({ result_type: 'attachment', result_id: 'x', workspace_id: 'w1' }),
    ]
    const out = fuseByRank([streamA, streamB], 10)
    // a: 1/(60+1); x: 1/(60+1); b: 1/(60+2). a and x tie above b.
    const aScore = out.find((r) => r.result_id === 'a')!.fused_score
    const xScore = out.find((r) => r.result_id === 'x')!.fused_score
    const bScore = out.find((r) => r.result_id === 'b')!.fused_score
    expect(aScore).toBeCloseTo(1 / (RRF_K + 1))
    expect(xScore).toBeCloseTo(1 / (RRF_K + 1))
    expect(aScore).toBeGreaterThan(bScore)
  })

  it('sums contributions when a row appears in multiple streams', () => {
    const streamA: FusableRow[] = [row({ result_type: 'claim', result_id: 'a', workspace_id: 'w1' })]
    const streamB: FusableRow[] = [
      row({ result_type: 'x', result_id: 'z', workspace_id: 'w1' }),
      row({ result_type: 'claim', result_id: 'a', workspace_id: 'w1' }),
    ]
    const out = fuseByRank([streamA, streamB], 10)
    const a = out.find((r) => r.result_id === 'a')!
    // a is rank 1 in A and rank 2 in B → 1/61 + 1/62
    expect(a.fused_score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2))
    // a should outrank z (rank-1 in B only)
    expect(out[0].result_id).toBe('a')
  })

  it('trims to the limit', () => {
    const stream: FusableRow[] = Array.from({ length: 5 }, (_, i) =>
      row({ result_type: 'claim', result_id: String(i), workspace_id: 'w1' }),
    )
    const out = fuseByRank([stream], 3)
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.result_id)).toEqual(['0', '1', '2'])
  })

  it('preserves the original row fields alongside fused_score', () => {
    const stream: FusableRow[] = [row({ result_type: 'claim', result_id: 'a', title: 'hi', workspace_id: 'w1' })]
    const out = fuseByRank([stream], 10)
    expect(out[0].title).toBe('hi')
    expect(typeof out[0].fused_score).toBe('number')
  })
})

describe('resolveRecencyWeight', () => {
  it('returns the explicit value when provided', () => {
    expect(resolveRecencyWeight(1.5, null)).toBe(1.5)
    expect(resolveRecencyWeight(0, '2020-01-01T00:00:00.000Z')).toBe(0)
  })

  it('defaults to 0.5 when no window is set', () => {
    expect(resolveRecencyWeight(undefined, null)).toBe(0.5)
  })

  it('auto-raises to 1.0 for a tight window (<= 45 days)', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    expect(resolveRecencyWeight(undefined, tenDaysAgo)).toBe(1.0)
  })

  it('stays at 0.5 for a wide window (> 45 days)', () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
    expect(resolveRecencyWeight(undefined, ninetyDaysAgo)).toBe(0.5)
  })

  it('treats exactly 45 days as tight (boundary)', () => {
    const fortyFive = new Date(Date.now() - 45 * 86_400_000 + 1000).toISOString()
    expect(resolveRecencyWeight(undefined, fortyFive)).toBe(1.0)
  })
})
