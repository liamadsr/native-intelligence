import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { findSentMessageByRfcId, makeRfcMessageId, sendEmail } from '@/lib/crm/email-client'
import {
  buildStepEmail,
  escapeIlikePattern,
  ledgerConflictDecision,
  selectNextActiveStep,
  shouldExitAsReplied,
  type BuildStepEmailLedgerRow,
} from '@/lib/sequences/engine-logic'
import {
  computeNextSendAt,
  normalizeWindow,
  randomJitterMs,
} from '@/lib/sequences/schedule'
import { notifySequenceIssue } from '@/lib/sequences/notify'
import type { SequenceContactVars } from '@/lib/sequences/template'
import type {
  EnrollmentExitReason,
  EnrollmentOverrides,
  SequenceDelayUnit,
  SequenceStepDueEvent,
} from '@/lib/sequences/types'

// =====================================================================
// sequence-step-send — deliver ONE due sequence step for ONE enrollment.
//
// Fired by /api/cron/sequence-dispatch after its lease-forward CAS claim.
// Three TOP-LEVEL steps (the nesting ban — see src/test/inngest-step-mock.ts
// and hubspot-push-sweep.ts's STEP STRUCTURE header; step tooling inside a
// step.run callback deadlocks silently in production):
//
//   1. 'claim'    — reload everything, walk the guard chain, and insert the
//                   at-most-once ledger row ('claimed'). A UNIQUE conflict is
//                   BRANCHED on via ledgerConflictDecision, never ignored.
//   2. 'send'     — assemble the email (buildStepEmail), CAS the ledger
//                   'claimed'→'sending', call the provider, record 'sent'.
//   3. 'finalize' — idempotent bookkeeping: interaction log, thread snapshot,
//                   advance current_step_order, schedule the next step or
//                   exit 'completed'.
//
// All branching is PURE and lives in src/lib/sequences/engine-logic.ts; this
// file only loads rows, calls the pure functions, and writes outcomes.
//
// Retry semantics: retries 2. A provider throw in 'send' rethrows so Inngest
// retries the STEP — the retry's 'claimed'→'sending' CAS then matches 0 rows
// (the row is already 'sending') and enters lost-claim RECOVERY: the rfc
// Message-ID was persisted on the ledger BEFORE the provider call, so the
// retry looks the message up at the provider — found ⇒ the send happened,
// finalize it as 'sent'; not found ⇒ fate unknown, leave the row for the cron
// reaper to escalate to 'failed' after 15 minutes. At-most-once bias
// throughout: a send whose fate is UNKNOWN is failed, never re-sent — but a
// send the provider can prove happened is recorded as sent, never failed.
//
// Concurrency: limit 1 keyed on the sending account (falling back to the
// enrollment id when the sequence has no account — those abort at the guard
// anyway). One mailbox never sends two sequence emails at once; jitter in the
// scheduler spreads the queue.
// =====================================================================

type ServiceClient = SupabaseClient

interface StepSendContext {
  workspaceId: string
  enrollment: {
    id: string
    contact_id: string | null
    contact_email: string
    current_step_order: number
    provider_thread_id: string | null
    thread_subject: string | null
    expected_message_count: number
    overrides: EnrollmentOverrides
  }
  sequence: {
    id: string
    name: string
    created_by: string | null
    sending_account_id: string | null
    timezone: string
    delay_unit: SequenceDelayUnit
    send_window: unknown
  }
  step: { id: string; step_order: number; subject: string | null; body: string; delay_days: number }
  nextStep: { step_order: number; delay_days: number } | null
  contact: SequenceContactVars
  sender: { name: string | null; email: string | null }
  sentLedger: BuildStepEmailLedgerRow[]
}

type ClaimResult =
  | { mode: 'abort'; reason: string }
  | { mode: 'proceed'; ctx: StepSendContext; ledgerId: string }
  | {
      mode: 'finalize-only'
      ctx: StepSendContext
      sentAt: string
      threadId: string | null
      subject: string
    }

