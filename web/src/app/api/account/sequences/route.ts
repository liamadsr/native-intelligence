/**
 * /api/account/sequences — list + create.
 *
 * All sequence routes run on the RLS-scoped client from requireWorkspace —
 * NEVER the service client. Migration 227's policies are the boundary
 * (workspace membership; enrollment reads additionally ride contact
 * visibility), so a query returning nothing here means the caller may not see
 * it, which is the correct answer.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import {
  defaultOwnedEmailAccount,
  normalizeSteps,
  resolveOwnedEmailAccount,
} from '@/lib/sequences/mutations'
import { DEFAULT_SEND_WINDOW, normalizeWindow } from '@/lib/sequences/schedule'
import { isTimeZone } from '@/lib/chat-cards/calendar'

// PostgREST caps a response at 1000 rows (silently), so the enrollment read
// behind the headline counts is paged with .range() until a short page.
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

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data: sequences, error } = await supabase
    .from('sequence')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[sequences] list failed:', error.message)
    return serverError()
  }

  const rows = sequences ?? []
  const ids = rows.map((s) => s.id as string)

  // Headline counts per sequence: total / active / replied.
  const counts = new Map<string, { total: number; active: number; replied: number }>()
  if (ids.length > 0) {
    const { data: enrollments, error: enrollmentError } = await readAllPages((from, to) =>
      supabase
        .from('sequence_enrollment')
        .select('id, sequence_id, status, exit_reason')
        .in('sequence_id', ids)
        .order('id')
        .range(from, to),
    )
    if (enrollmentError) {
      console.error('[sequences] enrollment counts failed:', enrollmentError.message)
      return serverError()
    }
    for (const e of enrollments) {
      const entry = counts.get(e.sequence_id) ?? { total: 0, active: 0, replied: 0 }
      entry.total += 1
      if (e.status === 'active') entry.active += 1
      if (e.exit_reason === 'replied') entry.replied += 1
      counts.set(e.sequence_id, entry)
    }
  }

  return NextResponse.json({
    sequences: rows.map((s) => ({
      ...s,
      enrollment_counts: counts.get(s.id as string) ?? { total: 0, active: 0, replied: 0 },
    })),
  })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('name is required')

  const description =
    typeof body.description === 'string' && body.description.trim() !== ''
      ? body.description.trim()
      : null

  const timezone = typeof body.timezone === 'string' && body.timezone.trim() !== ''
    ? body.timezone.trim()
    : 'America/Los_Angeles'
  // Every send time is computed in this zone, so an unknown name stored here
  // breaks scheduling later, long after the create said it succeeded.
  if (!isTimeZone(timezone)) return badRequest('timezone must be an IANA zone like America/New_York')

  const delayUnit = body.delay_unit === 'calendar' ? 'calendar' : 'business'

  // Defensive parse — a bad window degrades to the default rather than storing
  // garbage the engine would then re-default on every read anyway.
  const sendWindow =
    body.send_window !== undefined ? normalizeWindow(body.send_window) : DEFAULT_SEND_WINDOW

  // Shared step normalization + validation (also used by the update path and
  // the AI agent tools — see src/lib/sequences/mutations.ts).
  const normalized = normalizeSteps(body.steps)
  if (!normalized.ok) return badRequest(normalized.error)
  const steps = normalized.steps

  // Sending identity is pinned from birth so the builder can always show
  // which mailbox a sequence sends from (launch re-validates and re-adopts
  // if the account vanishes in between). A caller-chosen account must be the
  // caller's own enabled email account; absent a choice, adopt their
  // default (primary preferred). No account connected → create proceeds
  // with NULL; the builder and launch both surface that state.
  let sendingAccountId: string | null = null
  if (typeof body.sending_account_id === 'string' && body.sending_account_id !== '') {
    const account = await resolveOwnedEmailAccount(supabase, {
      accountId: body.sending_account_id,
      userId: user.id,
    })
    if (!account) {
      return badRequest('That sending account is not one of your connected email accounts', {
        code: 'invalid_sending_account',
      })
    }
    sendingAccountId = account.id
  } else {
    sendingAccountId = (await defaultOwnedEmailAccount(supabase, user.id))?.id ?? null
  }

  const { data: sequence, error: sequenceError } = await supabase
    .from('sequence')
    .insert({
      workspace_id: workspaceId,
      name,
      description,
      status: 'draft',
      created_by: user.id,
      sending_account_id: sendingAccountId,
      timezone,
      send_window: sendWindow,
      delay_unit: delayUnit,
    })
    .select('*')
    .single()

  if (sequenceError || !sequence) {
    // 42501 = the workspace-reachability trigger rejecting the account.
    if (sequenceError?.code === '42501') {
      return badRequest('That sending account is not connected to this workspace', {
        code: 'account_not_reachable',
      })
    }
    console.error('[sequences] create failed:', sequenceError?.message)
    return serverError()
  }

  const { data: insertedSteps, error: stepsError } = await supabase
    .from('sequence_step')
    .insert(
      steps.map((s) => ({
        sequence_id: sequence.id,
        step_order: s.step_order,
        subject: s.subject,
        body: s.body,
        delay_days: s.delay_days,
        is_active: s.is_active,
      })),
    )
    .select('*')

  if (stepsError) {
    // No orphaned shell sequences: unwind the parent (steps cascade).
    console.error('[sequences] step insert failed, deleting sequence:', stepsError.message)
    await supabase.from('sequence').delete().eq('id', sequence.id)
    return serverError('Failed to create sequence steps')
  }

  return NextResponse.json({ sequence: { ...sequence, steps: insertedSteps ?? [] } }, { status: 201 })
}
