import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  enrollContacts,
  normalizeSteps,
  resumePastDueEnrollments,
  updateSequenceStructure,
} from '@/lib/sequences/mutations'
import { DEFAULT_SEND_WINDOW, normalizeWindow } from '@/lib/sequences/schedule'
import { extractTokens } from '@/lib/sequences/template'
import { getSequenceUrl } from '@/lib/sequences/urls'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'
import { filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { getServiceClient } from '@/lib/supabase/service'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import {
  armLaunch,
  isStaged,
  loadLaunchPlan,
  loadSequenceForLaunch,
  outreachContentHash,
  renderFailures,
} from '@/lib/sequences/launch'
import {
  LAUNCH_RECIPIENTS_MAX,
  approvedOutreach,
  describeSendWindow,
  launchCardCopy,
  launchCardInput,
  launchSummary,
  raiseLaunchCard,
  type LaunchCardOrigin,
  type LaunchRecipient,
} from '@/lib/sequences/launch-card'

/**
 * AI agent tools for Sequences (workspace-scoped CRM outreach).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LAUNCHING IS THE PERSON'S YES, NEVER THE MODEL'S CALL.
 *
 * The agent builds a sequence, edits it and stages contacts into it; those
 * send nothing. `launch_sequence` is the one tool that arms sending, and it
 * never sends on a call either: it raises the person's approval card with
 * every email, the schedule, the mailbox and the recipients
 * (src/lib/sequences/launch-card.ts), and the sequence launches only on their
 * yes, on the card or by texting "yes CODE". The yes replays the call with
 * `approvedCall.outreach`, which must still match what the card showed (the
 * copy and schedule by hash, the recipients by id). The launch itself is
 * Review & Launch's (src/lib/sequences/launch.ts), so a texted yes and the
 * person's click arm a sequence identically. Nothing here sets `auto_send`.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * These tools run on whatever Supabase client the caller provides (chat: the
 * user's RLS client; MCP: a service-role client), so every query carries an
 * explicit workspace_id filter. The shared business rules (step validation,
 * enroll guards, never-burst resume) live in src/lib/sequences/mutations.ts,
 * the same implementation the API routes use.
 *
 * WORKSPACE ROUTING (see _shared.ts "CREATE-TIME WORKSPACE ROUTING"):
 * `create_sequence` takes an optional `workspace_id` and resolves it through
 * `resolveCreateWorkspace`. `update_sequence`, `enroll_contacts_in_sequence`,
 * `remove_from_sequence` and `launch_sequence` all take a `sequence_id` the
 * model may have copied out of another workspace's board — each resolves the
 * SEQUENCE's own workspace through `resolveEntityWorkspace` first and
 * re-points every query (including `enrollContacts`'s own contact lookup) at
 * that resolved workspace, never the session's. `list_sequences` and
 * `get_sequence` are unconverted reads, pinned to the session workspace as
 * before.
 */

/** The launch card's context (index.ts threads it from createTools' options). */
export interface SequenceToolsContext {
  /** The chat the card renders in (and a text turn texts its code from); null asks in the home thread. */
  conversationId?: string | null
  /** Set ONLY when replaying an accepted card (src/lib/safety/approved-call.ts). */
  approvedCall?: ApprovedCall
  /** The chat door's re-check context, stored on the card. */
  approvalContext?: LaunchCardOrigin['approvalContext']
  /** Nobody at the keyboard (a work run's or loop's own turns): no card to raise. */
  unattended?: boolean
}

const stepInputSchema = z.object({
  step_order: z
    .number()
    .int()
    .min(1)
    .describe('1-based position of this step. Steps must cover 1..N with no gaps or duplicates.'),
  subject: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Email subject. REQUIRED on step 1. OMIT on later steps to send them as replies in the same thread ("Re: <step 1 subject>") — recommended for follow-ups.',
    ),
  body: z
    .string()
    .max(20000)
    .describe(
      'Email body. Supports merge tokens with fallbacks: {{first_name|there}}, {{last_name}}, {{full_name}}, {{company}}, {{email}}, {{sender_name}}, {{sender_first_name}}. A token without a value or fallback blocks launch.',
    ),
  delay_days: z
    .number()
    .int()
    .min(0)
    .describe(
      'Days to wait after the previous step (0 on step 1 = send at launch). Interpreted per the sequence delay_unit (business or calendar days) and snapped into the send window.',
    ),
})

const sendWindowSchema = z.object({
  days: z
    .array(z.number().int().min(1).max(7))
    .describe('ISO weekdays allowed to send: 1=Monday .. 7=Sunday. Default [1,2,3,4,5].'),
  start_hour: z
    .number()
    .int()
    .min(0)
    .max(23)
    .describe('Local hour the window opens (inclusive). Default 9.'),
  end_hour: z
    .number()
    .int()
    .min(1)
    .max(24)
    .describe('Local hour the window closes (exclusive). Default 16.'),
})