type SendResult =
  | { outcome: 'sent'; sentAt: string; threadId: string | null; subject: string }
  | { outcome: 'blocked' | 'lost-claim' | 'account-unavailable' }

interface FinalizeInput {
  sentAt: string
  threadId: string | null
  subject: string
  /** contact_interaction is written only for a send THIS run performed. */
  logInteraction: boolean
}

export const sequenceStepSend = inngest.createFunction(
  {
    id: 'sequence-step-send',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.concurrencyKey' }],
    triggers: [{ event: 'sequence/step.due' }],
  },
  async ({ event, step }) => {
    const data = event.data as SequenceStepDueEvent
    const supabase = getServiceClient()

    // Step 1 — claim (guards + at-most-once ledger insert).
    const claim = (await step.run('claim', async () =>
      claimStep(supabase, data),
    )) as ClaimResult

    if (claim.mode === 'abort') {
      return { status: 'aborted' as const, reason: claim.reason }
    }

    if (claim.mode === 'proceed') {
      // Step 2 — send (assemble, CAS to 'sending', provider call, record 'sent').
      const send = (await step.run('send', async () =>
        sendStep(supabase, claim.ctx, claim.ledgerId),
      )) as SendResult

      if (send.outcome !== 'sent') {
        return { status: send.outcome }
      }

      // Step 3 — finalize (idempotent).
      await step.run('finalize', async () =>
        finalizeStep(supabase, claim.ctx, {
          sentAt: send.sentAt,
          threadId: send.threadId,
          subject: send.subject,
          logInteraction: true,
        }),
      )
      return { status: 'sent' as const }
    }

    // finalize-only: the send already happened (ledger row 'sent'); a crash ate
    // the bookkeeping. Re-run the idempotent finalize, never the send.
    await step.run('finalize', async () =>
      finalizeStep(supabase, claim.ctx, {
        sentAt: claim.sentAt,
        threadId: claim.threadId,
        subject: claim.subject,
        logInteraction: false,
      }),
    )
    return { status: 'finalized' as const }
  },
)

// ──────────────────────────────────────────────────────────────────
// Shared writers
// ──────────────────────────────────────────────────────────────────

async function exitEnrollment(
  supabase: ServiceClient,
  enrollmentId: string,
  reason: EnrollmentExitReason,
): Promise<void> {
  const { error } = await supabase
    .from('sequence_enrollment')
    .update({ status: 'exited', exit_reason: reason, next_send_at: null })
    .eq('id', enrollmentId)
    .eq('status', 'active')
  if (error) throw new Error(`enrollment exit (${reason}) failed: ${error.message}`)
}

/** Pause the whole SEQUENCE (not the enrollment) + one grouped notification. */
async function pauseSequenceWithNotice(
  supabase: ServiceClient,
  sequence: { id: string; name: string; created_by: string | null },
  workspaceId: string,
  body: string,
): Promise<void> {
  const { error } = await supabase
    .from('sequence')
    .update({ status: 'paused' })
    .eq('id', sequence.id)
    .eq('status', 'active')
  if (error) throw new Error(`sequence pause failed: ${error.message}`)
  await notifySequenceIssue(supabase, sequence, workspaceId, 'Sequence paused', body)
}

// ──────────────────────────────────────────────────────────────────
// Step 1: claim
// ──────────────────────────────────────────────────────────────────

