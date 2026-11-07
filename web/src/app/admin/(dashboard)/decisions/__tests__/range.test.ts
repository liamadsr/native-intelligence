import { describe, expect, it } from 'vitest'
import { resolveDecisionRange } from '../range'

const now = new Date('2026-10-04T20:30:00Z')
describe('decision dashboard ranges', () => {
  it('uses an inclusive UTC date picker and exclusive bounded database end', () => {
    expect(resolveDecisionRange({}, now)).toEqual({ ok: true, range: {
      preset: 'last_7_days', from: '2026-09-28T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z',
      fromDate: '2026-09-28', toDate: '2026-10-04',
    } })
    expect(resolveDecisionRange({ preset: 'custom', from: '2026-10-04', to: '2026-10-04' }, now)).toMatchObject({
      ok: true, range: { from: '2026-10-04T00:00:00.000Z', to: '2026-10-05T00:00:00.000Z' },
    })
  })
  it.each([
    { preset: 'custom', from: '2026-02-30', to: '2026-03-01' },
    { preset: 'custom', from: '2026-10-04', to: '2026-10-03' },
    { preset: 'custom', from: '2026-01-01', to: '2026-10-04' },
    { preset: 'custom', from: '2026-10-04', to: '2026-10-05' },
    { preset: 'custom', from: ['2026-10-01', '2026-10-02'], to: '2026-10-04' },
    { preset: ['last_7_days', 'custom'] }, { preset: 'all_time' },
    { workspace: 'invalid' }, { workspace: ['a', 'b'] },
  ])('rejects malformed or unbounded filters without a broader query: %j', params => {
    expect(resolveDecisionRange(params, now).ok).toBe(false)
  })
  it('accepts exactly 90 days and preserves workspace scope', () => {
    const result = resolveDecisionRange({ preset: 'custom', from: '2026-07-07', to: '2026-10-04',
      workspace: 'AA5DC58B-C0CF-4332-BBDC-AC622826D388' }, now)
    expect(result).toMatchObject({ ok: true, range: { workspaceId: 'aa5dc58b-c0cf-4332-bbdc-ac622826d388' } })
  })
  it('handles month and year boundaries in UTC', () => {
    expect(resolveDecisionRange({ preset: 'last_month' }, new Date('2026-01-01T00:30:00Z'))).toMatchObject({
      ok: true, range: { fromDate: '2025-12-01', toDate: '2025-12-31' },
    })
  })
})