/**
 * update_sequence step shape: stepInputSchema plus the id that drives the
 * reconcile — existing steps keep their id, new steps omit it, and an
 * existing step left out of the list is DELETED (refused per-step when the
 * ledger or an active enrollment still needs it).
 */
const updateStepInputSchema = stepInputSchema.extend({
  id: z
    .string()
    .optional()
    .describe(
      'Id of an existing step to update (from get_sequence). OMIT for a brand-new step. Existing steps missing from the list are DELETED — which is refused per-step when the step has send history or a contact is about to receive it.',
    ),
})

type StepInput = z.infer<typeof stepInputSchema> & { id?: string }

/**
 * Validate that explicit step_orders form exactly 1..N, and return the steps
 * sorted into that order (the shared normalizer assigns order from array
 * position, so the sort is what makes the model's step_order authoritative).
 */
function sortStepsByOrder(
  steps: StepInput[],
): { ok: true; steps: StepInput[] } | { ok: false; error: string } {
  const sorted = [...steps].sort((a, b) => a.step_order - b.step_order)
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].step_order !== i + 1) {
      return {
        ok: false,
        error: `steps must have step_order 1..${steps.length} with no gaps or duplicates (got: ${steps
          .map((s) => s.step_order)
          .join(', ')})`,
      }
    }
  }
  return { ok: true, steps: sorted }
}

/** Union of merge tokens referenced across every step's subject + body. */
function mergeFieldsUsed(steps: Array<{ subject: string | null; body: string }>): string[] {
  const tokens = new Set<string>()
  for (const s of steps) {
    for (const t of extractTokens(s.body)) tokens.add(t)
    if (s.subject) for (const t of extractTokens(s.subject)) tokens.add(t)
  }
  return [...tokens]
}

/** Headline enrollment counts, same shape as the list API route. */
function countEnrollments(
  rows: Array<{ status: string | null; exit_reason: string | null }>,
): { total: number; active: number; replied: number } {
  const counts = { total: 0, active: 0, replied: 0 }
  for (const e of rows) {
    counts.total += 1
    if (e.status === 'active') counts.active += 1
    if (e.exit_reason === 'replied') counts.replied += 1
  }
  return counts
}

