import { describe, it, expect } from 'vitest'
import { dealInputFromBody } from '../deal-input'

describe('dealInputFromBody', () => {
  it('reads the board drag and inline edits', () => {
    expect(dealInputFromBody({ stage_id: 's1' })).toEqual({ ok: true, input: { stage: 's1' } })
    expect(dealInputFromBody({ owner_id: '' })).toEqual({ ok: true, input: { owner_id: null } })
    // A date picker's timestamp keeps its day.
    expect(dealInputFromBody({ expected_close_date: '2026-12-01T08:00:00.000Z' })).toEqual({ ok: true, input: { expected_close_date: '2026-12-01' } })
  })

  it('reads money typed with symbols and commas', () => {
    expect(dealInputFromBody({ value: '$12,500' })).toEqual({ ok: true, input: { value: 12500 } })
    expect(dealInputFromBody({ value: '' })).toEqual({ ok: true, input: { value: null } })
    expect(dealInputFromBody({ value: 'a lot' }).ok).toBe(false)
  })

  it('refuses a known key of the wrong type and ignores unknown keys', () => {
    expect(dealInputFromBody({ contact_ids: 'c1' }).ok).toBe(false)
    expect(dealInputFromBody({ custom_fields: [] }).ok).toBe(false)
    expect(dealInputFromBody({ workspace_id: 'other', name: 'Renewal' })).toEqual({ ok: true, input: { name: 'Renewal' } })
    expect(dealInputFromBody(null).ok).toBe(false)
  })
})