async function claimStep(
  supabase: ServiceClient,
  event: SequenceStepDueEvent,
): Promise<ClaimResult> {
  const nowIso = new Date().toISOString()
  const abort = (reason: string): ClaimResult => ({ mode: 'abort', reason })
  // Benign aborts (paused mid-tick, stale event, concurrent claim) are NOT
  // evidence of a stuck row, so they must not consume the dispatch-attempts
  // budget — the reaper's cap bounds retries of ONE stuck step, not lifetime
  // churn across a 7-step sequence. Best-effort: a failed reset only delays
  // the reaper, never corrupts state.
  const abortBenign = async (reason: string): Promise<ClaimResult> => {
    const { error } = await supabase
      .from('sequence_enrollment')
      .update({ dispatch_attempts: 0 })
      .eq('id', event.enrollmentId)
      .eq('status', 'active')
    if (error) {
      console.error(
        `[sequences] benign-abort attempts reset failed for ${event.enrollmentId}:`,
        error.message,
      )
    }
    return abort(reason)
  }

  const { data: enrollment, error: enrollmentError } = await supabase
    .from('sequence_enrollment')
    .select('*')
    .eq('id', event.enrollmentId)
    .maybeSingle()
  if (enrollmentError) throw enrollmentError
  if (!enrollment) return abort('enrollment-missing')

  const { data: sequence, error: sequenceError } = await supabase
    .from('sequence')
    .select('*')
    .eq('id', enrollment.sequence_id)
    .maybeSingle()
  if (sequenceError) throw sequenceError
  if (!sequence) return abort('sequence-missing')

  // Guard chain — order is load-bearing (the spec's order).
  // 1. Sequence still armed. auto_send=false is the emergency brake.
  if (sequence.status !== 'active' || sequence.auto_send !== true) {
    return abortBenign('sequence-not-active')
  }
  // 2. Enrollment still live.
  if (enrollment.status !== 'active') return abort('enrollment-not-active')
  // 3. Fencing token: the dispatcher claimed at this step order; anything else
  //    is a stale/duplicate event.
  if (enrollment.current_step_order !== event.stepOrder) {
    return abortBenign('stale-step-order')
  }
  // 4. A sender identity must exist: the pinned mailbox AND the user we send
  //    as (created_by is SET NULL on user deletion). Missing → pause the
  //    SEQUENCE with one notification; enrollments stay active for resume.
  if (!sequence.sending_account_id || !sequence.created_by) {
    await pauseSequenceWithNotice(
      supabase,
      sequence,
      enrollment.workspace_id,
      !sequence.sending_account_id
        ? 'The connected mailbox for this sequence was disconnected. Reconnect an email account and resume the sequence.'
        : 'The user this sequence sends as no longer exists. Re-create the sequence to keep sending.',
    )
    return abort('no-sending-account')
  }
  // 5. Contact deleted (SET NULL) → exit 'removed' at first touch.
  if (!enrollment.contact_id) {
    await exitEnrollment(supabase, enrollment.id, 'removed')
    return abort('contact-gone')
  }
  // 6. Suppression on the email snapshot (case-insensitive; the index is on
  //    lower(email)).
  const { data: suppressed, error: suppressionError } = await supabase
    .from('outreach_suppression')
    .select('id')
    .eq('workspace_id', enrollment.workspace_id)
    .ilike('email', escapeIlikePattern(enrollment.contact_email))
    .limit(1)
  if (suppressionError) throw suppressionError
  if (suppressed && suppressed.length > 0) {
    await exitEnrollment(supabase, enrollment.id, 'opted_out')
    return abort('suppressed')
  }
  // 7. Reply re-check right before sending (the cron's exit-eval may lag a
  //    tick behind the sync).
  if (enrollment.provider_thread_id) {
    const { data: threads, error: threadError } = await supabase
      .from('email_thread_index')
      .select('message_count')
      .eq('workspace_id', enrollment.workspace_id)
      .eq('provider_thread_id', enrollment.provider_thread_id)
    if (threadError) throw threadError
    const threadRow =
      threads && threads.length > 0
        ? {
            message_count: threads.reduce(
              (max, t) => Math.max(max, (t.message_count as number | null) ?? 0),
              0,
            ),
          }
        : null
    if (shouldExitAsReplied(enrollment, threadRow)) {
      await exitEnrollment(supabase, enrollment.id, 'replied')
      return abort('replied')
    }
  }

  // The step being sent: the first ACTIVE step past what has been completed
  // (selectNextActiveStep — pure, unit-tested in engine-logic). NEVER a
  // load-by-exact-order: the graduated edit rules allow deactivating the
  // literal next step while enrollments are mid-flight, and the contract is
  // to SKIP FORWARD to the following active step — or, when none remain,
  // exit 'completed' rather than leak a forever-due row.
  const { data: steps, error: stepsError } = await supabase
    .from('sequence_step')
    .select('id, step_order, subject, body, delay_days')
    .eq('sequence_id', sequence.id)
    .eq('is_active', true)
    .order('step_order', { ascending: true })
  if (stepsError) throw stepsError
  const activeSteps = (steps ?? []) as Array<{
    id: string
    step_order: number
    subject: string | null
    body: string
    delay_days: number
  }>
  const stepRow = selectNextActiveStep(activeSteps, enrollment.current_step_order)
  if (!stepRow) {
    await exitEnrollment(supabase, enrollment.id, 'completed')
    return abort('no-next-step')
  }
  const nextStepRow = selectNextActiveStep(activeSteps, stepRow.step_order)

  const { data: contact, error: contactError } = await supabase
    .from('contact')
    .select('id, first_name, last_name, full_name, email, company:company_id(name)')
    .eq('id', enrollment.contact_id)
    .maybeSingle()
  if (contactError) throw contactError
  if (!contact) {
    await exitEnrollment(supabase, enrollment.id, 'removed')
    return abort('contact-gone')
  }

  const { data: account, error: accountError } = await supabase
    .from('connected_account')
    .select('account_email, display_name')
    .eq('id', sequence.sending_account_id)
    .maybeSingle()
  if (accountError) throw accountError
  if (!account) {
    await pauseSequenceWithNotice(
      supabase,
      sequence,
      enrollment.workspace_id,
      'The connected mailbox for this sequence no longer exists. Reconnect an email account and resume the sequence.',
    )
    return abort('no-sending-account')
  }

  // The human whose name signs the mail. connected_account.display_name is the
  // PROVIDER label ('Gmail', 'Outlook'), never a person — using it made
  // {{sender_first_name}} render as 'Gmail'. The workspace member row for
  // created_by is the only place the sender's real name lives; buildTemplateVars
  // still falls back to the mailbox local-part when a member has no name set.
  const { data: senderMember, error: senderMemberError } = await supabase
    .from('member')
    .select('display_name')
    .eq('workspace_id', enrollment.workspace_id)
    .eq('user_id', sequence.created_by)
    .maybeSingle()
  if (senderMemberError) throw senderMemberError

  const { data: ledgerRows, error: ledgerError } = await supabase
    .from('sequence_send')
    .select('step_id, status, provider_message_id, rfc_message_id, sent_at, created_at')
    .eq('enrollment_id', enrollment.id)
  if (ledgerError) throw ledgerError

  const companyName = (contact.company as { name?: string | null } | null)?.name ?? null
  const ctx: StepSendContext = {
    workspaceId: enrollment.workspace_id,
    enrollment: {
      id: enrollment.id,
      contact_id: enrollment.contact_id,
      contact_email: enrollment.contact_email,
      current_step_order: enrollment.current_step_order,
      provider_thread_id: enrollment.provider_thread_id,
      thread_subject: enrollment.thread_subject,
      expected_message_count: enrollment.expected_message_count,
      overrides: (enrollment.overrides ?? {}) as EnrollmentOverrides,
    },
    sequence: {
      id: sequence.id,
      name: sequence.name,
      created_by: sequence.created_by,
      sending_account_id: sequence.sending_account_id,
      timezone: sequence.timezone,
      delay_unit: sequence.delay_unit,
      send_window: sequence.send_window,
    },
    step: {
      id: stepRow.id as string,
      step_order: stepRow.step_order as number,
      subject: (stepRow.subject as string | null) ?? null,
      body: stepRow.body as string,
      delay_days: stepRow.delay_days as number,
    },
    nextStep: nextStepRow
      ? {
          step_order: nextStepRow.step_order as number,
          delay_days: nextStepRow.delay_days as number,
        }
      : null,
    contact: {
      first_name: contact.first_name,
      last_name: contact.last_name,
      full_name: contact.full_name,
      company: companyName,
      email: contact.email,
    },
    sender: {
      name: (senderMember?.display_name as string | null) ?? null,
      email: (account.account_email as string | null) ?? null,
    },
    sentLedger: (ledgerRows ?? []) as BuildStepEmailLedgerRow[],
  }

  // The at-most-once guard: insert 'claimed' BEFORE any provider call. A
  // UNIQUE(enrollment_id, step_id) conflict is branched on, never ignored.
  const { data: inserted, error: insertError } = await supabase
    .from('sequence_send')
    .insert({
      workspace_id: enrollment.workspace_id,
      enrollment_id: enrollment.id,
      step_id: ctx.step.id,
      status: 'claimed',
      scheduled_at: nowIso,
    })
    .select('id')
  if (!insertError) {
    const ledgerId = (inserted?.[0]?.id as string | undefined) ?? null
    if (!ledgerId) throw new Error('ledger insert returned no row')
    return { mode: 'proceed', ctx, ledgerId }
  }
  if (insertError.code !== '23505') throw insertError

  // Conflict — a row for this (enrollment, step) already exists.
  const { data: existing, error: existingError } = await supabase
    .from('sequence_send')
    .select('id, status, updated_at, sent_at, provider_thread_id')
    .eq('enrollment_id', enrollment.id)
    .eq('step_id', ctx.step.id)
    .maybeSingle()
  if (existingError) throw existingError
  if (!existing) return abort('conflict-row-vanished')

  const decision = ledgerConflictDecision(
    { status: existing.status, updated_at: existing.updated_at },
    Date.now(),
  )

  if (decision === 'finalize-only') {
    // The send happened; recover the finalize inputs. The subject is re-derived
    // from the same pure assembly (it sent, so it rendered); fall back to the
    // thread snapshot if assembly now blocks (e.g. contact edited since).
    const email = buildStepEmail(
      ctx.enrollment,
      ctx.step,
      ctx.sequence,
      ctx.sentLedger,
      ctx.contact,
      ctx.sender,
    )
    const subject = email.blocked ? (ctx.enrollment.thread_subject ?? '') : email.subject
    return {
      mode: 'finalize-only',
      ctx,
      sentAt: (existing.sent_at as string | null) ?? nowIso,
      threadId:
        (existing.provider_thread_id as string | null) ?? ctx.enrollment.provider_thread_id,
      subject,
    }
  }

  if (decision === 'stale-failed') {
    // A previous attempt died in flight. At-most-once: fail it, exit the
    // enrollment, tell the owner — NEVER auto-resend (the provider may have
    // delivered before the crash).
    const { error: failError } = await supabase
      .from('sequence_send')
      .update({ status: 'failed', error: 'previous send attempt died in flight' })
      .eq('id', existing.id)
      .in('status', ['claimed', 'sending'])
    if (failError) throw failError
    await exitEnrollment(supabase, enrollment.id, 'failed')
    await notifySequenceIssue(
      supabase,
      sequence,
      enrollment.workspace_id,
      'Sequence send failed',
      `A send in "${sequence.name}" died mid-flight and the enrollment was stopped (${enrollment.contact_email}).`,
    )
    return abort('stale-inflight-failed')
  }

  // decision === 'abort'. Split the two cases it covers: a FRESH in-flight row
  // (another invocation owns it — benign, reset the attempts budget) vs a
  // terminal 'failed' row (the enrollment is normally exited alongside it; if
  // that exit was lost, the attempts counter must KEEP counting so the reaper
  // eventually closes the orphan out instead of looping forever).
  if (existing.status === 'failed') return abort('ledger-failed')
  return abortBenign('concurrent-claim')
}

