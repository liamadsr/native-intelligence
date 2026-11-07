import type {
  BrowserCommandReportRow, BrowserRunReport, DecisionFeature, DecisionFeatureReport, DecisionReport,
  Distribution, PolicyOutcomes, ReportRange, ReportRows, SourceCoverage, UsageReportRow, UsageTotals,
} from './types'
import { isDecisionUsage, isParentUsage, isFieldTextUsage } from './provenance'

const FEATURES: [DecisionFeature, string][] = [
  ['browser', 'Browser'], ['email', 'Email'], ['knowledge', 'Knowledge'],
  ['retrieval', 'Retrieval'], ['automation', 'Automation'],
]
export const MAX_VISIBLE_RUNS = 200

function number(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
  const result = Number(value)
  return Number.isFinite(result) && result >= 0 ? result : null
}
function boolean(value: unknown): boolean | null {
  return value === true || value === 'true' ? true : value === false || value === 'false' ? false : null
}
function emptyUsage(): UsageTotals {
  return { rows: 0, knownCostUsd: 0, knownInputTokens: 0, knownOutputTokens: 0,
    incompleteUsageRows: 0, unknownCostRows: 0, unknownInputTokenRows: 0, unknownOutputTokenRows: 0, catalogCostRows: 0 }
}
function emptyPolicy(): PolicyOutcomes { return { accepted: 0, escalated: 0, cancelled: 0, other: 0 } }
function usage(rows: UsageReportRow[]): UsageTotals {
  const result = emptyUsage()
  for (const row of rows) {
    result.rows++
    const cost = number(row.estimated_cost_usd)
    const input = number(row.input_tokens)
    const output = number(row.output_tokens)
    const knownTokens = boolean(row.usage_unknown) === false
    if (!knownTokens) result.incompleteUsageRows++
    const inputReported = boolean(row.input_tokens_reported)
    const outputReported = boolean(row.output_tokens_reported)
    // Placeholder zeroes in the billing ledger do not prove usage was supplied.
    const inputKnown = input !== null && (inputReported === true || (inputReported === null && knownTokens))
    const outputKnown = output !== null && (outputReported === true || (outputReported === null && knownTokens))
    const costUnknown = boolean(row.cost_unknown)
    const costKnown = cost !== null && costUnknown !== true && (costUnknown === false ||
      ['gateway', 'catalog', 'eve_reported'].includes(row.cost_source ?? ''))
    if (inputKnown) result.knownInputTokens += input
    else result.unknownInputTokenRows++
    if (outputKnown) result.knownOutputTokens += output
    else result.unknownOutputTokenRows++
    if (costKnown) {
      result.knownCostUsd += cost
      if (row.cost_source === 'catalog') result.catalogCostRows++
    } else result.unknownCostRows++
  }
  return result
}
function policy(rows: UsageReportRow[]): PolicyOutcomes {
  const result = emptyPolicy()
  for (const row of rows) {
    if (row.outcome === 'accepted') result.accepted++
    else if (row.outcome === 'cancelled') result.cancelled++
    else if (['escalate', 'deadline_exceeded', 'unavailable'].includes(row.outcome ?? '')) result.escalated++
    else result.other++
  }
  return result
}
/** Linear interpolation, retaining the sample count so sparse percentiles are visible. */
export function distribution(values: (number | null)[]): Distribution {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
  const percentile = (fraction: number) => {
    if (!sorted.length) return null
    const index = (sorted.length - 1) * fraction
    const lower = Math.floor(index)
    return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
  }
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) }
}
function feature(row: UsageReportRow): DecisionFeature {
  const key = row.feature.split('.')[1]
  return FEATURES.some(([value]) => value === key) ? key as DecisionFeature : 'other'
}
function inRange(row: { created_at: string; workspace_id?: string | null }, range: ReportRange): boolean {
  const time = Date.parse(row.created_at)
  return time >= Date.parse(range.from) && time < Date.parse(range.to) && (!range.workspaceId || row.workspace_id === range.workspaceId)
}
function uniqueUsage(rows: UsageReportRow[]): UsageReportRow[] {
  const ids = new Set<string>()
  const identities = new Set<string>()
  return rows.filter(row => {
    const identity = row.usage_key ? `${row.user_id}:key:${row.usage_key}` :
      row.inference_id ? `${row.user_id}:${row.feature}:inference:${row.inference_id}` : `id:${row.id}`
    if (ids.has(row.id) || identities.has(identity)) return false
    ids.add(row.id)
    identities.add(identity)
    return true
  })
}
function duration(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const difference = Date.parse(to) - Date.parse(from)
  return Number.isFinite(difference) && difference >= 0 ? difference : null
}
function outcome(row: BrowserCommandReportRow): BrowserRunReport['outcome'] {
  if (['waiting_for_device', 'claimed', 'running'].includes(row.status)) return 'pending'
  if (['failed', 'denied', 'expired'].includes(row.status)) return 'failed'
  if (row.status === 'completed' && ['verified', 'escalate', 'cancelled'].includes(row.task_status ?? '')) {
    return row.task_status as 'verified' | 'escalate' | 'cancelled'
  }
  return 'unknown'
}
function attribution(row: BrowserCommandReportRow): string | null {
  return number(row.attribution_version) === 1 && row.parent_run_id ? row.parent_run_id : null
}
function parentKey(row: { user_id: string; workspace_id?: string | null }, parentRunId: string) {
  return JSON.stringify([row.user_id, row.workspace_id, parentRunId])
}
function source(rows: number, provided?: SourceCoverage): SourceCoverage {
  return provided ?? { rows, partial: false, truncated: false, error: null }
}

