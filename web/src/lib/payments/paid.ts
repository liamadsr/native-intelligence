/**
 * What follows a customer's payment (roadmap C2), once per payment request:
 * the webhook claims the request paid (./webhook.ts) and queues
 * `payments/request.paid` with the request's own id as the event id (Inngest
 * drops a repeat), and this function, each step retried on its own:
 *
 *   1. closes its to-do (./todo.ts);
 *   2. notes it on the CRM contact's timeline (contact_interaction
 *      'payment_received', once per request);
 *   3. texts the owner: "Sarah Lee paid $600.00 for Rug wash.";
 *   4. records the `job.paid` agent event (facts.notified: the owner was just
 *      texted, so the router keeps it quiet for "while you were away");
 *   5. sends track D's `job/completed` (review requests), deduped on the job.
 *
 * Refunds and disputes never come here: the webhook only logs them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { getServiceClient } from '@/lib/admin'
import { recordAgentEvents } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'
import { closePaymentTodo } from './todo'
import { textOwner } from './deliver'
import { formatAmount, PAYMENT_REQUEST_COLUMNS, toPaymentRequest, type PaymentRequest, type PaymentRequestRow } from './payment-links'

export const PAYMENT_REQUEST_PAID = 'payments/request.paid' as const

export interface PaymentRequestPaidEvent {
  name: typeof PAYMENT_REQUEST_PAID
  data: { requestId: string; workspaceId: string }
}

/**
 * Track D's review-request trigger (docs: the shared notes' track D page):
 * anything that finishes a customer's job may send it; D sends the review
 * link once per customer per job.
 */
export const JOB_COMPLETED = 'job/completed' as const

export interface JobCompletedEvent {
  name: typeof JOB_COMPLETED
  data: {
    workspaceId: string
    contactId: string | null
    jobRef: { type: string; id: string }
    completedAt: string
    /** Why it counts as done: this producer's is a payment. */
    reason: 'paid'
    paymentRequestId: string
  }
}

/** The job a payment finished: its subject, or the request itself when it names none. Pure. */
export function jobRefOf(request: Pick<PaymentRequest, 'id' | 'subjectType' | 'subjectId'>): { type: string; id: string } {
  return request.subjectId ? { type: request.subjectType, id: request.subjectId } : { type: 'payment_request', id: request.id }
}

/** The owner's text. Pure. */
export function paidText(args: { customerName: string | null; amountCents: number; currency: string; description: string; closedTodo: boolean }): string {
  const who = args.customerName?.trim().slice(0, 40) || 'A customer'
  return `${who} paid ${formatAmount(args.amountCents, args.currency)} for ${args.description}.${args.closedTodo ? ' I closed its to-do.' : ''}`
}

/** Queue the follow-ups for a request just claimed paid, and stamp it. Throws when the queue refuses (the webhook answers 500; Stripe retries). */
export async function queuePaidFollowups(supabase: SupabaseClient, request: { id: string; workspaceId: string }): Promise<void> {
  await inngest.send({ id: `payment-paid:${request.id}`, name: PAYMENT_REQUEST_PAID, data: { requestId: request.id, workspaceId: request.workspaceId } })
  // Unstamped, Stripe's retry queues again (Inngest drops the repeat id within a day).
  const { error } = await supabase.from('payment_request').update({ paid_followups_queued_at: new Date().toISOString() }).eq('id', request.id)
  if (error) throw new Error(`payment_request stamp failed: ${error.message}`)
}

async function loadRequest(supabase: SupabaseClient, requestId: string): Promise<(PaymentRequest & { amountPaidCents: number | null; paidAtIso: string | null }) | null> {
  const { data } = await supabase
    .from('payment_request')
    .select(`${PAYMENT_REQUEST_COLUMNS}, amount_paid_cents`)
    .eq('id', requestId)
    .maybeSingle<PaymentRequestRow & { amount_paid_cents: number | null }>()
  if (!data) return null
  return { ...toPaymentRequest(data), amountPaidCents: data.amount_paid_cents, paidAtIso: data.paid_at }
}

/** Who hears it: whoever sent the link, else whoever connected Stripe. */
async function ownerFor(supabase: SupabaseClient, request: PaymentRequest): Promise<string | null> {
  if (request.createdBy) return request.createdBy
  const { data } = await supabase.from('stripe_connect_account').select('connected_by').eq('workspace_id', request.workspaceId).maybeSingle<{ connected_by: string | null }>()
  return data?.connected_by ?? null
}