// ──────────────────────────────────────────────────────────────────
// Step 2: send
// ──────────────────────────────────────────────────────────────────

async function sendStep(
  supabase: ServiceClient,
  ctx: StepSendContext,
  ledgerId: string,
): Promise<SendResult> {
  const email = buildStepEmail(
    ctx.enrollment,
    ctx.step,
    ctx.sequence,
    ctx.sentLedger,
    ctx.contact,
    ctx.sender,
  )

  // ANY unresolved token (including malformed:<raw>) blocks the send — brace
  // residue must never reach an inbox.
  if (email.blocked) {
    const { error } = await supabase
      .from('sequence_send')
      .update({
        status: 'failed',
        error: `unresolved template tokens: ${email.blocked.join(', ')}`,
      })
      .eq('id', ledgerId)
    if (error) throw error
    await exitEnrollment(supabase, ctx.enrollment.id, 'failed')
    await notifySequenceIssue(
      supabase,
      ctx.sequence,
      ctx.workspaceId,
      'Sequence email blocked',
      `An email to ${ctx.enrollment.contact_email} in "${ctx.sequence.name}" had unresolved tokens (${email.blocked.join(', ')}) and was not sent.`,
    )
    return { outcome: 'blocked' }
  }

  // CAS 'claimed' → 'sending': only the invocation that flips it may call the
  // provider. The rfc Message-ID is persisted IN the same CAS, before any
  // provider call — it is the recovery handle that lets a retry find out
  // whether a crashed send actually reached the provider. 0 rows means a retry
  // replaying past its own crashed send (the row is 'sending'/'sent'/'failed'
  // already) — enter recovery instead of returning blind.
  const rfcMessageId = makeRfcMessageId(ctx.sender.email)
  const { data: cas, error: casError } = await supabase
    .from('sequence_send')
    .update({ status: 'sending', rfc_message_id: rfcMessageId })
    .eq('id', ledgerId)
    .eq('status', 'claimed')
    .select('id')
  if (casError) throw casError
  if (!cas || cas.length === 0) {
    return recoverLostClaim(supabase, ctx, ledgerId, email.subject)
  }

  try {
    const result = await sendEmail(ctx.sequence.created_by!, ctx.workspaceId, {
      account_id: ctx.sequence.sending_account_id!,
      to: [ctx.enrollment.contact_email],
      subject: email.subject,
      body_html: email.bodyHtml,
      // The pre-persisted recovery handle — sendEmail stamps this exact id on
      // the outgoing message for both providers.
      rfc_message_id: rfcMessageId,
      ...(email.threadId ? { thread_id: email.threadId } : {}),
      ...(email.inReplyTo ? { in_reply_to_message_id: email.inReplyTo } : {}),
      ...(email.references.length > 0 ? { references: email.references } : {}),
      // The engine keeps its own ledger + writes contact_interaction in
      // finalize; sendEmail's built-in log would double-count.
      skip_interaction_log: true,
    })

    const sentAt = new Date().toISOString()
    const { error: sentError } = await supabase
      .from('sequence_send')
      .update({
        status: 'sent',
        sent_at: sentAt,
        provider_message_id: result.message_id,
        provider_thread_id: result.thread_id,
        rfc_message_id: result.rfc_message_id,
      })
      .eq('id', ledgerId)
    if (sentError) throw sentError

    return { outcome: 'sent', sentAt, threadId: result.thread_id, subject: email.subject }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Token/account failure: the mailbox is gone or was never connected.
    // Both messages are thrown during identity resolution, BEFORE any provider
    // call, so the claim is safe to RELEASE: delete the ledger row (a 'failed'
    // row would make every post-resume claim hit the 23505 conflict and abort
    // via ledgerConflictDecision, permanently bricking the enrollment). Then
    // pause the SEQUENCE (one notification; reconnect + resume recovers — the
    // next claim re-inserts the row and retries this same step). The
    // enrollment stays ACTIVE.
    if (
      message.includes('Connected email account unavailable') ||
      message.includes('No email integration connected')
    ) {
      const { error: releaseError } = await supabase
        .from('sequence_send')
        .delete()
        .eq('id', ledgerId)
        .eq('status', 'sending')
      if (releaseError) {
        console.error(
          `[sequences] claim release failed for ledger ${ledgerId}:`,
          releaseError.message,
        )
      }
      await pauseSequenceWithNotice(
        supabase,
        ctx.sequence,
        ctx.workspaceId,
        'The connected mailbox for this sequence is unavailable. Reconnect the email account and resume the sequence.',
      )
      return { outcome: 'account-unavailable' }
    }
    // Anything else: rethrow. Inngest retries the step; the retry's
    // 'claimed'→'sending' CAS no-ops (the row is already 'sending') and the
    // recovery branch resolves the send's fate by rfc Message-ID — the reaper
    // escalates to 'failed' after 15 minutes only when the fate stays unknown.
    throw err
  }
}

