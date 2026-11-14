/**
 * A job on the person's Mac, as an approval names it (C1, the Mac body's
 * tool route; docs/plans/teammate-agent.md, "Cards from the Mac body"). No
 * imports, so the reviewer (action-review.ts) and the approvals
 * (approvals.ts) share the words without loading each other.
 */

/**
 * A call from the Native Intelligence agent on the person's Mac (C1, the Mac body's tool
 * route): which job, on which Mac, in which folder. Set by that route from
 * the verified session, never from anything model-visible. Its cards land in
 * the home thread, are capped per job (APPROVAL_PENDING_MAX_PER_MAC_JOB),
 * and their words name the Mac and the job. The names are the person's own
 * (their Mac's name, their folder's label).
 */
export interface LocalAgentApprovalContext {
  /** The local_agent_session id. */
  sessionId: string
  deviceName?: string | null
  folderLabel?: string | null
  /** The person's own coding agent doing the job (migration 658), by its label ("Claude Code"); absent for Native Intelligence's own agent. */
  workerLabel?: string | null
}

/** "Native Intelligence on Studio Mac" (one line, capped), "Codex on Studio Mac" for a coding agent's job, or "… on your Mac". */
export function macJobAgentName(job: Pick<LocalAgentApprovalContext, 'deviceName' | 'workerLabel'>): string {
  const name = (job.deviceName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  const who = (job.workerLabel ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Native Intelligence'
  return name ? `${who} on ${name}` : `${who} on your Mac`
}

/** "its job in web" (one line, capped), or "its job". */
export function macJobPlace(job: Pick<LocalAgentApprovalContext, 'folderLabel'>): string {
  const label = (job.folderLabel ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return label ? `its job in ${label}` : 'its job'
}

