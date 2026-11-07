/** Content-free reporting DTOs. No decision answers, email bodies, or browser evidence. */
export type DecisionFeature = 'browser' | 'email' | 'knowledge' | 'retrieval' | 'automation' | 'other'
export interface ReportRange { from: string; to: string; workspaceId?: string }
export interface Distribution { samples: number; p50: number | null; p95: number | null }
export interface UsageTotals {
  rows: number
  knownCostUsd: number
  knownInputTokens: number
  knownOutputTokens: number
  unknownCostRows: number
  /** Reported fields can still omit failed/superseded work. */
  incompleteUsageRows: number
  unknownInputTokenRows: number
  unknownOutputTokenRows: number
  catalogCostRows: number
}
export interface PolicyOutcomes {
  accepted: number
  escalated: number
  cancelled: number
  other: number
}
export interface DecisionFeatureReport {
  key: DecisionFeature
  label: string
  /** Logged provider attempts only. Cache hits and pre-provider exits are not usage rows. */
  attempts: number
  policy: PolicyOutcomes
  usage: UsageTotals
  providerMs: Distribution
  /** Ends before accounting; this is not the caller's end-to-end latency. */
  serviceBeforeAccountingMs: Distribution
}
export interface SourceCoverage {
  rows: number
  /** A failed page or a row/time bound means displayed totals are partial. */
  partial: boolean
  truncated: boolean
  error: 'unavailable' | 'timeout' | null
}
export interface BrowserRunReport {
  commandId: string
  workspaceId: string
  createdAt: string
  queueStatus: string
  outcome: 'verified' | 'escalate' | 'cancelled' | 'pending' | 'failed' | 'unknown'
  parentRunId: string | null
  /** No parent cost is repeated on individual browser rows. See parentTurns. */
  jev: UsageTotals
  fieldText: UsageTotals
  queueMs: number | null
  setupMs: number | null
  executorMs: number | null
  endToEndMs: number | null
}
export interface ParentTurnReport {
  parentRunId: string
  commandIds: string[]
  usage: UsageTotals
  /** Distinct rows (turn + any compactions) counted once for this parent. */
  usageRows: number
}
export interface DecisionReport {
  range: ReportRange
  generatedAt: string
  features: DecisionFeatureReport[]
  overview: { attempts: number; policy: PolicyOutcomes; usage: UsageTotals }
  browser: {
    commands: number
    verified: number
    escalated: number
    cancelled: number
    pending: number
    failed: number
    unknown: number
    queueMs: Distribution
    setupMs: Distribution
    executorMs: Distribution
    endToEndMs: Distribution
    /** Jev rows exactly matched to command ID and workspace. */
    jev: UsageTotals
    /** Parent rows matched by explicit attribution v1; each row is counted once. */
    parent: UsageTotals
    /** On-demand field text, joined by exact command, user and workspace. */
    fieldText: UsageTotals
    correlatedCommands: number
    commandsWithParentUsage: number
    unattributedCommands: number
    parentTurns: ParentTurnReport[]
    /** Newest first, bounded separately from the aggregate. */
    runs: BrowserRunReport[]
    runsOmitted: number
  }
  coverage: {
    decisions: SourceCoverage
    browserCommands: SourceCoverage
    parentUsage: SourceCoverage
    fieldTextUsage: SourceCoverage
    partial: boolean
    notes: string[]
  }
}

/** Only safe projected columns are read from Supabase; JSON scalars may arrive as strings. */
export interface UsageReportRow {
  id: string
  user_id: string
  created_at: string
  feature: string
  provider: string
  input_tokens: number | null
  output_tokens: number | null
  estimated_cost_usd: number | string | null
  request_duration_ms?: number | null
  workspace_id?: string | null
  inference_id?: string | null
  run_id?: string | null
  outcome?: string | null
  usage_unknown?: boolean | string | null
  cost_unknown?: boolean | string | null
  cost_source?: string | null
  input_tokens_reported?: boolean | string | null
  output_tokens_reported?: boolean | string | null
  provider_ms?: number | string | null
  total_before_accounting_ms?: number | string | null
  attribution_version?: number | string | null
  parent_run_id?: string | null
  usage_key?: string | null
  usage_scope?: string | null
  browser_command_ids?: unknown
}
export interface BrowserCommandReportRow {
  id: string
  user_id: string
  workspace_id: string
  created_at: string
  claimed_at: string | null
  finished_at: string | null
  status: string
  task_status?: string | null
  executor_ms?: number | string | null
  setup_ms?: number | string | null
  attribution_version?: number | string | null
  parent_run_id?: string | null
}
export interface ReportRows {
  decisions: UsageReportRow[]
  browserCommands: BrowserCommandReportRow[]
  parentUsage: UsageReportRow[]
  fieldTextUsage?: UsageReportRow[]
  coverage?: Partial<Record<'decisions' | 'browserCommands' | 'parentUsage' | 'fieldTextUsage', SourceCoverage>>
}