/**
 * The 'send' CAS matched 0 rows — a prior attempt of THIS invocation's claim
 * already moved the row past 'claimed'. Re-read it instead of returning blind:
 *
 *   'sent'     — the provider call AND the 'sent' record landed, only the
 *                Inngest step record was lost. Hand the recorded outcome to
 *                finalize.
 *   'sending'  — the prior attempt crashed between the provider call and the
 *                'sent' record. The rfc Message-ID was persisted BEFORE the
 *                provider call, so the fate is recoverable: look the message
 *                up at the provider. Found ⇒ delivered — finalize as 'sent'
 *                rather than letting the reaper fail a delivered email. Not
 *                found ⇒ fate unknown — at-most-once bias, leave the row for
 *                the reaper; NEVER resend.
 *   otherwise  — 'failed'/vanished; nothing to recover.
 */
async function recoverLostClaim(
  supabase: ServiceClient,
  ctx: StepSendContext,
  ledgerId: string,
  subject: string,
): Promise<SendResult> {
  const { data: row, error } = await supabase
    .from('sequence_send')
    .select('id, status, sent_at, provider_thread_id, rfc_message_id')
    .eq('id', ledgerId)
    .maybeSingle()
  if (error) throw error
  if (!row) return { outcome: 'lost-claim' }

  if (row.status === 'sent') {
    return {
      outcome: 'sent',
      sentAt: (row.sent_at as string | null) ?? new Date().toISOString(),
      threadId: (row.provider_thread_id as string | null) ?? null,
      subject,
    }
  }

  if (
    row.status === 'sending' &&
    row.rfc_message_id &&
    ctx.sequence.created_by &&
    ctx.sequence.sending_account_id
  ) {
    const found = await findSentMessageByRfcId(
      ctx.sequence.created_by,
      ctx.sequence.sending_account_id,
      row.rfc_message_id as string,
    )
    if (found) {
      const sentAt = new Date().toISOString()
      const { data: recovered, error: recoverError } = await supabase
        .from('sequence_send')
        .update({
          status: 'sent',
          sent_at: sentAt,
          provider_message_id: found.message_id,
          provider_thread_id: found.thread_id,
        })
        .eq('id', ledgerId)
        .eq('status', 'sending')
        .select('id')
      if (recoverError) throw recoverError
      if (recovered && recovered.length > 0) {
        return { outcome: 'sent', sentAt, threadId: found.thread_id, subject }
      }
    }
  }

  // Fate unknown (or already reaped) — the reaper owns escalation.
  return { outcome: 'lost-claim' }
}

