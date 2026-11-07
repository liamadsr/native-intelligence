/**
 * "Which loops did the AI usage limit pause?" — the Flows view's banner (WS-4b).
 *
 * A distinct flow counts as paused when its MOST RECENT run inside the window
 * was the usage-limit failure (the pause the whole plan is about, F5). Any
 * other failure — a timeout, a hard error — is a plain failure, not a pause,
 * and a flow that succeeded after a pause clears.
 *
 * Pure builder + the row shape; the route (api/account/flows/paused) does the
 * one query. Lifted out of the retired loop-activity fan-in.
 */
import type { ActionResult, FlowRunStatus } from './types'

/** A failed run inside this window can still count as a pause. */
export const PAUSED_WINDOW_MS = 48 * 60 * 60 * 1000

/** The marker the work ledger keys on too (presentation.ts): the usage-limit
 *  block reads as "paused", not "failed". */
const USAGE_LIMIT_RE = /usage limit/i

export interface PausedFlow {
  flow_id: string
  flow_name: string
  /** When the pausing run fired. */
  at: string
}

/** The flow_run row the query returns (the flow embed may arrive as an array). */
export interface PausedFlowRunRow {
  id: string
  flow_id: string
  status: FlowRunStatus
  fired_at: string
  error_message: string | null
  action_results: ActionResult[] | null
  flow: { id: string; name: string } | Array<{ id: string; name: string }> | null
}

function firstOrSelf<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null
  return v ?? null
}

function firstActionError(results: ActionResult[] | null | undefined): string | null {
  if (!Array.isArray(results)) return null
  for (const r of results) {
    if (r?.error_message) return r.error_message
  }
  return null
}

export function isPausedError(...msgs: Array<string | null | undefined>): boolean {
  return msgs.some((m) => !!m && USAGE_LIMIT_RE.test(m))
}

/**
 * Distinct flows whose most recent run in the window was a usage-limit pause.
 * `runs` is newest-first: the first run seen per flow decides it.
 */
export function buildPausedFlows(runs: PausedFlowRunRow[]): PausedFlow[] {
  const out: PausedFlow[] = []
  const seen = new Set<string>()
  for (const run of runs) {
    const flow = firstOrSelf(run.flow)
    const flowId = flow?.id ?? run.flow_id
    if (seen.has(flowId)) continue
    seen.add(flowId) // decide each flow on its NEWEST run only
    if (run.status !== 'failed') continue
    if (!isPausedError(run.error_message, firstActionError(run.action_results))) continue
    out.push({ flow_id: flowId, flow_name: flow?.name ?? 'Loop', at: run.fired_at })
  }
  return out
}
