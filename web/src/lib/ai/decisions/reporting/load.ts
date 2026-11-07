import 'server-only'
import { getAdminServiceClient, requireAdmin } from '@/lib/admin'
import { aggregateDecisionReport } from './aggregate'
import { DECISION_USAGE_PROVIDER, PARENT_USAGE_FEATURE, PARENT_USAGE_PROVIDERS, FIELD_TEXT_USAGE_FEATURE } from './provenance'
import type { BrowserCommandReportRow, DecisionReport, ReportRange, SourceCoverage, UsageReportRow } from './types'

export const REPORT_MAX_DAYS = 90
export const REPORT_PAGE_SIZE = 1000
export const REPORT_ROW_LIMITS = { decisions: 20000, browserCommands: 5000, parentUsage: 10000, fieldTextUsage: 10000 } as const
export const REPORT_TIMEOUT_MS = 15000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Project individual allowlisted fields in PostgREST. Fetching whole metadata,
// request, or result would unnecessarily load private email/page/answer content.
export const USAGE_PROJECTION = [
  'id', 'user_id', 'created_at', 'feature', 'provider', 'input_tokens', 'output_tokens', 'estimated_cost_usd',
  'workspace_id:metadata->>workspace_id', 'inference_id:metadata->>inference_id',
  'run_id:metadata->>run_id', 'outcome:metadata->>outcome', 'usage_unknown:metadata->>usage_unknown',
  'cost_unknown:metadata->>cost_unknown', 'cost_source:metadata->>cost_source',
  'input_tokens_reported:metadata->>input_tokens_reported', 'output_tokens_reported:metadata->>output_tokens_reported',
  'provider_ms:metadata->decision_timing_ms->>provider',
  'total_before_accounting_ms:metadata->decision_timing_ms->>total_before_accounting',
  'attribution_version:metadata->>attribution_version', 'parent_run_id:metadata->>parent_run_id',
  'usage_key:metadata->>usage_key', 'usage_scope:metadata->>usage_scope',
  'browser_command_ids:metadata->browser_command_ids',
].join(',')
export const COMMAND_PROJECTION = [
  'id', 'user_id', 'workspace_id', 'created_at', 'claimed_at', 'finished_at', 'status',
  'task_status:result->>status', 'executor_ms:result->>elapsedMs', 'setup_ms:result->telemetry->>setupMs',
  'attribution_version:request->attribution->>version', 'parent_run_id:request->attribution->>parent_run_id',
].join(',')

export function validateReportRange(input: ReportRange): ReportRange {
  const timestamp = (value: unknown) => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  if (!timestamp(input.from) || !timestamp(input.to)) throw new Error('Report dates must be valid UTC ISO timestamps.')
  const from = Date.parse(input.from)
  const to = Date.parse(input.to)
  if (to <= from || to - from > REPORT_MAX_DAYS * 86400000) throw new Error(`Report range must be between zero and ${REPORT_MAX_DAYS} days.`)
  if (input.workspaceId !== undefined && !UUID.test(input.workspaceId)) throw new Error('Workspace must be a UUID.')
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(input.workspaceId ? { workspaceId: input.workspaceId.toLowerCase() } : {}) }
}

type Page<T> = { data: T[] | null; error: unknown }
type Loaded<T> = { rows: T[]; coverage: SourceCoverage }
function empty<T>(): Loaded<T> { return { rows: [], coverage: { rows: 0, partial: false, truncated: false, error: null } } }
async function read<T>(query: () => PromiseLike<Page<T>>, signal: AbortSignal): Promise<Page<T>> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return query() }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
/** Fetch cap + one detection row, using inclusive ranges below Supabase's 1k ceiling. */
async function pages<T>(query: (from: number, to: number) => PromiseLike<Page<T>>, cap: number, signal: AbortSignal): Promise<Loaded<T>> {
  const result = empty<T>()
  try {
    let offset = 0
    while (offset <= cap) {
      const count = Math.min(REPORT_PAGE_SIZE, cap + 1 - offset)
      const response = await read(() => query(offset, offset + count - 1), signal)
      if (response.error || !Array.isArray(response.data)) throw new Error('Report source unavailable')
      const remaining = cap - result.rows.length
      result.rows.push(...response.data.slice(0, remaining))
      if (response.data.length > remaining) {
        result.coverage.truncated = true
        result.coverage.partial = true
        break
      }
      if (response.data.length < count) break
      offset += response.data.length
    }
  } catch {
    result.coverage.partial = true
    result.coverage.error = signal.aborted ? 'timeout' : 'unavailable'
  }
  result.coverage.rows = result.rows.length
  return result
}

