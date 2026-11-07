/**
 * Launching a sequence: the checks and the arming behind Review & Launch
 * (POST /api/account/sequences/[id]/launch), shared with the agent's launch
 * cards (./launch-card.ts, roadmap D1/D2), so a launch the person approves by
 * text is exactly the launch their click makes. Launching IS the act that
 * sanctions automated sending (locked decision 3), so nothing arms on doubt:
 *
 *   1. ≥1 active step;
 *   2. a sending mailbox owned by the LAUNCHER: the sequence's pinned account
 *      if it is theirs, else their connected email account (enabled, primary
 *      preferred). Arming reassigns created_by to the launcher, so the
 *      engine's send identity (sendEmail gates the account on user_id) always
 *      matches the pinned account's owner;
 *   3. every active step renders for every recipient with zero unresolved
 *      tokens (incl. malformed:<raw>), resolving {{sender_name}} from the
 *      launcher's member row the way the engine will at send time;
 *   4. a PAUSED sequence first snaps its past-due enrollments forward through
 *      the window (resumePastDueEnrollments), so arming never bursts the
 *      backlog that went overdue while paused.
 *
 * Arming: status 'active' + auto_send + sending_account_id + created_by, then
 * every freshly staged enrollment (current_step_order 0, next_send_at NULL)
 * gets a window-snapped, jittered next_send_at from now. `only` narrows that
 * seeding to the enrollments a card named; the rest stay staged and inert.
 *
 * Runs on whatever client the caller passes (the route: the person's RLS
 * client; a card's replay: service role), so every query that can carry a
 * workspace filter does.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildStepEmail } from './engine-logic'
import { computeNextSendAt, normalizeWindow, randomJitterMs } from './schedule'
import { resumePastDueEnrollments } from './mutations'
import type { EnrollmentOverrides } from './types'

export interface LaunchStep {
  id: string
  step_order: number
  subject: string | null
  body: string
  delay_days: number
}

export interface LaunchContact {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  email?: string | null
  company?: { name?: string | null } | null
}

/** An active enrollment as the launch reads it (a campaign's would-be recipient renders through the same shape). */
export interface LaunchEnrollment {
  id: string
  contact_id: string | null
  contact_email: string
  current_step_order: number
  next_send_at: string | null
  overrides: EnrollmentOverrides | null
  thread_subject: string | null
  provider_thread_id: string | null
  contact: LaunchContact | null
}

export interface LaunchSequence {
  id: string
  name: string
  status: string
  timezone: string
  delay_unit: 'business' | 'calendar'
  send_window: unknown
  sending_account_id: string | null
  [key: string]: unknown
}

export interface LaunchPlan {
  sequence: LaunchSequence
  steps: LaunchStep[]
  /** Every ACTIVE enrollment (in flight and staged). */
  enrollments: LaunchEnrollment[]
  account: { id: string; account_email: string | null; display_name: string | null }
  sender: { name: string | null; email: string | null }
}

export interface RenderFailure {
  enrollment_id: string
  step_order: number
  tokens: string[]
}

/** A refusal, in the route's terms: its status, message and the extras its 400 carries ({ code, failures }). */
export interface LaunchError {
  ok: false
  status: 400 | 404 | 500
  message: string
  extras?: { code: string; [key: string]: unknown }
}

const ENROLLMENT_COLUMNS =
  'id, contact_id, contact_email, current_step_order, next_send_at, overrides, thread_subject, provider_thread_id, contact:contact_id(first_name, last_name, full_name, email, company:company_id(name))'

function fail(status: LaunchError['status'], message: string, code?: string, more: Record<string, unknown> = {}): LaunchError {
  return { ok: false, status, message, ...(code ? { extras: { code, ...more } } : {}) }
}

/** The sequence, fenced to its workspace; 404 when it isn't there, 400 when archived. */
export async function loadSequenceForLaunch(
  supabase: SupabaseClient,
  args: { workspaceId: string; sequenceId: string },
): Promise<{ ok: true; sequence: LaunchSequence } | LaunchError> {
  const { data, error } = await supabase
    .from('sequence')
    .select('*')
    .eq('id', args.sequenceId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[sequences] launch load failed:', error.message)
    return fail(500, 'Internal server error')
  }
  if (!data) return fail(404, 'Sequence not found')
  if (data.status === 'archived') return fail(400, 'Cannot launch an archived sequence')
  return { ok: true, sequence: data as LaunchSequence }
}

/**
 * Everything a launch checks, read once: the active steps, the launcher's
 * sending mailbox, the active enrollments and the sender's name. Refuses in
 * the route's order (no_active_steps, no_email_account, then no_enrollments
 * when `requireEnrollments`).
 */
