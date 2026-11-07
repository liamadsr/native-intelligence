import { createHash } from 'node:crypto'

/**
 * The cloud browser's approvals (docs/plans/cloud-browser.md, C2, decision 5).
 * A task that reaches a sensitive step (a purchase, a send) can't ask in a
 * dialog: it stops, the person gets an approval card for that exact step, and
 * their Accept replays the task with a grant. The grant lets through only the
 * step it names: the same origin, the same target and the same context (refs
 * change between runs, so they can't be part of it). It comes only from the
 * person's own Accept (approved-call.ts), never from the model's arguments.
 */

/** What an approval card records about the step, and what the replay's grant carries. */
export interface BrowserApprovalContext {
  origin: string
  /** The control the step acts on ("Place order", "Press Enter in Message"). */
  target: string
  /** sha256 of the step's surrounding context, as the executor described it. */
  context_hash: string
}

export interface BrowserApprovalGrant extends BrowserApprovalContext {
  approval_id: string
}

const MAX = 300

/**
 * The executor's approval summary (task-executor.ts): the target, its context
 * and the page's origin, one per line. Null when it isn't one.
 */
export function browserApprovalStep(summary: string): BrowserApprovalContext | null {
  const lines = summary.split('\n')
  if (lines.length < 3) return null
  const target = lines[0].trim().slice(0, MAX)
  const origin = lines[lines.length - 1].trim()
  let parsed: URL
  try { parsed = new URL(origin) } catch { return null }
  if (!target || parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return null
  const context = lines.slice(1, -1).join('\n')
  return { origin, target, context_hash: createHash('sha256').update(context, 'utf8').digest('hex') }
}

/** Whether `grant` lets this exact step through. */
export function grantCovers(grant: BrowserApprovalGrant | null | undefined, summary: string): boolean {
  const step = browserApprovalStep(summary)
  return !!grant && !!step && grant.origin === step.origin && grant.target === step.target && grant.context_hash === step.context_hash
}

/** A grant from a queued task's request, or null (any other shape is no grant). */
export function readApprovalGrant(value: unknown): BrowserApprovalGrant | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const grant = value as Record<string, unknown>
  return ['approval_id', 'origin', 'target', 'context_hash'].every(key => typeof grant[key] === 'string' && (grant[key] as string).length > 0)
    ? grant as unknown as BrowserApprovalGrant : null
}