/** Admin-only, bounded reads from the selected admin environment; never invokes a model. */
export async function loadDecisionReport(input: ReportRange): Promise<DecisionReport> {
  await requireAdmin()
  const range = validateReportRange(input)
  const db = await getAdminServiceClient()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new DOMException('Reporting deadline exceeded', 'TimeoutError')), REPORT_TIMEOUT_MS)
  const signal = controller.signal
  try {
    const usageQuery = () => {
      let query = db.from('ai_usage_logs').select(USAGE_PROJECTION)
        .gte('created_at', range.from).lt('created_at', range.to)
        .order('created_at', { ascending: true }).order('id', { ascending: true })
      if (range.workspaceId) query = query.eq('metadata->>workspace_id', range.workspaceId)
      return query
    }
    const [decisions, browserCommands] = await Promise.all([
      pages<UsageReportRow>((from, to) => usageQuery().eq('provider', DECISION_USAGE_PROVIDER).like('feature', 'decision.%').range(from, to).abortSignal(signal).returns<UsageReportRow[]>(), REPORT_ROW_LIMITS.decisions, signal),
      pages<BrowserCommandReportRow>((from, to) => {
        let query = db.from('browser_command_queue').select(COMMAND_PROJECTION).eq('command', 'run_task')
          .gte('created_at', range.from).lt('created_at', range.to)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
        if (range.workspaceId) query = query.eq('workspace_id', range.workspaceId)
        return query.range(from, to).abortSignal(signal).returns<BrowserCommandReportRow[]>()
      }, REPORT_ROW_LIMITS.browserCommands, signal),
    ])
    const parentUsage = empty<UsageReportRow>()
    // Parent IDs are provenance stamped by the tool dispatcher. The bounded OR
    // also finds later wait/read turns with server-returned command IDs. Each
    // batch may overlap; the pure aggregator deduplicates row and usage keys.
    const commands = browserCommands.rows.filter(row => UUID.test(row.id))
    for (let index = 0; index < commands.length; index += 50) {
      const batch = commands.slice(index, index + 50)
      const origins = [...new Set(batch.filter(row => String(row.attribution_version) === '1').map(row => row.parent_run_id)
        .filter((value): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:.\-]{1,512}$/.test(value)))]
      const conditions = batch.map(row => `metadata->browser_command_ids.cs.${JSON.stringify([row.id])}`)
      if (origins.length) conditions.push(`metadata->>parent_run_id.in.(${origins.map(value => JSON.stringify(value)).join(',')})`)
      const loaded = await pages<UsageReportRow>((from, to) => usageQuery()
        .eq('feature', PARENT_USAGE_FEATURE).in('provider', PARENT_USAGE_PROVIDERS)
        .eq('metadata->>attribution_version', '1').in('metadata->>usage_scope', ['eve_turn', 'eve_compaction'])
        .or(conditions.join(',')).range(from, to).abortSignal(signal).returns<UsageReportRow[]>(),
      REPORT_ROW_LIMITS.parentUsage - parentUsage.rows.length, signal)
      parentUsage.rows.push(...loaded.rows)
      parentUsage.coverage = { ...loaded.coverage, rows: parentUsage.rows.length }
      if (loaded.coverage.partial) break
      if (parentUsage.rows.length >= REPORT_ROW_LIMITS.parentUsage && index + 50 < commands.length) {
        parentUsage.coverage.partial = true
        parentUsage.coverage.truncated = true
        break
      }
    }
    const fieldTextUsage = empty<UsageReportRow>()
    for (let index = 0; index < commands.length; index += 50) {
      const ids = commands.slice(index, index + 50).map(row => row.id)
      const loaded = await pages<UsageReportRow>((from, to) => usageQuery()
        .eq('feature', FIELD_TEXT_USAGE_FEATURE).in('provider', PARENT_USAGE_PROVIDERS)
        .in('metadata->>run_id', ids).range(from, to).abortSignal(signal).returns<UsageReportRow[]>(),
      REPORT_ROW_LIMITS.fieldTextUsage - fieldTextUsage.rows.length, signal)
      fieldTextUsage.rows.push(...loaded.rows)
      fieldTextUsage.coverage = { ...loaded.coverage, rows: fieldTextUsage.rows.length }
      if (loaded.coverage.partial) break
      if (fieldTextUsage.rows.length >= REPORT_ROW_LIMITS.fieldTextUsage && index + 50 < commands.length) {
        fieldTextUsage.coverage.partial = true
        fieldTextUsage.coverage.truncated = true
        break
      }
    }
    if (browserCommands.coverage.partial) fieldTextUsage.coverage.partial = true
    // Missing command pages also hide their parent IDs; make that dependency
    // explicit rather than presenting a complete parent-spend total.
    if (browserCommands.coverage.partial) parentUsage.coverage.partial = true
    return aggregateDecisionReport(range, {
      decisions: decisions.rows, browserCommands: browserCommands.rows, parentUsage: parentUsage.rows, fieldTextUsage: fieldTextUsage.rows,
      coverage: { decisions: decisions.coverage, browserCommands: browserCommands.coverage, parentUsage: parentUsage.coverage, fieldTextUsage: fieldTextUsage.coverage },
    })
  } finally { clearTimeout(timeout) }
}
