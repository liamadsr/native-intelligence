import { AdminPageHeader } from '@/components/admin/shared'
import { AiUsageRangePicker } from '@/components/admin/ai-usage-range-picker'
import { AiUsageSourceToggle } from '@/components/admin/ai-usage-source-toggle'
import { LogsUsageView } from './logs-view'
import { GatewayUsageView } from './gateway-view'

export const dynamic = 'force-dynamic'

type PresetId =
  | 'this_month'
  | 'last_month'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'custom'

// The two reporting sources. 'gateway' reads the Vercel AI Gateway /v1/report
// (Phase B — docs/plans/gateway-usage-tracking.md); 'logs' reads the legacy
// ai_usage_logs table. Switchable per-request via the ?source= param + toggle.
type Source = 'gateway' | 'logs'

interface ResolvedRange {
  preset: PresetId
  from: Date
  to: Date
  label: string
}

// Resolves the ?preset=&from=&to= searchParams into a concrete [from, to) range.
// `to` is exclusive — the SQL uses `created_at < to`.
function resolveRange(searchParams: Record<string, string | string[] | undefined>): ResolvedRange {
  const rawPreset = typeof searchParams.preset === 'string' ? searchParams.preset : undefined
  const rawFrom = typeof searchParams.from === 'string' ? searchParams.from : undefined
  const rawTo = typeof searchParams.to === 'string' ? searchParams.to : undefined

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfTomorrow = new Date(startOfToday)
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1)

  function rangeFromPreset(p: PresetId): { from: Date; to: Date } {
    switch (p) {
      case 'last_month': {
        const from = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const to = new Date(now.getFullYear(), now.getMonth(), 1)
        return { from, to }
      }
      case 'last_7_days': {
        const from = new Date(startOfToday)
        from.setDate(from.getDate() - 6)
        return { from, to: startOfTomorrow }
      }
      case 'last_30_days': {
        const from = new Date(startOfToday)
        from.setDate(from.getDate() - 29)
        return { from, to: startOfTomorrow }
      }
      case 'last_90_days': {
        const from = new Date(startOfToday)
        from.setDate(from.getDate() - 89)
        return { from, to: startOfTomorrow }
      }
      case 'this_month':
      default: {
        const from = new Date(now.getFullYear(), now.getMonth(), 1)
        const to = new Date(now.getFullYear(), now.getMonth() + 1, 1)
        return { from, to }
      }
    }
  }

  let preset: PresetId
  let from: Date
  let to: Date

  const customFrom = rawFrom ? new Date(rawFrom) : null
  const customTo = rawTo ? new Date(rawTo) : null

  // A malformed custom range in the URL falls back to the default preset
  // (an Invalid Date would throw in toISOString below).
  if (
    rawPreset === 'custom' &&
    customFrom &&
    customTo &&
    !Number.isNaN(customFrom.getTime()) &&
    !Number.isNaN(customTo.getTime())
  ) {
    preset = 'custom'
    from = customFrom
    // Custom range end date is inclusive in the picker — add one day for the exclusive upper bound.
    to = customTo
    to.setDate(to.getDate() + 1)
  } else {
    const p = (rawPreset ?? 'this_month') as PresetId
    preset = p === 'custom' ? 'this_month' : p
    const r = rangeFromPreset(preset)
    from = r.from
    to = r.to
  }

  const lastDayOfRange = new Date(to)
  lastDayOfRange.setDate(lastDayOfRange.getDate() - 1)

  const sameYear = from.getFullYear() === lastDayOfRange.getFullYear()
  const fmt: Intl.DateTimeFormatOptions = sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' }
  const label = `${from.toLocaleDateString(undefined, fmt)} – ${lastDayOfRange.toLocaleDateString(
    undefined,
    { month: 'short', day: 'numeric', year: 'numeric' },
  )}`

  return { preset, from, to, label }
}

function toISODate(d: Date) {
  return d.toISOString().slice(0, 10)
}

// Resolves the ?source= param. Default follows the staged-rollout flag:
// GATEWAY_USAGE_REPORTING=all → Gateway by default, otherwise the legacy Logs
// view (repo convention: staged flags compare === 'all').
function resolveSource(searchParams: Record<string, string | string[] | undefined>): Source {
  const raw = typeof searchParams.source === 'string' ? searchParams.source : undefined
  if (raw === 'gateway' || raw === 'logs') return raw
  return process.env.GATEWAY_USAGE_REPORTING === 'all' ? 'gateway' : 'logs'
}

export default async function AIUsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const range = resolveRange(sp)
  const source = resolveSource(sp)

  // For the picker: the custom-range end date is stored inclusive in the URL, but `range.to` is exclusive.
  const pickerFromISO = toISODate(range.from)
  const pickerToInclusive = new Date(range.to)
  pickerToInclusive.setDate(pickerToInclusive.getDate() - 1)
  const pickerToISO = toISODate(pickerToInclusive)

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <AdminPageHeader title="AI Usage" description="Monitor AI API costs and usage across all users" />
        <div className="flex items-center gap-3">
          <AiUsageSourceToggle source={source} />
          <AiUsageRangePicker presetId={range.preset} from={pickerFromISO} to={pickerToISO} />
        </div>
      </div>

      {source === 'gateway' ? (
        <GatewayUsageView from={range.from} to={range.to} label={range.label} />
      ) : (
        <LogsUsageView from={range.from} to={range.to} label={range.label} />
      )}
    </div>
  )
}