async function noteOnContact(supabase: SupabaseClient, request: PaymentRequest, amountCents: number, at: string): Promise<boolean> {
  if (!request.contactId) return false
  const { data: existing } = await supabase
    .from('contact_interaction')
    .select('id')
    .eq('contact_id', request.contactId)
    .eq('reference_type', 'payment_request')
    .eq('reference_id', request.id)
    .eq('interaction_type', 'payment_received')
    .limit(1)
  if (Array.isArray(existing) && existing.length > 0) return true
  const { error } = await supabase.from('contact_interaction').insert({
    workspace_id: request.workspaceId,
    contact_id: request.contactId,
    interaction_type: 'payment_received',
    reference_type: 'payment_request',
    reference_id: request.id,
    title: `Paid ${formatAmount(amountCents, request.currency)}`,
    summary: request.description.slice(0, 200),
    occurred_at: at,
    metadata: { amount_cents: amountCents, currency: request.currency, subject_type: request.subjectType, subject_id: request.subjectId },
  })
  if (error) throw new Error(`contact_interaction insert failed: ${error.message}`)
  const { error: statsError } = await supabase.rpc('update_contact_interaction_stats', { p_contact_id: request.contactId, p_occurred_at: at })
  if (statsError) console.warn('[payments] interaction stats skipped:', statsError.message)
  return true
}

export const paymentPaidFollowups = inngest.createFunction(
  {
    id: 'payment-paid-followups',
    retries: 4,
    concurrency: [{ limit: 5, key: 'event.data.workspaceId' }],
    triggers: [{ event: PAYMENT_REQUEST_PAID }],
  },
  async ({ event, step }) => {
    const { requestId } = event.data as PaymentRequestPaidEvent['data']
    const supabase = getServiceClient()
    const request = await step.run('load', () => loadRequest(supabase, requestId))
    if (!request || request.status !== 'paid') return { status: 'skipped' as const, reason: request ? `status_${request.status}` : 'missing' }
    const owner = await step.run('owner', () => ownerFor(supabase, request))
    const paidAt = request.paidAtIso ?? new Date().toISOString()
    const amount = request.amountPaidCents ?? request.amountCents

    const closedTodo = request.actionId && owner
      ? await step.run('close-todo', () => closePaymentTodo(supabase, { actionId: request.actionId as string, workspaceId: request.workspaceId, actorUserId: owner }))
      : false

    await step.run('crm-note', () => noteOnContact(supabase, request, amount, paidAt))

    const customerName = request.contactId
      ? await step.run('customer-name', async () => {
          const { data } = await supabase.from('contact').select('full_name').eq('id', request.contactId as string).maybeSingle<{ full_name: string | null }>()
          return data?.full_name ?? null
        })
      : null

    const texted = owner
      ? await step.run('text-owner', () =>
          textOwner(supabase, owner, paidText({ customerName, amountCents: amount, currency: request.currency, description: request.description, closedTodo }), request.workspaceId),
        )
      : { sent: false as const, reason: 'no_owner' }

    if (owner) {
      await step.run('agent-event', () =>
        recordAgentEvents(
          [
            {
              workspaceId: request.workspaceId,
              userId: owner,
              kind: 'job.paid',
              priority: 1,
              occursAt: paidAt,
              refType: request.subjectId ? request.subjectType : 'payment_request',
              refId: request.subjectId ?? request.id,
              facts: {
                title: paidText({ customerName, amountCents: amount, currency: request.currency, description: request.description, closedTodo: false }),
                ...(request.contactId ? { contactId: request.contactId } : {}),
                notified: texted.sent,
              },
              dedupeKey: agentEventKey.jobPaid(request.id),
            },
          ],
          supabase,
        ),
      )
    }

    const job: JobCompletedEvent = {
      name: JOB_COMPLETED,
      data: {
        workspaceId: request.workspaceId,
        contactId: request.contactId,
        jobRef: jobRefOf(request),
        completedAt: paidAt,
        reason: 'paid',
        paymentRequestId: request.id,
      },
    }
    await step.sendEvent('job-completed', { ...job, id: `job-completed:${job.data.jobRef.type}:${job.data.jobRef.id}` })

    return { status: 'done' as const, closedTodo, texted: texted.sent }
  },
)
