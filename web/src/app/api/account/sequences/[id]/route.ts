/**
 * /api/account/sequences/[id] — detail, edit, lifecycle transitions.
 *
 * RLS-scoped client throughout (never the service client). Rules enforced
 * here on top of RLS:
 *   - STRUCTURE edits run under the GRADUATED per-step rules (the old blanket
 *     'sequence_locked' is gone): copy, delays of never-sent steps, schedule
 *     fields, name/description and appended steps stay editable mid-flight;
 *     deleting a step with ledger history, reordering at-or-before the active
 *     frontier, or changing a sent step's delay / threading is refused
 *     PER STEP → 400 details { code: 'step_guarded', guard_errors:
 *     [{ step_id, step_order, reason }] }. Steps are reconciled BY ID (update
 *     matched / insert new / delete unguarded); pending next_send_at is
 *     recomputed from each enrollment's latest sent ledger row, never landing
 *     earlier than now+2min. Single shared implementation:
 *     updateSequenceStructure in src/lib/sequences/mutations.ts (same code
 *     path as the update_sequence agent tool — no drift).
 *   - Status transitions: active→paused, paused→active (resume — past-due
 *     next_send_at is recomputed forward through the send window, NEVER
 *     bursts), any→archived (exits all active enrollments as 'removed').
 *     draft→active only ever happens through /launch.
 *   - DELETE is refused — archive instead; the send ledger is history.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import {
  resolveOwnedEmailAccount,
  resumePastDueEnrollments,
  updateSequenceStructure,
} from '@/lib/sequences/mutations'

// PostgREST caps a response at 1000 rows (silently), so the enrollment and
// send reads are paged with .range() until a short page.
const PAGE_SIZE = 1000

async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { data: rows, error }
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE_SIZE) return { data: rows, error: null }
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const { data: sequence, error } = await supabase
    .from('sequence')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[sequences] detail load failed:', error.message)
    return serverError()
  }
  if (!sequence) return notFound('Sequence not found')

  const [{ data: steps, error: stepsError }, { data: enrollments, error: enrollmentsError }] =
    await Promise.all([
      supabase
        .from('sequence_step')
        .select('*')
        .eq('sequence_id', id)
        .order('step_order', { ascending: true }),
      readAllPages((from, to) =>
        supabase
          .from('sequence_enrollment')
          .select('*, contact:contact_id(id, full_name, email, avatar_url)')
          .eq('sequence_id', id)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
    ])
  if (stepsError || enrollmentsError) {
    console.error(
      '[sequences] detail children load failed:',
      stepsError?.message ?? enrollmentsError?.message,
    )
    return serverError()
  }

  // Per-step ledger counts. in_flight ('claimed'/'sending') matters because
  // the edit guards (stepEditVerdicts) treat ANY ledger row as send history —
  // the builder computes has_sends from these counts and must reach the same
  // verdict the server will, or a mid-send step renders freely editable and
  // the save is guaranteed to bounce with step_guarded.
  const stepCounts = new Map<string, { sent: number; failed: number; in_flight: number }>()
  // Keyed by this sequence's step ids (a handful), not its enrollment ids —
  // a few hundred enrollment uuids overflow the URL — the same filter the
  // server's edit guard reads (updateSequenceStructure).
  const stepIds = (steps ?? []).map((s) => s.id as string)
  if (stepIds.length > 0) {
    const { data: sends, error: sendsError } = await readAllPages((from, to) =>
      supabase
        .from('sequence_send')
        .select('id, step_id, status')
        .eq('workspace_id', workspaceId)
        .in('step_id', stepIds)
        .order('id')
        .range(from, to),
    )
    if (sendsError) {
      console.error('[sequences] send counts failed:', sendsError.message)
      return serverError()
    }
    for (const s of sends) {
      const entry = stepCounts.get(s.step_id) ?? { sent: 0, failed: 0, in_flight: 0 }
      if (s.status === 'sent') entry.sent += 1
      if (s.status === 'failed') entry.failed += 1
      if (s.status === 'claimed' || s.status === 'sending') entry.in_flight += 1
      stepCounts.set(s.step_id, entry)
    }
  }

  return NextResponse.json({
    sequence,
    steps: (steps ?? []).map((s) => ({
      ...s,
      counts: stepCounts.get(s.id as string) ?? { sent: 0, failed: 0, in_flight: 0 },
    })),
    enrollments: enrollments ?? [],
  })
}

const STRUCTURE_FIELDS = [
  'name',
  'description',
  'timezone',
  'send_window',
  'delay_unit',
  'steps',
] as const

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const { data: sequence, error } = await supabase
    .from('sequence')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[sequences] patch load failed:', error.message)
    return serverError()
  }
  if (!sequence) return notFound('Sequence not found')

  // Sending-account change: draft-only. Launch pins the From identity —
  // switching mailboxes mid-flight would change who live threads come from
  // and break createReply threading on the original account. (Draft-only is
  // deliberately simpler and stricter than a has-sends check: it has no
  // contact-visibility blind spots and matches the builder's rule.)
  if (
    body.sending_account_id !== undefined &&
    body.sending_account_id !== sequence.sending_account_id
  ) {
    if (sequence.status !== 'draft') {
      return badRequest(
        'The sending account is pinned once a sequence has launched — its threads come from that identity',
        { code: 'sending_account_locked' },
      )
    }
    if (typeof body.sending_account_id !== 'string' || body.sending_account_id === '') {
      return badRequest('sending_account_id must be a connected account id', {
        code: 'invalid_sending_account',
      })
    }
    const account = await resolveOwnedEmailAccount(supabase, {
      accountId: body.sending_account_id,
      userId: auth.user.id,
    })
    if (!account) {
      return badRequest('That sending account is not one of your connected email accounts', {
        code: 'invalid_sending_account',
      })
    }
    const { error: accountUpdateError } = await supabase
      .from('sequence')
      .update({ sending_account_id: account.id })
      .eq('id', sequence.id as string)
      .eq('workspace_id', workspaceId)
    if (accountUpdateError) {
      if (accountUpdateError.code === '42501') {
        return badRequest('That sending account is not connected to this workspace', {
          code: 'account_not_reachable',
        })
      }
      console.error('[sequences] sending account update failed:', accountUpdateError.message)
      return serverError()
    }
  }

  const wantsStructureEdit = STRUCTURE_FIELDS.some((f) => body[f] !== undefined)

  if (wantsStructureEdit) {
    // Graduated per-step rules + reconcile-by-id + pending recompute — the
    // single shared implementation (also behind the update_sequence agent
    // tool). Guard violations come back per step, never as a form-wide lock.
    const result = await updateSequenceStructure(supabase, {
      workspaceId,
      sequence: {
        id: sequence.id as string,
        timezone: sequence.timezone as string,
        delay_unit: sequence.delay_unit as 'business' | 'calendar',
        send_window: sequence.send_window,
      },
      input: {
        name: body.name,
        description: body.description,
        timezone: body.timezone,
        send_window: body.send_window,
        delay_unit: body.delay_unit,
        steps: body.steps,
      },
    })
    if (!result.ok) {
      if (result.code === 'invalid_steps') return badRequest(result.error)
      if (result.code === 'step_guarded') {
        return badRequest(result.error, {
          code: 'step_guarded',
          guard_errors: result.guardErrors,
        })
      }
      return serverError()
    }
  }

  // ── Status transition ──────────────────────────────────────────────
  if (body.status !== undefined) {
    const target = body.status
    const current = sequence.status as string

    if (target === 'archived') {
      // any → archived; all active enrollments exit 'removed'. No hard delete.
      const { error: archiveError } = await supabase
        .from('sequence')
        .update({ status: 'archived', auto_send: false })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
      if (archiveError) {
        console.error('[sequences] archive failed:', archiveError.message)
        return serverError()
      }
      const { error: exitError } = await supabase
        .from('sequence_enrollment')
        .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
        .eq('sequence_id', id)
        .eq('status', 'active')
      if (exitError) {
        console.error('[sequences] archive enrollment exit failed:', exitError.message)
        return serverError()
      }
    } else if (target === 'paused') {
      if (current !== 'active') {
        return badRequest(`Cannot pause a ${current} sequence`)
      }
      const { error: pauseError } = await supabase
        .from('sequence')
        .update({ status: 'paused' })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'active')
      if (pauseError) {
        console.error('[sequences] pause failed:', pauseError.message)
        return serverError()
      }
    } else if (target === 'active') {
      if (current !== 'paused') {
        return badRequest(
          current === 'draft'
            ? 'Draft sequences are armed via launch, not a status edit'
            : `Cannot resume a ${current} sequence`,
        )
      }
      // Resume: snap every PAST-DUE next_send_at forward through the send
      // window from NOW (delay already served while paused) — never fire the
      // backlog as a burst. Shared with the AI agent tools (mutations.ts).
      const { error: resumeScheduleError } = await resumePastDueEnrollments(supabase, {
        id,
        delay_unit: sequence.delay_unit as 'business' | 'calendar',
        timezone: sequence.timezone as string,
        send_window: sequence.send_window,
      })
      if (resumeScheduleError) return serverError()
      const { error: resumeError } = await supabase
        .from('sequence')
        .update({ status: 'active' })
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .eq('status', 'paused')
      if (resumeError) {
        console.error('[sequences] resume failed:', resumeError.message)
        return serverError()
      }
    } else {
      return badRequest(`Unsupported status transition to '${String(target)}'`)
    }
  }

  const { data: updated, error: reloadError } = await supabase
    .from('sequence')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (reloadError || !updated) {
    console.error('[sequences] patch reload failed:', reloadError?.message)
    return serverError()
  }
  return NextResponse.json({ sequence: updated })
}

export async function DELETE() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return badRequest('Sequences cannot be deleted — archive instead', {
    code: 'archive_instead',
  })
}
