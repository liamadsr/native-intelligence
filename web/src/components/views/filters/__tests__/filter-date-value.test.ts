// @vitest-environment jsdom
/**
 * A DAY PICKED FOR A `date` COLUMN GOES OUT AS THAT DAY.
 *
 * project/initiative `target_date` and `start_date` are Postgres `date`
 * columns. The picker used to send local midnight as an ISO instant, which
 * east of UTC is the previous day in UTC — and Postgres casts that instant to
 * the previous date, so "target date is Oct 21" in Sydney matched Oct 20.
 * Timestamp fields (due_at, created_at…) keep the instant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { FILTERABLE_FIELDS } from '@/lib/views/types'
import { dateFilterValue, isDayOnlyDateField } from '../filter-value-picker'

const fieldOf = (entity: keyof typeof FILTERABLE_FIELDS, name: string) => {
  const def = FILTERABLE_FIELDS[entity].find(f => f.field === name)
  if (!def) throw new Error(`${entity} has no ${name} field`)
  return def
}

describe('date filter values', () => {
  const prevTz = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Australia/Sydney' })
  // Assigning undefined would set the string 'undefined'; delete instead.
  afterAll(() => { if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz })

  it('sends a bare local day for a date column, the instant for a timestamp', () => {
    const picked = new Date(2026, 9, 21) // local midnight, Oct 21, in Sydney
    expect(isDayOnlyDateField(fieldOf('project', 'target_date'))).toBe(true)
    expect(isDayOnlyDateField(fieldOf('project', 'start_date'))).toBe(true)
    expect(isDayOnlyDateField(fieldOf('initiative', 'target_date'))).toBe(true)
    expect(isDayOnlyDateField(fieldOf('action', 'due_at'))).toBe(false)

    expect(dateFilterValue(picked, true)).toBe('2026-10-21')
    expect(dateFilterValue(picked, false)).toBe('2026-10-20T13:00:00.000Z')
  })
})
