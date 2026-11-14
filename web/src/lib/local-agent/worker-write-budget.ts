/**
 * A write budget per job on the person's own coding agent (migration 658's
 * worker): the bound on a runaway agent's ordinary writes (cards, comments,
 * documents: internal writes the reviewer never sees, and a coding agent
 * accrues no Native Intelligence AI usage for the usage limit to stop). At most
 * {@link WORKER_WRITES_PER_WINDOW} writes in any {@link WORKER_WRITE_WINDOW_MS}, and
 * {@link WORKER_WRITES_PER_JOB} over the job's life. A batch counts its items
 * (the longest list in its input), anything else 1. Reads never count.
 *
 * PROCESS-LOCAL, like the Mac's web caps (web-tools.ts): one server process
 * counts its own calls, so a restart (a roll-out) or a second process starts
 * the count again, which only ever loosens it. Abuse insurance, not an
 * accounting: no column or table holds it.
 */
import { getToolSideEffect } from '@/lib/ai/tool-registry'

export const WORKER_WRITES_PER_WINDOW = 40
export const WORKER_WRITE_WINDOW_MS = 10 * 60_000
export const WORKER_WRITES_PER_JOB = 400
export const WRITE_BUDGET_CODE = 'WRITE_BUDGET'

/** What the agent reads when its budget is spent. */
export const WRITE_BUDGET_MESSAGE =
  'Nothing ran: this job has reached its limit of writes to the workspace. Stop writing, finish now, and say in your finish summary that you reached the write limit and what was left undone.'

/** Soft cap on tracked jobs before the oldest is dropped. */
const MAX_TRACKED_JOBS = 5000

interface JobWrites {
  /** Each counted call: when, and how many writes it was. */
  recent: Array<{ at: number; n: number }>
  total: number
}

const jobs = new Map<string, JobWrites>()

/** Not a write: a registry read, or the worker's own search. */
export function isWorkerRead(toolName: string): boolean {
  if (toolName === 'search_tools') return true
  return getToolSideEffect(toolName) === 'read'
}

/** How many writes a call is: the longest list at the top of its input (a batch's items), at least 1. */
export function writesIn(input: unknown): number {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 1
  let most = 1
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (Array.isArray(value)) most = Math.max(most, value.length)
  }
  return most
}

/**
 * Count a call of a worker's job: allowed (and counted) while it fits both
 * limits; refused, and not counted, once it would not. Reads are always
 * allowed and never counted.
 */
export function countWorkerWrite(sessionId: string, toolName: string, input: unknown, now = Date.now()): { allowed: boolean } {
  if (isWorkerRead(toolName)) return { allowed: true }
  const n = writesIn(input)
  const job = jobs.get(sessionId) ?? { recent: [], total: 0 }
  job.recent = job.recent.filter((w) => now - w.at < WORKER_WRITE_WINDOW_MS)
  const inWindow = job.recent.reduce((sum, w) => sum + w.n, 0)
  if (inWindow + n > WORKER_WRITES_PER_WINDOW || job.total + n > WORKER_WRITES_PER_JOB) {
    jobs.set(sessionId, job)
    return { allowed: false }
  }
  job.recent.push({ at: now, n })
  job.total += n
  if (!jobs.has(sessionId) && jobs.size >= MAX_TRACKED_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest !== undefined) jobs.delete(oldest)
  }
  jobs.set(sessionId, job)
  return { allowed: true }
}

/** Test-only: forget the counts. */
export function __resetWorkerWriteBudget(): void {
  jobs.clear()
}
