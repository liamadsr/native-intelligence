import { createHash } from 'node:crypto'
import { browserObservationState, type BrowserObservation, type BrowserTask } from './task-contract'

export function milestoneObservationDigest(observation: BrowserObservation): string {
  return createHash('sha256').update(browserObservationState(observation)).digest('hex')
}

/** Only the server's accepted decision can propose advancement. The following
 * fresh browser read must independently match before that proposal is committed.
 * No client-supplied milestone index or completion flag is accepted. */
export function currentMilestone(task: BrowserTask, request: Record<string, unknown>, observation: BrowserObservation): number {
  const index = request.milestoneIndex ?? 0
  if (!Number.isInteger(index) || typeof index !== 'number' || index < 0 || index >= (task.milestones?.length ?? 1)) {
    throw new Error('Invalid milestone progress')
  }
  const verification = request.milestoneVerification
  if (task.milestones && index < task.milestones.length - 1 &&
      typeof verification === 'object' && verification !== null && 'digest' in verification && 'observationId' in verification &&
      typeof verification.observationId === 'number' && Number.isInteger(verification.observationId) &&
      observation.observationId > verification.observationId &&
      verification.digest === milestoneObservationDigest(observation)) return index + 1
  return index
}
