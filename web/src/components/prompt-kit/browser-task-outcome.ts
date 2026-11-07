import { BROWSER_TASK_HARD_STOP_REASONS } from '@/lib/browser-agent/task-instructions'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A blocked-sites entry ("linkedin.com"); anything else is not shown. */
function blockedSite(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 253 && /^[a-z0-9.:[\]-]+$/.test(value) ? value : null
}

function siteBlocked(result: Record<string, unknown>) {
  const site = blockedSite(result.blockedSite)
  return {
    label: 'Site blocked' as const,
    message: `You blocked the agent on ${site ?? 'this site'}. To let it continue, unblock it under Blocked sites in your agent's computer, then ask again.`,
  }
}

/** A completed tool transport can carry an incomplete browser goal. */
export function browserTaskOutcome(name: string, output: unknown): {
  label: 'Site blocked' | 'Needs attention' | 'Not verified' | 'Stopped' | 'Waiting for result'
  message?: string
} | null {
  if (!['run_browser_task', 'wait_for_browser_command'].includes(name) || !record(output)) return null
  if (output.success === true && (output.pending === true || output.still_running === true) &&
      typeof output.run_id === 'string' && output.run_id.length > 0) {
    // This is a saved receipt, not a subscription to current command status.
    return { label: 'Waiting for result', message: 'This update does not include a final result.' }
  }
  if (output.pending === true || output.still_running === true || output.done === false) return null
  // Refused by the server before anything was queued: its start page is blocked.
  if (output.site_blocked === true && record(output.result)) return siteBlocked(output.result)
  const completedTaskFailure = output.browser_command_status === 'completed' &&
    typeof output.browser_command_id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(output.browser_command_id) &&
    record(output.result) && ['escalate', 'cancelled'].includes(String(output.result.status))
  if (output.success === false && !completedTaskFailure) return { label: 'Needs attention' }
  if (!record(output.result)) return null
  const result = output.result
  if (result.status === 'cancelled') return { label: 'Stopped' }
  if (result.status !== 'escalate') return null
  // Unfinished tasks return what they read; the agent answers from it or continues.
  if (!BROWSER_TASK_HARD_STOP_REASONS.has(String(result.reason)))
    return { label: 'Not verified', message: 'The browser returned what it read without confirming the whole goal.' }
  if (result.reason !== 'site_blocked') return { label: 'Needs attention' }
  // The entry the user blocked, never the page's address: a kept-off
  // navigation leaves the old page in place.
  return siteBlocked(result)
}