export async function loadLaunchPlan(
  supabase: SupabaseClient,
  args: { workspaceId: string; sequence: LaunchSequence; launcherUserId: string; requireEnrollments: boolean },
): Promise<{ ok: true; plan: LaunchPlan } | LaunchError> {
  const { workspaceId, sequence, launcherUserId } = args

  const { data: steps, error: stepsError } = await supabase
    .from('sequence_step')
    .select('id, step_order, subject, body, delay_days')
    .eq('sequence_id', sequence.id)
    .eq('is_active', true)
    .order('step_order', { ascending: true })
  if (stepsError) {
    console.error('[sequences] launch steps load failed:', stepsError.message)
    return fail(500, 'Internal server error')
  }
  const activeSteps = (steps ?? []) as LaunchStep[]
  if (activeSteps.length === 0) return fail(400, 'Sequence has no active steps', 'no_active_steps')

  // The pinned account only when it is the launcher's; anyone else's would
  // make every send throw and auto-pause the sequence forever.
  let account: LaunchPlan['account'] | null = null
  if (sequence.sending_account_id) {
    const { data } = await supabase
      .from('connected_account')
      .select('id, account_email, display_name')
      .eq('id', sequence.sending_account_id)
      .eq('user_id', launcherUserId)
      .maybeSingle()
    account = (data as LaunchPlan['account'] | null) ?? null
  }
  if (!account) {
    const { data: candidates, error: accountError } = await supabase
      .from('connected_account')
      .select('id, account_email, display_name')
      .eq('user_id', launcherUserId)
      .eq('capability', 'email')
      .eq('is_enabled', true)
      .order('is_primary', { ascending: false })
      .limit(1)
    if (accountError) {
      console.error('[sequences] launch account lookup failed:', accountError.message)
      return fail(500, 'Internal server error')
    }
    account = ((candidates ?? [])[0] as LaunchPlan['account'] | undefined) ?? null
  }
  if (!account) return fail(400, 'Connect a Gmail or Outlook account to launch this sequence', 'no_email_account')

  const { data: enrollments, error: enrollmentsError } = await supabase
    .from('sequence_enrollment')
    .select(ENROLLMENT_COLUMNS)
    .eq('sequence_id', sequence.id)
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
  if (enrollmentsError) {
    console.error('[sequences] launch enrollments load failed:', enrollmentsError.message)
    return fail(500, 'Internal server error')
  }
  const activeEnrollments = (enrollments ?? []) as unknown as LaunchEnrollment[]
  if (args.requireEnrollments && activeEnrollments.length === 0) {
    return fail(400, 'Sequence has no active enrollments', 'no_enrollments')
  }

  // {{sender_name}} resolves from the launcher's member row, as the engine
  // does at send time (arming makes the launcher created_by), never from
  // connected_account.display_name, which is the provider label ('Gmail').
  const { data: senderMember, error: senderMemberError } = await supabase
    .from('member')
    .select('display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', launcherUserId)
    .maybeSingle()
  if (senderMemberError) {
    console.error('[sequences] launch sender lookup failed:', senderMemberError.message)
    return fail(500, 'Internal server error')
  }

  return {
    ok: true,
    plan: {
      sequence,
      steps: activeSteps,
      enrollments: activeEnrollments,
      account,
      sender: {
        name: (senderMember?.display_name as string | null | undefined) ?? null,
        email: account.account_email ?? null,
      },
    },
  }
}

/**
 * Every active step × every given enrollment rendered: the unresolved tokens,
 * per enrollment and step. `overrides` (Review & Launch's just-validated
 * edits) replace an enrollment's stored jsonb wholesale, as they will on
 * persist. Pure.
 */
export function renderFailures(
  plan: Pick<LaunchPlan, 'sequence' | 'steps' | 'sender'>,
  enrollments: ReadonlyArray<Pick<LaunchEnrollment, 'id' | 'contact_email' | 'overrides' | 'thread_subject' | 'provider_thread_id' | 'contact'>>,
  overrides: Record<string, EnrollmentOverrides> = {},
): RenderFailure[] {
  const failures: RenderFailure[] = []
  for (const enrollment of enrollments) {
    const contact = enrollment.contact
    const contactVars = {
      first_name: contact?.first_name ?? null,
      last_name: contact?.last_name ?? null,
      full_name: contact?.full_name ?? null,
      company: contact?.company?.name ?? null,
      email: contact?.email ?? enrollment.contact_email,
    }
    for (const step of plan.steps) {
      const result = buildStepEmail(
        {
          overrides: overrides[enrollment.id] ?? enrollment.overrides,
          // Pre-launch there is no thread yet; NULL-subject follow-ups render
          // 'Re: ' + snapshot at send time, so only token resolution matters.
          thread_subject: enrollment.thread_subject,
          provider_thread_id: enrollment.provider_thread_id,
        },
        { step_order: step.step_order, subject: step.subject ?? null, body: step.body },
        plan.sequence,
        [],
        contactVars,
        plan.sender,
      )
      if (result.blocked) {
        failures.push({ enrollment_id: enrollment.id, step_order: step.step_order, tokens: result.blocked })
      }
    }
  }
  return failures
}