export function createSequenceTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  ctx: SequenceToolsContext = {},
) {
  /** Load a sequence, fenced to `ws` (the session workspace by default, or the
   *  sequence's own resolved workspace once a tool has routed to it). */
  async function loadSequence(sequenceId: string, ws: string = workspaceId) {
    return supabase
      .from('sequence')
      .select('*')
      .eq('id', sequenceId)
      .eq('workspace_id', ws)
      .maybeSingle()
  }

  return {
    create_sequence: tool({
      description:
        'Create an outreach email sequence as a DRAFT (does NOT send anything). A sequence sends templated emails to enrolled CRM contacts on a delay schedule from the user\'s own connected Gmail/Outlook, auto-stopping when a contact replies. This tool only creates the draft: sending starts only with launch_sequence, on the person\'s yes to its card (or their own Launch on the Review & Launch screen at the returned url). Step 1 must have a subject; later steps should omit the subject so they thread as replies. Bodies support merge tokens like {{first_name|there}}.',
      inputSchema: z.object({
        name: z.string().max(200).describe('Name of the sequence, e.g. "Seed investor first touch"'),
        description: z.string().max(2000).optional().describe('What this sequence is for'),
        steps: z
          .array(stepInputSchema)
          .min(1)
          .max(20)
          .describe(
            'The email steps in order (max 20 — real sequences are single-digit). E.g. "email every 3 days, 3 times" = 3 steps with delay_days 0, 3, 3.',
          ),
        timezone: z
          .string()
          .optional()
          .describe('IANA timezone for the send schedule, e.g. "America/Los_Angeles" (the default).'),
        send_window: sendWindowSchema
          .optional()
          .describe('When sends are allowed. Defaults to weekdays 9:00–16:00 local.'),
        delay_unit: z
          .enum(['business', 'calendar'])
          .optional()
          .describe('How delay_days are counted. Default business (skips days outside the send window\'s weekdays).'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async ({ name, description, steps, timezone, send_window, delay_unit, workspace_id }) => {
        const trimmedName = name.trim()
        if (!trimmedName) return { success: false, error: 'name is required' }

        const ordered = sortStepsByOrder(steps)
        if (!ordered.ok) return { success: false, error: ordered.error }

        // Same validation the API route applies (step 1 subject, body
        // required, non-negative integer delays, header-injection guard).
        const normalized = normalizeSteps(ordered.steps)
        if (!normalized.ok) return { success: false, error: normalized.error }

        // An invalid zone ("PT") would make Launch throw after arming.
        if (timezone?.trim() && !isTimeZone(timezone.trim())) {
          return { success: false, error: 'timezone must be an IANA zone like America/New_York' }
        }

        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        const { data: sequence, error: sequenceError } = await supabase
          .from('sequence')
          .insert({
            workspace_id: targetWs,
            name: trimmedName,
            description: description?.trim() ? description.trim() : null,
            status: 'draft',
            created_by: userId,
            timezone: timezone?.trim() ? timezone.trim() : 'America/Los_Angeles',
            send_window: send_window !== undefined ? normalizeWindow(send_window) : DEFAULT_SEND_WINDOW,
            delay_unit: delay_unit === 'calendar' ? 'calendar' : 'business',
          })
          .select('*')
          .single()
        if (sequenceError || !sequence) {
          return { success: false, error: sequenceError?.message || 'Failed to create sequence' }
        }

        const { data: insertedSteps, error: stepsError } = await supabase
          .from('sequence_step')
          .insert(normalized.steps.map((s) => ({ sequence_id: sequence.id, ...s })))
          .select('*')
        if (stepsError) {
          // No orphaned shell sequences: unwind the parent (steps cascade).
          // The workspace fence is redundant with the insert above but keeps
          // this service-role DELETE tenancy-filtered like every other query.
          await supabase
            .from('sequence')
            .delete()
            .eq('id', sequence.id)
            .eq('workspace_id', targetWs)
          return { success: false, error: `Failed to create sequence steps: ${stepsError.message}` }
        }

        return {
          success: true,
          sequence: { ...sequence, steps: insertedSteps ?? [] },
          url: getSequenceUrl(sequence.id as string),
          merge_fields_used: mergeFieldsUsed(normalized.steps),
          ...workspaceEcho(targetWs, ws.workspaceName),
          message:
            'Draft created. Nothing sends until contacts are enrolled and the person says yes to the launch card (launch_sequence), or launches from the Review & Launch screen at the url above.',
        }
      },
    }),

    update_sequence: tool({
      description:
        "Update a sequence's structure (name, description, steps — reconciled by id, send_window, timezone, delay_unit) or transition its status: pause, resume, or archive. Edits follow GRADUATED per-step rules even while contacts are enrolled: subject/body copy, delays of steps nobody has received, schedule fields, and steps ADDED at the end are always editable (pending send times are recomputed from each contact's last actual send, never causing an immediate burst); deleting a step with send history or one a contact is about to receive, reordering steps at-or-before any active contact's position, or changing a sent step's delay/threading is refused PER STEP with reasons (code 'step_guarded' + guard_errors). Deactivating a step (is_active false) is always allowed — the engine skips it. Resume reschedules past-due sends forward through the send window — it never bursts the backlog. Cannot launch a draft: that is launch_sequence, on the person's yes to its card. Archiving exits all active enrollments; it does not retract sent email.",
      inputSchema: z.object({
        sequence_id: z.string().describe('UUID of the sequence to update'),
        name: z.string().max(200).optional().describe('New name'),
        description: z.string().max(2000).optional().describe('New description (empty string clears it)'),
        steps: z
          .array(updateStepInputSchema)
          .min(1)
          .max(20)
          .optional()
          .describe(
            'The FULL desired step list (max 20), reconciled by id: include every step to keep (with its id, from get_sequence), give new steps no id, and leave out steps to delete (deletion is refused per-step when guarded).',
          ),
        timezone: z.string().optional().describe('New IANA timezone for the send schedule'),
        send_window: sendWindowSchema.optional().describe('New send window'),
        delay_unit: z.enum(['business', 'calendar']).optional().describe('New delay unit'),
        status: z
          .enum(['pause', 'resume', 'archive'])
          .optional()
          .describe(
            "Lifecycle transition: 'pause' an active sequence, 'resume' a paused one, or 'archive' (exits all active enrollments as removed). Launching a draft is NOT available here: that is launch_sequence, on the person's yes.",
          ),
      }),
      execute: async ({ sequence_id, name, description, steps, timezone, send_window, delay_unit, status }) => {
        // Route to the SEQUENCE's own workspace: a sequence_id copied out of
        // another workspace the user belongs to must be edited THERE, never
        // silently miss because the read stayed pinned to the session
        // workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'sequence',
          sequence_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Sequence not found' }
        const targetWs = resolved.workspaceId

        const { data: sequence, error } = await loadSequence(sequence_id, targetWs)
        if (error) return { success: false, error: error.message }
        if (!sequence) return { success: false, error: 'Sequence not found' }

        // Structural tenancy fence: every write below keys on the id of the
        // row loadSequence just fenced to `targetWs` — NEVER the raw input
        // sequence_id, and never the session workspaceId. sequence_step
        // carries no workspace_id column and MCP runs on a service-role
        // client (no RLS backstop), so keying the step writes on the fenced
        // row is what keeps them workspace-safe even if this code is later
        // reordered or extracted into a helper.
        const fencedSequenceId = sequence.id as string

        const wantsStructureEdit =
          name !== undefined ||
          description !== undefined ||
          steps !== undefined ||
          timezone !== undefined ||
          send_window !== undefined ||
          delay_unit !== undefined

        if (wantsStructureEdit) {
          // Steps arrive with explicit step_order — sort them so array
          // position (what the shared reconcile keys order on) matches.
          let orderedSteps: StepInput[] | undefined
          if (steps !== undefined) {
            const ordered = sortStepsByOrder(steps)
            if (!ordered.ok) return { success: false, error: ordered.error }
            orderedSteps = ordered.steps
          }

          // Graduated per-step rules + reconcile-by-id + pending recompute —
          // the exact implementation behind the PATCH route (no drift). All
          // writes inside key on the fenced row's id (see fencedSequenceId).
          const result = await updateSequenceStructure(supabase, {
            workspaceId: targetWs,
            sequence: {
              id: fencedSequenceId,
              timezone: sequence.timezone as string,
              delay_unit: sequence.delay_unit as 'business' | 'calendar',
              send_window: sequence.send_window,
            },
            input: {
              name,
              description,
              timezone,
              send_window,
              delay_unit,
              steps: orderedSteps,
            },
          })
          if (!result.ok) {
            if (result.code === 'step_guarded') {
              return {
                success: false,
                code: 'step_guarded',
                error: result.error,
                guard_errors: result.guardErrors,
              }
            }
            return { success: false, error: result.error }
          }
        }

        // ── Status transition (mirrors the PATCH route exactly) ─────────
        if (status !== undefined) {
          const current = sequence.status as string
          if (status === 'archive') {
            const { error: archiveError } = await supabase
              .from('sequence')
              .update({ status: 'archived', auto_send: false })
              .eq('id', fencedSequenceId)
              .eq('workspace_id', targetWs)
            if (archiveError) return { success: false, error: archiveError.message }
            const { error: exitError } = await supabase
              .from('sequence_enrollment')
              .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
              .eq('workspace_id', targetWs)
              .eq('sequence_id', fencedSequenceId)
              .eq('status', 'active')
            if (exitError) return { success: false, error: exitError.message }
          } else if (status === 'pause') {
            if (current !== 'active') {
              return { success: false, error: `Cannot pause a ${current} sequence` }
            }
            const { error: pauseError } = await supabase
              .from('sequence')
              .update({ status: 'paused' })
              .eq('id', fencedSequenceId)
              .eq('workspace_id', targetWs)
              .eq('status', 'active')
            if (pauseError) return { success: false, error: pauseError.message }
          } else if (status === 'resume') {
            if (current !== 'paused') {
              return {
                success: false,
                error:
                  current === 'draft'
                    ? 'Draft sequences are launched with launch_sequence (on the person\'s yes to its card), not by a status edit'
                    : `Cannot resume a ${current} sequence`,
              }
            }
            // Shared never-burst reschedule (same code the PATCH route runs).
            const { error: resumeScheduleError } = await resumePastDueEnrollments(supabase, {
              id: fencedSequenceId,
              delay_unit: sequence.delay_unit as 'business' | 'calendar',
              timezone: sequence.timezone as string,
              send_window: sequence.send_window,
            })
            if (resumeScheduleError) return { success: false, error: resumeScheduleError }
            const { error: resumeError } = await supabase
              .from('sequence')
              .update({ status: 'active' })
              .eq('id', fencedSequenceId)
              .eq('workspace_id', targetWs)
              .eq('status', 'paused')
            if (resumeError) return { success: false, error: resumeError.message }
          }
        }

        const { data: updated, error: reloadError } = await loadSequence(sequence_id, targetWs)
        if (reloadError || !updated) {
          return { success: false, error: reloadError?.message || 'Failed to reload sequence' }
        }
        return { success: true, sequence: updated, url: getSequenceUrl(sequence_id) }
      },
    }),

    list_sequences: tool({
      description:
        "List the workspace's outreach sequences with status and headline enrollment counts (total / active / replied). Use get_sequence for per-step metrics and per-contact detail.",
      inputSchema: z.object({}),
      execute: async () => {
        const { data: sequences, error } = await supabase
          .from('sequence')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
        if (error) return { success: false, error: error.message }

        const rows = sequences ?? []
        const ids = rows.map((s) => s.id as string)
        const counts = new Map<string, { total: number; active: number; replied: number }>()
        if (ids.length > 0) {
          const { data: enrollments, error: enrollmentError } = await supabase
            .from('sequence_enrollment')
            .select('sequence_id, status, exit_reason')
            .eq('workspace_id', workspaceId)
            .in('sequence_id', ids)
          if (enrollmentError) return { success: false, error: enrollmentError.message }
          for (const e of enrollments ?? []) {
            const entry = counts.get(e.sequence_id as string) ?? { total: 0, active: 0, replied: 0 }
            entry.total += 1
            if (e.status === 'active') entry.active += 1
            if (e.exit_reason === 'replied') entry.replied += 1
            counts.set(e.sequence_id as string, entry)
          }
        }

        return {
          success: true,
          sequences: rows.map((s) => ({
            ...s,
            enrollment_counts: counts.get(s.id as string) ?? { total: 0, active: 0, replied: 0 },
            url: getSequenceUrl(s.id as string),
          })),
        }
      },
    }),

    get_sequence: tool({
      description:
        'Get full detail for one sequence: its steps with per-step sent/failed counts, headline enrollment_counts (always covering ALL enrollments), and a per-contact enrollment list with contact, status, current step, next send time, and exit reason (replied / completed / removed / opted_out / failed). The per-contact list is capped (default 50) — enrollments_total and enrollments_truncated report the full picture. Use this to answer questions like "how is my investor outreach going?" or "who replied?".',
      inputSchema: z.object({
        sequence_id: z.string().describe('UUID of the sequence'),
        enrollment_limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Max enrollments to include in the per-contact list (default 50, max 200). enrollment_counts and per-step counts always cover every enrollment regardless of this cap.',
          ),
      }),
      execute: async ({ sequence_id, enrollment_limit }) => {
        const { data: sequence, error } = await loadSequence(sequence_id)
        if (error) return { success: false, error: error.message }
        if (!sequence) return { success: false, error: 'Sequence not found' }

        const [stepsRes, enrollmentsRes] = await Promise.all([
          supabase
            .from('sequence_step')
            .select('*')
            .eq('sequence_id', sequence_id)
            .order('step_order', { ascending: true }),
          supabase
            .from('sequence_enrollment')
            .select('*, contact:contact_id(id, full_name, email)')
            .eq('sequence_id', sequence_id)
            .eq('workspace_id', workspaceId)
            .order('created_at', { ascending: true }),
        ])
        if (stepsRes.error) return { success: false, error: stepsRes.error.message }
        if (enrollmentsRes.error) return { success: false, error: enrollmentsRes.error.message }

        const enrollments = enrollmentsRes.data ?? []

        // Per-step sent/failed counts from the send ledger.
        const stepCounts = new Map<string, { sent: number; failed: number }>()
        const enrollmentIds = enrollments.map((e) => e.id as string)
        if (enrollmentIds.length > 0) {
          const { data: sends, error: sendsError } = await supabase
            .from('sequence_send')
            .select('step_id, status')
            .in('enrollment_id', enrollmentIds)
          if (sendsError) return { success: false, error: sendsError.message }
          for (const s of sends ?? []) {
            const entry = stepCounts.get(s.step_id as string) ?? { sent: 0, failed: 0 }
            if (s.status === 'sent') entry.sent += 1
            if (s.status === 'failed') entry.failed += 1
            stepCounts.set(s.step_id as string, entry)
          }
        }

        // Cap the per-contact list so a large sequence cannot blow the model's
        // context window. The aggregates above (enrollment_counts, per-step
        // sent/failed) are computed from the FULL set, so headline answers
        // stay accurate even when the list is truncated.
        const limit = enrollment_limit ?? 50
        const listed = enrollments.slice(0, limit)

        // The embedded contact is RLS-hidden on a user client when it is another
        // member's private/team contact; this may run service-role, so null it
        // the same way (contact-visibility.ts). The enrollment row stays.
        const visibleContactIds = new Set(
          (
            await filterVisibleContacts(
              supabase,
              userId,
              listed
                .map((e) => e.contact as { id?: unknown } | null)
                .filter((c): c is { id?: unknown } => Boolean(c)),
            )
          ).map((c) => c.id),
        )

        return {
          success: true,
          sequence,
          url: getSequenceUrl(sequence_id),
          enrollment_counts: countEnrollments(
            enrollments as Array<{ status: string | null; exit_reason: string | null }>,
          ),
          steps: (stepsRes.data ?? []).map((s) => ({
            ...s,
            counts: stepCounts.get(s.id as string) ?? { sent: 0, failed: 0 },
          })),
          enrollments_total: enrollments.length,
          enrollments_truncated: enrollments.length > limit,
          enrollments: listed.map((e) => {
            const embedded = e.contact as { id: string; full_name: string | null; email: string | null } | null
            const contact = embedded && visibleContactIds.has(embedded.id) ? embedded : null
            return {
              id: e.id,
              contact_id: e.contact_id,
              contact_name: contact?.full_name ?? null,
              contact_email: e.contact_email,
              status: e.status,
              exit_reason: e.exit_reason,
              current_step_order: e.current_step_order,
              next_send_at: e.next_send_at,
              enrolled_at: e.created_at,
            }
          }),
        }
      },
    }),

    enroll_contacts_in_sequence: tool({
      description:
        'Stage CRM contacts into a sequence (does NOT send or schedule anything — enrollments stay inert until launch_sequence\'s card gets the person\'s yes, or they launch from the Review & Launch screen). Applies the same guards as the UI and returns per-contact results: enrolled contact ids plus skipped entries with a reason — not_found (not a contact in this workspace), no_email, suppressed (on the opt-out list), or already_active (already in an active sequence anywhere in the workspace, or previously enrolled in this one). Use list_contacts / find to pick contacts first, then report the outcome, e.g. "14 enrolled, 2 skipped (already in another sequence)".',
      inputSchema: z.object({
        sequence_id: z.string().describe('UUID of the sequence to enroll into'),
        contact_ids: z
          .array(z.string())
          .min(1)
          .max(200)
          .describe(
            'UUIDs of CRM contacts to enroll (max 200 per call — enroll a larger list in batches of 200).',
          ),
      }),
      execute: async ({ sequence_id, contact_ids }) => {
        // Route to the SEQUENCE's own workspace. `enrollContacts` filters its
        // OWN contact lookup by whatever `workspaceId` it is given, so passing
        // the resolved workspace here is what makes "contacts must be in the
        // same workspace" true automatically — a contact from the session
        // workspace can never be enrolled into a sequence that actually lives
        // in another one, and vice versa.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'sequence',
          sequence_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Sequence not found' }
        const targetWs = resolved.workspaceId

        // enrollContacts documents "not visible under the contact's RLS" as
        // not_found, but this may run service-role where RLS does not apply:
        // fence the ids against the caller first (fails closed), and report the
        // hidden ones exactly like a contact that does not exist.
        const uniqueIds = [...new Set(contact_ids)]
        const visibleIds = new Set(
          (await filterVisibleContacts(supabase, userId, uniqueIds.map((id) => ({ id })))).map((c) => c.id),
        )
        const hiddenSkips = uniqueIds
          .filter((id) => !visibleIds.has(id))
          .map((id) => ({ contact_id: id, reason: 'not_found' as const }))

        const result = await enrollContacts(supabase, {
          workspaceId: targetWs,
          sequenceId: sequence_id,
          enrolledBy: userId,
          contactIds: uniqueIds.filter((id) => visibleIds.has(id)),
        })
        if (!result.ok) {
          if (result.code === 'sequence_not_found') {
            return { success: false, error: 'Sequence not found' }
          }
          if (result.code === 'sequence_archived') {
            return { success: false, error: 'Cannot enroll into an archived sequence' }
          }
          return { success: false, error: 'Failed to enroll contacts' }
        }
        // The NAME, read after the enrollment landed. "14 enrolled in Q4
        // Outbound" is the sentence the user needs; "14 enrolled in
        // 7f3a…" is not, and the caller cannot supply it — the model passes a
        // uuid. Failure degrades to null rather than failing the call: the
        // enrollment already happened, and withholding it over a display
        // string would be the worse outcome.
        const { data: sequenceRow } = await loadSequence(sequence_id, targetWs)
        const sequenceName = (sequenceRow as { name?: unknown } | null)?.name
        // Hidden ids read as not_found, in the caller's input order.
        const order = new Map(uniqueIds.map((id, i) => [id, i]))
        const skipped = [...hiddenSkips, ...result.skipped].sort(
          (a, b) => (order.get(a.contact_id) ?? 0) - (order.get(b.contact_id) ?? 0),
        )
        return {
          success: true,
          enrolled: result.enrolled,
          skipped,
          enrolled_count: result.enrolled.length,
          skipped_count: skipped.length,
          sequence_id,
          sequence_name:
            typeof sequenceName === 'string' && sequenceName.trim() !== '' ? sequenceName : null,
          url: getSequenceUrl(sequence_id),
          message:
            'Enrollments are staged and inert — nothing sends until the person says yes to launch_sequence\'s card, or launches from the Review & Launch screen at the url above.',
        }
      },
    }),

    remove_from_sequence: tool({
      description:
        "Remove a contact from a sequence: their enrollment exits with reason 'removed' and no further steps will be sent to them. This never retracts or recalls email that was already sent — it only stops future sends. Identify the enrollment by enrollment_id (from get_sequence) or by contact_id.",
      inputSchema: z.object({
        sequence_id: z.string().describe('UUID of the sequence'),
        enrollment_id: z
          .string()
          .optional()
          .describe('UUID of the enrollment to remove (from get_sequence). Provide this OR contact_id.'),
        contact_id: z
          .string()
          .optional()
          .describe('UUID of the enrolled contact to remove. Provide this OR enrollment_id.'),
      }),
      execute: async ({ sequence_id, enrollment_id, contact_id }) => {
        if (!enrollment_id && !contact_id) {
          return { success: false, error: 'Provide enrollment_id or contact_id' }
        }

        // Route to the SEQUENCE's own workspace. A resolve failure (unknown or
        // non-member sequence_id) keeps THIS tool's existing not-found shape —
        // 'Enrollment not found' — since that is what a bad sequence_id already
        // produced before this fence existed (no enrollment row ever matched).
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'sequence',
          sequence_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Enrollment not found' }
        const targetWs = resolved.workspaceId

        let query = supabase
          .from('sequence_enrollment')
          .select('id, status, exit_reason, contact_email')
          .eq('sequence_id', sequence_id)
          .eq('workspace_id', targetWs)
        query = enrollment_id ? query.eq('id', enrollment_id) : query.eq('contact_id', contact_id)
        const { data: enrollment, error } = await query.maybeSingle()
        if (error) return { success: false, error: error.message }
        if (!enrollment) return { success: false, error: 'Enrollment not found' }

        if (enrollment.status !== 'active') {
          return {
            success: true,
            removed: false,
            message: `Enrollment already exited (reason: ${enrollment.exit_reason ?? 'unknown'}) — nothing to remove.`,
          }
        }

        const { error: exitError } = await supabase
          .from('sequence_enrollment')
          .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
          .eq('id', enrollment.id)
          .eq('status', 'active')
        if (exitError) return { success: false, error: exitError.message }

        return {
          success: true,
          removed: true,
          message:
            'Contact removed — no further steps will be sent. Emails already sent are not retracted.',
        }
      },
    }),

    launch_sequence: tool({
      description:
        "Launch a sequence: start emailing the contacts staged in it (enroll_contacts_in_sequence first). It never sends on the call: it gives the person ONE approval card showing every email, when each goes, the mailbox it sends from and every recipient, and the sequence launches only on their yes (the card in the app, or texting back \"yes\" with the card's code). Step 1 then goes out in the next send window; a reply stops that contact's emails and opted-out contacts are skipped. Works on a draft, or on an active sequence for the contacts staged since it launched; resume a paused one with update_sequence. Up to 200 people per card. Tell the person in a line or two what sends (what_sends) and that it waits for their yes; never say it is sending. Don't call it again while the card waits.",
      inputSchema: z.object({
        sequence_id: z.string().describe('UUID of the sequence to launch'),
      }),
      execute: async ({ sequence_id }) => {
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'sequence',
          sequence_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Sequence not found' }
        const targetWs = resolved.workspaceId

        const loaded = await loadSequenceForLaunch(supabase, { workspaceId: targetWs, sequenceId: sequence_id })
        if (!loaded.ok) return { success: false, error: loaded.message }
        const sequence = loaded.sequence
        if (sequence.status === 'paused') {
          return {
            success: false,
            code: 'SEQUENCE_PAUSED',
            error:
              'This sequence is paused: resuming it (update_sequence with status resume, on the person\'s yes) restarts everyone in it. Launch only adds newly staged contacts to a draft or active sequence.',
          }
        }
        const planned = await loadLaunchPlan(supabase, {
          workspaceId: targetWs,
          sequence,
          launcherUserId: userId,
          requireEnrollments: false,
        })
        if (!planned.ok) return { success: false, code: planned.extras?.code, error: planned.message }
        const { plan } = planned
        // What a launch card may name: staged, never edited per person on
        // Review & Launch (the card shows the sequence's copy, not those
        // edits), and only contacts the person may see: this runs on a
        // service-role client, where the enrollments' RLS (227: the contact's
        // own visibility) does not apply, and a teammate's private contact
        // must never be on their card or sent to from their mailbox.
        const stagedAll = plan.enrollments.filter(isStaged)
        const edited = stagedAll.filter((e) => e.overrides && Object.keys(e.overrides).length > 0)
        const visibleContactIds = new Set(
          (await filterVisibleContacts(supabase, userId, stagedAll.filter((e) => e.contact_id).map((e) => ({ id: e.contact_id as string })))).map((c) => c.id),
        )
        const staged = stagedAll.filter(
          (e) => !edited.includes(e) && (e.contact_id === null || visibleContactIds.has(e.contact_id)),
        )
        const url = getSequenceUrl(sequence.id)

        // The person said yes on the card: launch exactly what it showed.
        const approved = approvedOutreach(ctx.approvedCall, 'launch_sequence', 'sequence', sequence.id)
        if (approved) {
          if (outreachContentHash(plan) !== approved.content_hash) {
            return {
              success: false,
              code: 'SEQUENCE_CHANGED',
              error:
                'The emails, schedule or sending mailbox changed after the card was made, so nothing was sent. Call launch_sequence again for a new card showing them as they are now.',
            }
          }
          const named = new Set(approved.recipient_ids)
          const targets = staged.filter((e) => named.has(e.id))
          if (targets.length === 0) {
            return {
              success: false,
              code: 'NOTHING_TO_SEND',
              error: 'Nobody on the card is still waiting to be sent (they were removed or already sent), so nothing was sent.',
            }
          }
          const failures = renderFailures(plan, targets)
          if (failures.length > 0) {
            return { success: false, code: 'unresolved_tokens', error: 'A merge field has no value for some recipients, so nothing was sent.', failures }
          }
          // Only the named ones still on a card's terms (staged, unedited, visible).
          const targetIds = new Set(targets.map((e) => e.id))
          const armed = await armLaunch(supabase, {
            workspaceId: targetWs,
            plan,
            launcherUserId: userId,
            only: (e) => targetIds.has(e.id),
          })
          if (!armed.ok) return { success: false, code: armed.extras?.code, error: armed.message }
          return {
            success: true,
            launched: true,
            sequence_id: sequence.id,
            sequence_name: sequence.name,
            armed_enrollments: armed.armed,
            url,
            message: `Launched “${sequence.name}”: step 1 goes to ${armed.armed} ${armed.armed === 1 ? 'person' : 'people'} in the next send window (${describeSendWindow(sequence)}). A reply stops their emails.`,
          }
        }

        // Nobody here to say yes (a work run's or a loop's own turn).
        if (ctx.unattended && !ctx.approvalContext) {
          return {
            success: false,
            code: 'NEEDS_PERSON',
            error: 'Launching waits for the person\'s yes, and nobody is here to give it. Leave the launch to them; say what is staged.',
          }
        }
        if (staged.length === 0) {
          return {
            success: false,
            code: 'NO_RECIPIENTS',
            error: edited.length
              ? `The ${edited.length} staged ${edited.length === 1 ? 'contact has' : 'contacts have'} emails edited for them on Review & Launch, which this card can't show: they launch from Review & Launch at the url.`
              : 'Nobody is waiting to be sent in this sequence. Enroll contacts first (enroll_contacts_in_sequence).',
            url,
          }
        }
        const onCard = staged.slice(0, LAUNCH_RECIPIENTS_MAX)
        const failures = renderFailures(plan, onCard)
        if (failures.length > 0) {
          const emailOf = new Map(onCard.map((e) => [e.id, e.contact_email]))
          return {
            success: false,
            code: 'unresolved_tokens',
            error:
              'Some emails would go out with an empty merge field, so no card was made. Give the field a fallback ({{first_name|there}}) with update_sequence, or remove those contacts, then call launch_sequence again.',
            failures: failures.slice(0, 20).map((f) => ({ ...f, email: emailOf.get(f.enrollment_id) ?? null })),
          }
        }
        const recipients: LaunchRecipient[] = onCard.map((e) => ({
          id: e.id,
          name: e.contact?.full_name ?? null,
          email: e.contact_email,
        }))
        const contentHash = outreachContentHash(plan)
        const held = await raiseLaunchCard(getServiceClient(), {
          userId,
          workspaceId: targetWs,
          toolName: 'launch_sequence',
          input: launchCardInput({ idKey: 'sequence_id', id: sequence.id, plan, recipients, contentHash }),
          card: launchCardCopy({ plan, recipients }),
          outreach: { kind: 'sequence', id: sequence.id, content_hash: contentHash, recipient_ids: recipients.map((r) => r.id) },
          origin: { conversationId: ctx.conversationId ?? null, approvalContext: ctx.approvalContext },
        })
        const what = launchSummary({ plan, recipients })
        const later = staged.length - onCard.length
        return {
          success: false,
          code: 'APPROVAL_REQUIRED',
          approval_id: held.ok ? held.approval_id : null,
          what_sends: what,
          ...(later > 0 ? { not_on_this_card: later } : {}),
          ...(edited.length ? { edited_on_review_and_launch: edited.length } : {}),
          url,
          message: held.ok
            ? `Nothing has sent yet. The person has a card to launch “${sequence.name}”${later > 0 ? ` for the first ${onCard.length} people (${later} more wait for the next card)` : ''}; it sends only on their yes. Tell them in a line or two what it sends (what_sends) and that it waits for their OK. By text they get a code to reply with right after your message: don't write a code yourself. Don't call launch_sequence again.`
            : `Nothing was sent, and no card could be made: ${held.error} They can launch from Review & Launch at the url.`,
        }
      },
    }),
  }
}