// ──────────────────────────────────────────────────────────────────
// Step 3: finalize — IDEMPOTENT (safe to run twice)
// ──────────────────────────────────────────────────────────────────

async function finalizeStep(
  supabase: ServiceClient,
  ctx: StepSendContext,
  input: FinalizeInput,
): Promise<{ advancedTo: number; completed: boolean }> {
  // Interaction log — only for a send THIS run performed ('proceed' mode).
  // finalize-only replays skip it so a crash between send and finalize can't
  // double-log the contact timeline.
  if (input.logInteraction && ctx.enrollment.contact_id) {
    const { error } = await supabase.from('contact_interaction').insert({
      workspace_id: ctx.workspaceId,
      contact_id: ctx.enrollment.contact_id,
      interaction_type: 'email_sent',
      reference_type: 'email_thread',
      reference_id: input.threadId,
      // A template and a pointer (the thread), never the subject: the row is
      // readable by the whole workspace (no stored mail).
      title: 'Sequence email sent',
      occurred_at: input.sentAt,
    })
    if (error) throw error
    // Denormalized warmth/recency counters — every contact_interaction writer
    // in the repo pairs the insert with this RPC (sendEmail's own log path
    // does; see email-client.ts). Inside the logInteraction guard so the
    // finalize-only replay path never double-counts. Best-effort: the counters
    // are derived data, and throwing here would replay the insert above.
    const { error: statsError } = await supabase.rpc('update_contact_interaction_stats', {
      p_contact_id: ctx.enrollment.contact_id,
      p_occurred_at: input.sentAt,
    })
    if (statsError) {
      console.error(
        `[sequences] interaction stats update failed for contact ${ctx.enrollment.contact_id}:`,
        statsError.message,
      )
    }
  }

  // First send of the funnel that came back with NO thread handle: reply
  // detection is permanently impossible for this enrollment (shouldExitAsReplied
  // needs provider_thread_id, and the cron's exit-eval scan skips NULL thread
  // ids entirely) — every later step would fire blind at someone who may have
  // replied. At-most-once bias: stop the enrollment loudly instead. Idempotent
  // under replay (exit is guarded on 'active'; the notification dedupes 24h).
  if (ctx.enrollment.current_step_order === 0 && !input.threadId) {
    await exitEnrollment(supabase, ctx.enrollment.id, 'failed')
    await notifySequenceIssue(
      supabase,
      ctx.sequence,
      ctx.workspaceId,
      'Sequence enrollment stopped',
      `Step 1 to ${ctx.enrollment.contact_email} in "${ctx.sequence.name}" was sent, but the provider returned no thread id, so replies cannot be detected. The enrollment was stopped after step 1.`,
    )
    return { advancedTo: ctx.step.step_order, completed: false }
  }

  // expected_message_count is DERIVED from the ledger, never read-modify-
  // written from the memoized claim snapshot: count of 'sent' rows is exactly
  // "messages the engine put in the thread" and is idempotent under any replay
  // (a snapshot-based +1 double-counts on the finalize-only path, inflating
  // the reply baseline so a genuine reply no longer trips shouldExitAsReplied).
  const { count: sentCount, error: sentCountError } = await supabase
    .from('sequence_send')
    .select('id', { count: 'exact', head: true })
    .eq('enrollment_id', ctx.enrollment.id)
    .eq('status', 'sent')
  if (sentCountError) throw sentCountError
  if (typeof sentCount !== 'number') throw new Error('sent-ledger count returned no count')

  const update: Record<string, unknown> = {
    // Absolute values (not increments) so a double-run writes the same state.
    expected_message_count: sentCount,
    current_step_order: ctx.step.step_order,
  }
  // First send of the funnel: snapshot the thread handle + rendered subject —
  // every NULL-subject follow-up threads under these.
  if (ctx.enrollment.current_step_order === 0) {
    update.provider_thread_id = input.threadId
    update.thread_subject = input.subject
  }
  if (ctx.nextStep) {
    update.next_send_at = computeNextSendAt({
      // Delay counts from the ACTUAL send time, not the scheduled time.
      from: new Date(input.sentAt),
      delayDays: ctx.nextStep.delay_days,
      delayUnit: ctx.sequence.delay_unit,
      timezone: ctx.sequence.timezone,
      window: normalizeWindow(ctx.sequence.send_window),
      jitterMs: randomJitterMs(),
    }).toISOString()
    update.dispatch_attempts = 0
  } else {
    // No further active step — the funnel is done. exit_reason is REQUIRED by
    // the table CHECK whenever status='exited'.
    update.status = 'exited'
    update.exit_reason = 'completed'
    update.next_send_at = null
  }

  // Guarded on 'active' so a concurrent exit (reply landed between send and
  // finalize) is never clobbered back to a scheduled state.
  const { error } = await supabase
    .from('sequence_enrollment')
    .update(update)
    .eq('id', ctx.enrollment.id)
    .eq('status', 'active')
  if (error) throw error

  return { advancedTo: ctx.step.step_order, completed: !ctx.nextStep }
}
