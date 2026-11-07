import { observationSchema } from './task-contract'
import { BROWSER_TASK_HARD_STOP_REASONS, BROWSER_TASK_PAGE_LIMIT_REASONS, BROWSER_TASK_WRITE_UNCERTAIN_REASONS } from './task-instructions'
/** Keep detailed execution telemetry in the queue, out of the parent model's context. */
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

const CONTINUE_GUIDANCE = 'Not verified: the browser stopped before confirming the whole goal. Its readings below are real page observations. If they answer the request, answer from them and say what was not confirmed. If more browser work is needed, call run_browser_task again with the remaining goal, tab_id set to this result tabId and no startUrl; it continues from the current page.'

const PAGE_LIMIT_GUIDANCE = 'Not verified: this page, as it is now, holds more than the browser agent can weigh in one step, so continuing from it (tab_id with no startUrl) stops the same way. Its readings below are real page observations. If they answer the request, answer from them and say what was not confirmed. Otherwise call run_browser_task once more with a startUrl that skips this step (for example a search URL carrying the query and dates), or tell the user which step the page blocked.'

const WRITE_UNCERTAIN_GUIDANCE = 'The last browser action may have taken effect. Check the readings for its result before continuing, and never repeat a submit, send or purchase without asking the user.'

function continuable(result: Record<string, unknown>): boolean {
  return result.status === 'escalate' && !BROWSER_TASK_HARD_STOP_REASONS.has(String(result.reason))
}

export function compactBrowserTaskResult(result: unknown): unknown {
  if (!record(result) || !['verified', 'escalate', 'cancelled'].includes(String(result.status)) || !Array.isArray(result.trace)) return result
  let inputTokens = 0, outputTokens = 0, costUsd = 0
  let inputCalls = 0, outputCalls = 0, costCalls = 0, unknownTokenCalls = 0, catalogCostCalls = 0, localRecoveries = 0, textCalls = 0, completionCalls = 0
  for (const step of result.trace) {
    const entry = record(step) ? step : {}
    if (entry.recovery === 'page_changed') localRecoveries++
    const calls = [entry.metrics]
    if (record(entry.completionMetrics)) { calls.push(entry.completionMetrics); completionCalls++ }
    if (record(entry.textMetrics) && entry.textMetrics.invoked === true) { calls.push(entry.textMetrics); textCalls++ }
    for (const metrics of calls) {
      const usage = record(metrics) && record(metrics.usage) ? metrics.usage : {}
      if (count(usage.inputTokens)) { inputTokens += usage.inputTokens; inputCalls++ }
      if (count(usage.outputTokens)) { outputTokens += usage.outputTokens; outputCalls++ }
      if (usage.known !== true || !count(usage.inputTokens) || !count(usage.outputTokens)) unknownTokenCalls++
      if (count(usage.costUsd)) {
        costUsd += usage.costUsd; costCalls++
        if (usage.costSource === 'catalog') catalogCostCalls++
      }
    }
  }
  const unknownCostCalls = result.trace.length + textCalls + completionCalls - costCalls
  const outcome = Object.fromEntries(['status', 'reason', 'message', 'blockedSite', 'url', 'evidence', 'linkEvidence', 'evidenceLedger', 'freshReadings', 'steps', 'elapsedMs', 'tabId', 'tab_id']
    .filter(key => key in result).map(key => [key, result[key]]))
  const sourceReferences = browserSourceReferences(result)
  const reason = String(result.reason)
  const next = !continuable(result) ? undefined : BROWSER_TASK_WRITE_UNCERTAIN_REASONS.has(reason)
    ? WRITE_UNCERTAIN_GUIDANCE + ' ' + CONTINUE_GUIDANCE : BROWSER_TASK_PAGE_LIMIT_REASONS.has(reason) ? PAGE_LIMIT_GUIDANCE : CONTINUE_GUIDANCE
  return { ...(next ? { next } : {}), ...(sourceReferences ? { sourceReferences } : {}), ...outcome, summary: { decisionCalls: result.trace.length + completionCalls, ...(completionCalls ? { completionCalls } : {}), ...(textCalls ? { textCalls } : {}), localRecoveries,
    usage: {
      ...(inputCalls ? { reportedInputTokens: inputTokens } : {}),
      ...(outputCalls ? { reportedOutputTokens: outputTokens } : {}),
      ...(costCalls ? { costUsd } : {}),
      unknownTokenCalls, unknownCostCalls, catalogCostCalls,
      complete: unknownTokenCalls === 0 && unknownCostCalls === 0,
    },
  } }
}

/** Ready-to-copy citations preserve opaque links without asking the parent to reconstruct them. */
function browserSourceReferences(result: Record<string, unknown>): { citations: string[]; truncated: boolean } | undefined {
  const fresh = record(result.freshReadings) ? result.freshReadings : null
  if (!fresh || !record(fresh.evidence)) return undefined
  const links = observationSchema.shape.evidence.unwrap().shape.documentLinks.safeParse(fresh.evidence.documentLinks)
  if (!links.success || !links.data?.length) return undefined
  const citations: string[] = []
  let bytes = 0, truncated = fresh.evidence.documentLinksTruncated === true
  for (const link of [...links.data].sort((a, b) => a.order - b.order)) {
    let url: URL
    try { url = new URL(link.destination) } catch { truncated = true; continue }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) { truncated = true; continue }
    const label = link.title.replace(/([\\[\]`*_<>])/g, '\\$1').replace(/\r?\n/g, ' ')
    // Native hrefs are canonical browser URLs. Escape Markdown delimiters only.
    const destination = link.destination.replace(/[<>\s]/g, character => encodeURIComponent(character))
    const citation = `[${label}](<${destination}>)`
    const size = new TextEncoder().encode(citation).length
    if (bytes + size > 12000) { truncated = true; break }
    bytes += size; citations.push(citation)
  }
  return citations.length ? { citations, truncated } : undefined
}
