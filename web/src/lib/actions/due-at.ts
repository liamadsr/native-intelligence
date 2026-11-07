/**
 * `actions.due_at` is a timestamptz; a proposal's `due_date` (a Postgres
 * `date`) and a model's "due 2026-10-21" are bare days. Written as-is, a bare
 * day lands at UTC midnight, which every action view (they read `due_at` as an
 * instant in the viewer's zone) shows as the PREVIOUS day anywhere west of UTC,
 * and marks overdue the evening before. Noon UTC keeps the same calendar day
 * for every offset from UTC-11 to UTC+11. Anything that is not a bare day (a
 * full timestamp, '' or null to clear) passes through untouched.
 */
export function dueAtFromDate<T extends string | null | undefined>(value: T): T | string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value
}
