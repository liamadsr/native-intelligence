export const DECISION_RANGE_MAX_DAYS = 90
const DAY_MS = 86_400_000
export const DECISION_RANGE_PRESETS = [
  ['last_7_days', 'Last 7 days'], ['last_30_days', 'Last 30 days'], ['last_90_days', 'Last 90 days'],
  ['this_month', 'This month'], ['last_month', 'Last month'], ['custom', 'Custom dates'],
] as const
export type DecisionRangePreset = (typeof DECISION_RANGE_PRESETS)[number][0]
export type DecisionSearchParams = Record<string, string | string[] | undefined>
export type DecisionRange = {
  preset: DecisionRangePreset; from: string; to: string; fromDate: string; toDate: string; workspaceId?: string
}
export type DecisionRangeResult = { ok: true; range: DecisionRange } | { ok: false; errors: string[]; range: DecisionRange }

function dateOnly(value: string | string[] | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null
}

/** Bounded UTC ranges; invalid filters never silently broaden a query. */
export function resolveDecisionRange(params: DecisionSearchParams, now = new Date()): DecisionRangeResult {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const tomorrow = today + DAY_MS
  const errors: string[] = []
  const rawPreset = params.preset ?? 'last_7_days'
  const preset = DECISION_RANGE_PRESETS.find(([id]) => id === rawPreset)?.[0] ?? 'last_7_days'
  if (!DECISION_RANGE_PRESETS.some(([id]) => id === rawPreset)) errors.push('Choose a valid date preset.')
  let from = today - 6 * DAY_MS
  let to = tomorrow
  if (preset === 'last_30_days') from = today - 29 * DAY_MS
  if (preset === 'last_90_days') from = today - 89 * DAY_MS
  if (preset === 'this_month') from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  if (preset === 'last_month') {
    from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  }
  if (preset === 'custom') {
    const start = dateOnly(params.from)
    const end = dateOnly(params.to)
    if (start === null || end === null) errors.push('Enter valid start and end dates.')
    else if (end < start) errors.push('The end date must be on or after the start date.')
    else if (end > today) errors.push('The end date cannot be in the future.')
    else if ((end - start) / DAY_MS + 1 > DECISION_RANGE_MAX_DAYS) errors.push('Choose a range of 90 days or less.')
    else { from = start; to = end + DAY_MS }
  }
  const rawWorkspace = params.workspace
  let workspaceId: string | undefined
  if (rawWorkspace !== undefined && rawWorkspace !== '') {
    if (typeof rawWorkspace !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawWorkspace)) {
      errors.push('Enter a valid workspace UUID or leave it blank for all workspaces.')
    } else workspaceId = rawWorkspace.toLowerCase()
  }
  const range: DecisionRange = { preset, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    fromDate: new Date(from).toISOString().slice(0, 10), toDate: new Date(to - DAY_MS).toISOString().slice(0, 10),
    ...(workspaceId ? { workspaceId } : {}),
  }
  return errors.length ? { ok: false, errors, range } : { ok: true, range }
}
