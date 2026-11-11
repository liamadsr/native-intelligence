/**
 * The ranges "Copy availability" offers (./copy-text.ts works them out on
 * the server). Its own module so the calendar's toolbar can name them
 * without bundling the server read. Pure.
 */
export const COPY_RANGES = ['today', 'this_week', 'next_7_days', 'next_14_days'] as const
export type CopyRange = (typeof COPY_RANGES)[number]

export const COPY_RANGE_LABELS: Record<CopyRange, string> = {
  today: 'Today',
  this_week: 'This week',
  next_7_days: 'Next 7 days',
  next_14_days: 'Next 14 days',
}

export function isCopyRange(value: unknown): value is CopyRange {
  return typeof value === 'string' && (COPY_RANGES as readonly string[]).includes(value)
}