/** Freshly staged: active, never sent, never scheduled. Only these does an arming seed. */
export function isStaged(enrollment: Pick<LaunchEnrollment, 'current_step_order' | 'next_send_at'>): boolean {
  return enrollment.current_step_order === 0 && enrollment.next_send_at === null
}

/**
 * Arm the sequence and seed the staged enrollments (all of them, or the ones
 * `only` keeps). A paused sequence's backlog is snapped forward first.
 */
export async function armLaunch(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    plan: LaunchPlan
    launcherUserId: string
    only?: (enrollment: LaunchEnrollment) => boolean
  },
): Promise<{ ok: true; armed: number; armedEnrollmentIds: string[] } | LaunchError> {
  const { workspaceId, plan, launcherUserId } = args
  const { sequence } = plan

  if (sequence.status === 'paused') {
    const { error: resumeScheduleError } = await resumePastDueEnrollments(supabase, {
      id: sequence.id,
      delay_unit: sequence.delay_unit,
      timezone: sequence.timezone,
      send_window: sequence.send_window,
    })
    if (resumeScheduleError) return fail(500, 'Internal server error')
  }

  const { error: armError } = await supabase
    .from('sequence')
    .update({
      status: 'active',
      auto_send: true,
      sending_account_id: plan.account.id,
      created_by: launcherUserId,
    })
    .eq('id', sequence.id)
    .eq('workspace_id', workspaceId)
  if (armError) {
    // The sequence_sending_account_guard trigger raises 42501 when the account
    // is not reachable from this workspace: a caller problem, not a 500.
    if (armError.code === '42501' || /not reachable/i.test(armError.message)) {
      return fail(400, armError.message, 'account_not_reachable')
    }
    console.error('[sequences] arm failed:', armError.message)
    return fail(500, 'Internal server error')
  }

  // Seed freshly staged enrollments only: re-launching after a partial run
  // must not reschedule rows already in flight.
  const armedEnrollmentIds: string[] = []
  for (const enrollment of plan.enrollments) {
    if (!isStaged(enrollment)) continue
    if (args.only && !args.only(enrollment)) continue
    const next = computeNextSendAt({
      from: new Date(),
      delayDays: 0,
      delayUnit: sequence.delay_unit,
      timezone: sequence.timezone,
      window: normalizeWindow(sequence.send_window),
      jitterMs: randomJitterMs(),
    }).toISOString()
    const { error: seedError } = await supabase
      .from('sequence_enrollment')
      .update({ next_send_at: next, dispatch_attempts: 0 })
      .eq('id', enrollment.id)
      .eq('status', 'active')
      .is('next_send_at', null)
    if (seedError) {
      console.error('[sequences] schedule seed failed:', seedError.message)
      return fail(500, 'Internal server error')
    }
    armedEnrollmentIds.push(enrollment.id)
  }

  return { ok: true, armed: armedEnrollmentIds.length, armedEnrollmentIds }
}

/** JSON with every object's keys sorted, so equal values hash equal. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
    }
    return v
  }
  return JSON.stringify(sort(value ?? null)) ?? 'null'
}

/**
 * What a launch card showed, as one hash: the sequence, its active steps'
 * copy and timing, its schedule, the mailbox it sends from and the name
 * {{sender_name}} fills in. A card records it; the replay recomputes it and
 * refuses on any difference (the person approved those words, from that
 * address, on that schedule).
 */
export function outreachContentHash(plan: Pick<LaunchPlan, 'sequence' | 'steps' | 'account' | 'sender'>): string {
  return createHash('sha256')
    .update(
      canonical({
        sequence_id: plan.sequence.id,
        steps: plan.steps.map((s) => ({ id: s.id, step_order: s.step_order, subject: s.subject ?? null, body: s.body, delay_days: s.delay_days })),
        timezone: plan.sequence.timezone,
        delay_unit: plan.sequence.delay_unit,
        send_window: normalizeWindow(plan.sequence.send_window),
        account_id: plan.account.id,
        sender_name: plan.sender.name ?? null,
      }),
    )
    .digest('hex')
}
