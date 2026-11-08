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
}

/** "Native Intelligence on Liam's MacBook" (one line, capped), or "Native Intelligence on your Mac". */
export function macJobAgentName(job: Pick<LocalAgentApprovalContext, 'deviceName'>): string {
  const name = (job.deviceName ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return name ? `Native Intelligence on ${name}` : 'Native Intelligence on your Mac'
}

/** "its job in dial8-website" (one line, capped), or "its job". */
export function macJobPlace(job: Pick<LocalAgentApprovalContext, 'folderLabel'>): string {
  const label = (job.folderLabel ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return label ? `its job in ${label}` : 'its job'
}