export function aggregateDecisionReport(range: ReportRange, rows: ReportRows, generatedAt = new Date().toISOString()): DecisionReport {
  const decisions = uniqueUsage(rows.decisions.filter(row => isDecisionUsage(row) && inRange(row, range)))
  const commandIds = new Set<string>()
  const commands = rows.browserCommands.filter(row => {
    if (!inRange(row, range) || commandIds.has(row.id)) return false
    commandIds.add(row.id)
    return true
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
  const byFeature = new Map<DecisionFeature, UsageReportRow[]>()
  for (const row of decisions) {
    const key = feature(row)
    if (!byFeature.has(key)) byFeature.set(key, [])
    byFeature.get(key)!.push(row)
  }
  const featureKeys = byFeature.has('other') ? [...FEATURES, ['other', 'Other'] as [DecisionFeature, string]] : FEATURES
  const features: DecisionFeatureReport[] = featureKeys.map(([key, label]) => {
    const values = byFeature.get(key) ?? []
    return { key, label, attempts: values.length, policy: policy(values), usage: usage(values),
      providerMs: distribution(values.map(row => number(row.provider_ms))),
      serviceBeforeAccountingMs: distribution(values.map(row => number(row.total_before_accounting_ms))) }
  })
  const parentCommands = new Map<string, BrowserCommandReportRow[]>()
  for (const row of commands) {
    const parentId = attribution(row)
    if (parentId) {
      const key = parentKey(row, parentId)
      parentCommands.set(key, [...(parentCommands.get(key) ?? []), row])
    }
  }
  const commandsById = new Map(commands.map(row => [row.id, row]))
  const parents = uniqueUsage(rows.parentUsage.filter(row => {
    if (!isParentUsage(row) || !inRange(row, range) || number(row.attribution_version) !== 1 || !row.parent_run_id ||
        !['eve_turn', 'eve_compaction'].includes(row.usage_scope ?? '')) return false
    const key = parentKey(row, row.parent_run_id)
    const explicit = Array.isArray(row.browser_command_ids) ? row.browser_command_ids.slice(0, 50) : []
    const linked = new Map((parentCommands.get(key) ?? []).map(command => [command.id, command]))
    for (const id of explicit) {
      const command = typeof id === 'string' ? commandsById.get(id) : undefined
      if (command && command.user_id === row.user_id && command.workspace_id === row.workspace_id) linked.set(command.id, command)
    }
    if (!linked.size) return false
    parentCommands.set(key, [...linked.values()])
    return true
  }))
  const parentsByKey = new Map<string, UsageReportRow[]>()
  for (const row of parents) {
    const key = parentKey(row, row.parent_run_id!)
    if (!parentsByKey.has(key)) parentsByKey.set(key, [])
    parentsByKey.get(key)!.push(row)
  }
  const linkedDecisions = decisions.filter(row => {
    const command = row.run_id ? commandsById.get(row.run_id) : undefined
    return row.feature === 'decision.browser.next_action' && command && row.user_id === command.user_id && row.workspace_id === command.workspace_id
  })
  const decisionsByCommand = new Map<string, UsageReportRow[]>()
  for (const row of linkedDecisions) {
    if (!decisionsByCommand.has(row.run_id!)) decisionsByCommand.set(row.run_id!, [])
    decisionsByCommand.get(row.run_id!)!.push(row)
  }
  const fieldText = uniqueUsage((rows.fieldTextUsage ?? []).filter(row => {
    const command = row.run_id ? commandsById.get(row.run_id) : undefined
    return isFieldTextUsage(row) && inRange(row, range) && command && row.user_id === command.user_id && row.workspace_id === command.workspace_id
  }))
  const commandsWithParents = new Set([...parentsByKey.keys()].flatMap(key => parentCommands.get(key)!.map(row => row.id)))
  const correlatedCommandIds = new Set([...commandsWithParents, ...commands.filter(row => attribution(row) !== null).map(row => row.id)])
  const runs: BrowserRunReport[] = commands.map(row => ({
    commandId: row.id, workspaceId: row.workspace_id, createdAt: row.created_at, queueStatus: row.status,
    outcome: outcome(row), parentRunId: attribution(row), jev: usage(decisionsByCommand.get(row.id) ?? []),
    fieldText: usage(fieldText.filter(item => item.run_id === row.id)),
    queueMs: duration(row.created_at, row.claimed_at), setupMs: number(row.setup_ms),
    executorMs: number(row.executor_ms), endToEndMs: duration(row.created_at, row.finished_at),
  }))
  const coverage = {
    decisions: source(rows.decisions.length, rows.coverage?.decisions),
    browserCommands: source(rows.browserCommands.length, rows.coverage?.browserCommands),
    parentUsage: source(rows.parentUsage.length, rows.coverage?.parentUsage),
    fieldTextUsage: source(rows.fieldTextUsage?.length ?? 0, rows.coverage?.fieldTextUsage),
  }
  const notes = [
    'Attempts and policy acceptance cover logged provider calls only. Cache hits, deterministic skips, and pre-provider exits are not recorded in the usage ledger.',
    'Policy acceptance is evaluated before accounting and is not proof that the caller used the answer. Browser outcomes come from the final command result.',
    'Known spend and tokens are subtotals; unknown usage is never treated as a free call. Catalog-priced costs are estimates.',
    'Parent spend includes each explicitly correlated turn and compaction once, even when several browser tasks share the turn. It includes the whole turn, not only browser work.',
    'Usage and commands are independently bounded by this date range. In-flight or boundary-crossing work may have unmatched usage; this report does not establish savings against a baseline.',
  ]
  if (Object.values(coverage).some(value => value.partial)) notes.push('One or more sources are incomplete. Totals and percentiles describe only the rows loaded; narrow the range and retry.')
  return {
    range, generatedAt, features,
    overview: { attempts: decisions.length, policy: policy(decisions), usage: usage(decisions) },
    browser: {
      commands: commands.length,
      verified: runs.filter(row => row.outcome === 'verified').length,
      escalated: runs.filter(row => row.outcome === 'escalate').length,
      cancelled: runs.filter(row => row.outcome === 'cancelled').length,
      pending: runs.filter(row => row.outcome === 'pending').length,
      failed: runs.filter(row => row.outcome === 'failed').length,
      unknown: runs.filter(row => row.outcome === 'unknown').length,
      queueMs: distribution(runs.map(row => row.queueMs)), setupMs: distribution(runs.map(row => row.setupMs)),
      executorMs: distribution(runs.map(row => row.executorMs)), endToEndMs: distribution(runs.map(row => row.endToEndMs)),
      jev: usage(linkedDecisions), parent: usage(parents), fieldText: usage(fieldText),
      correlatedCommands: correlatedCommandIds.size,
      commandsWithParentUsage: commandsWithParents.size,
      unattributedCommands: commands.length - correlatedCommandIds.size,
      parentTurns: [...parentCommands.entries()].map(([key, linked]) => ({
        parentRunId: (JSON.parse(key) as [string, string, string])[2], commandIds: linked.map(row => row.id),
        usage: usage(parentsByKey.get(key) ?? []), usageRows: parentsByKey.get(key)?.length ?? 0,
      })),
      runs: runs.slice(0, MAX_VISIBLE_RUNS), runsOmitted: Math.max(0, runs.length - MAX_VISIBLE_RUNS),
    },
    coverage: { ...coverage, partial: Object.values(coverage).some(value => value.partial), notes },
  }
}
