/**
 * A customer's job is done (roadmap D3): the event the review request
 * follows, named and typed here like the prospecting events
 * (src/lib/inngest/client.ts), so a sender and the receiver can't drift.
 *
 * Who sends it (one event, two reasons):
 *   - 'done': complete_job, when the owner says a job is done ("the Smith
 *     rug is done", by text): job type 'action' (a board action) or 'manual'
 *     (that customer's job today); bookings (roadmap track B,
 *     a customer's meeting_booking) when one is done;
 *   - 'paid': a paid payment link (roadmap track C, the Connect webhook),
 *     jobRef the quote, booking or action it was for, or the
 *     payment_request itself.
 * Review requests follow the reasons in REVIEW_REQUEST_REASONS
 * (src/lib/inngest/outreach-functions.ts): asking only once a job is paid is
 * taking 'done' out of that set.
 *
 * At most one review request per customer per job: the receiver claims
 * (workspace, contact, job type, job id) before it sends, and a customer
 * asked in the last REVIEW_REQUEST_COOLDOWN_DAYS is not asked again (a job
 * marked done and then paid is one job under two refs). The event id
 * `job-completed:<type>:<id>:<contact>` lets Inngest drop a repeat of the
 * same job (the contact too: a manual job's id is only the day).
 */
import { inngest } from '@/lib/inngest/client'

export const JOB_COMPLETED_EVENT = 'job/completed' as const

/** What a job is, by where it lives: a booking or quote (track B), a board action, a payment request (track C), or the owner's word ('manual'). */
export const JOB_TYPES = ['booking', 'quote', 'action', 'payment_request', 'manual'] as const
export type JobType = (typeof JOB_TYPES)[number]

export type JobDoneReason = 'done' | 'paid'

export interface JobEventData {
  workspaceId: string
  /** The customer (a CRM contact in that workspace); null when the job has none (nothing to ask). */
  contactId: string | null
  jobRef: { type: JobType; id: string }
  /** ISO time the job was done (or paid). */
  completedAt: string
  /** Absent: 'done'. */
  reason?: JobDoneReason
  /** Who marked it done, when a person did. */
  userId?: string | null
  /** Track C: the payment request that was paid. */
  paymentRequestId?: string | null
}

export interface JobCompletedEvent {
  name: typeof JOB_COMPLETED_EVENT
  data: JobEventData
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === 'string' && (JOB_TYPES as readonly string[]).includes(value)
}

/** The event's job, as any sender wrote it (`jobRef`; an early sender's `job`), or null. Pure. */
export function jobRefOf(data: unknown): { type: JobType; id: string } | null {
  if (!data || typeof data !== 'object') return null
  const raw = (data as { jobRef?: unknown; job?: unknown }).jobRef ?? (data as { job?: unknown }).job
  if (!raw || typeof raw !== 'object') return null
  const { type, id } = raw as { type?: unknown; id?: unknown }
  return isJobType(type) && typeof id === 'string' && id.trim() !== '' && id.length <= 200 ? { type, id } : null
}

/** Send the job-completed event, keyed per job and customer so a repeat is dropped. Throws when Inngest refuses it. */
export async function emitJobCompleted(data: JobEventData): Promise<void> {
  await inngest.send({ id: `job-completed:${data.jobRef.type}:${data.jobRef.id}:${data.contactId ?? 'none'}`, name: JOB_COMPLETED_EVENT, data })
}
