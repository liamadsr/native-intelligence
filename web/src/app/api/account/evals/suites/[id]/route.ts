/**
 * /api/account/evals/suites/[id] — suite detail, edit, delete.
 *
 * A cross-workspace id is a 404, never a 403: every read here is
 * workspace-scoped, so an id the caller cannot see must not be confirmable.
 *
 * DELETE really deletes, unlike the prospecting lists route which archives.
 * The reason they differ: a prospect list's entries are the workspace's
 * accumulated suppression set, so destroying one re-opens every dismissal,
 * while a suite holds only synthetic meetings the assistant can rewrite in a
 * sentence. Two things it must do that a bare `delete` would not:
 *
 *   1. Refuse (409) while a run of this suite is live. `eval_run` cascades
 *      from the suite, so deleting mid-run would drop the row an Inngest step
 *      is about to write to, and the run would fail with an error nobody can
 *      trace back to a click.
 *   2. Delete each case's TEMPLATE CAPTURE, not just the case. The composite
 *      FK points case → capture, so a case delete leaves the capture behind:
 *      an orphaned `is_eval` row that no screen lists and nothing ever
 *      collects. Capture deletion is a service-client write (RLS on captures
 *      is the caller's own, and these rows are `visibility: 'private'` under
 *      the run starter, who need not be the person deleting the suite) and is
 *      guarded by `is_eval = true` on the delete itself, so a mis-seeded case
 *      pointing at a real capture cannot take one down with it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { getSuite, listCases, listRuns, SUITE_FIELDS } from '@/lib/evals/queries'
import type { EvalSuiteRow } from '@/lib/evals/types'
import { UpdateSuiteSchema } from '../../schemas'
import { parseBody } from '../../parse-body'
import { collectTrialCaptureIds, deleteEvalCaptures } from '../../delete-captures'
import { recipeIsVisible } from '../target-recipe'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const suite = await getSuite(supabase, workspaceId, id)
  if (!suite) return notFound('Suite not found')

  const [cases, runs, target] = await Promise.all([
    listCases(supabase, id),
    listRuns(supabase, id),
    getSuiteTarget(supabase, suite.target_recipe_id),
  ])
  return NextResponse.json({ suite, cases, runs, target })
}

/**
 * The recipe this suite grades, as its NAME.
 *
 * The suite row carries only `target_recipe_id` and a `target_kind`, so every
 * screen could say was "Agent" — a label that is the same on every suite in
 * the workspace and therefore tells the reader nothing. One extra read on the
 * RLS-scoped client resolves it: system recipes are visible to every workspace
 * via `is_system`, workspace ones via their own policy, and a recipe the caller
 * cannot see (or one that was deleted out from under the suite) resolves to
 * `null` rather than failing the whole detail payload — the suite still loads,
 * it just says "an agent" instead of naming one.
 */
async function getSuiteTarget(
  supabase: SupabaseClient,
  recipeId: string | null,
): Promise<{ id: string; name: string; category: string } | null> {
  if (!recipeId) return null
  const { data, error } = await supabase
    .from('recipe')
    .select('id, name, category')
    .eq('id', recipeId)
    .maybeSingle()
  if (error) {
    console.error('[evals] suite target read failed:', error.message)
    return null
  }
  return (data as { id: string; name: string; category: string } | null) ?? null
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const parsed = await parseBody(request, UpdateSuiteSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  // Same check as the create route, for the same reason — see
  // `../target-recipe.ts`. Re-pointing a suite at a foreign recipe leaks
  // exactly as much as creating one that way.
  if (body.target_recipe_id) {
    const visible = await recipeIsVisible(supabase, body.target_recipe_id, workspaceId, user.id)
    if (visible === 'error') return serverError()
    if (!visible) return badRequest('That agent does not exist in this workspace')
  }

  // An empty patch is a no-op read, not a 400: the UI's toggles send only the
  // field they changed, and a race that sends nothing should not error.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.name !== undefined) patch.name = body.name
  if (body.description !== undefined) patch.description = body.description ?? null
  if (body.suite_kind !== undefined) patch.suite_kind = body.suite_kind
  if (body.watch !== undefined) patch.watch = body.watch
  if (body.judge_model !== undefined) patch.judge_model = body.judge_model ?? null
  if (body.target_recipe_id !== undefined) patch.target_recipe_id = body.target_recipe_id ?? null

  const { data, error } = await supabase
    .from('eval_suite')
    .update(patch)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(SUITE_FIELDS)
    .maybeSingle()

  if (error) {
    console.error('[evals] update suite failed:', error.message)
    return serverError()
  }
  if (!data) return notFound('Suite not found')

  return NextResponse.json({ suite: data as unknown as EvalSuiteRow })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const suite = await getSuite(supabase, workspaceId, id)
  if (!suite) return notFound('Suite not found')

  const { data: liveRuns, error: liveError } = await supabase
    .from('eval_run')
    .select('id')
    .eq('suite_id', id)
    .eq('is_live', true)
    .limit(1)

  if (liveError) {
    console.error('[evals] delete suite live-run check failed:', liveError.message)
    return serverError()
  }
  if ((liveRuns ?? []).length > 0) {
    return apiError('This suite has a run in flight. Stop it first.', {
      status: 409,
      code: 'RUN_ALREADY_LIVE',
    })
  }

  const { data: cases, error: casesError } = await supabase
    .from('eval_case')
    .select('id, capture_id')
    .eq('suite_id', id)
    .eq('workspace_id', workspaceId)

  if (casesError) {
    console.error('[evals] delete suite case read failed:', casesError.message)
    return serverError()
  }

  const caseRows = (cases ?? []) as { id: string; capture_id: string }[]
  const service = getServiceClient()
  // Collected BEFORE the cascade: `eval_trial` is what holds the clone capture
  // ids, and the suite delete cascades those rows away.
  const trialCaptureIds = await collectTrialCaptureIds(
    service,
    workspaceId,
    caseRows.map((c) => c.id),
  )

  const { error } = await supabase
    .from('eval_suite')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    console.error('[evals] delete suite failed:', error.message)
    return serverError()
  }

  // After the cascade, never before: a capture deleted first would cascade the
  // case out from under a suite delete that then failed, and the suite would
  // be left holding cases with no scripts.
  await deleteEvalCaptures(service, workspaceId, [
    ...caseRows.map((c) => c.capture_id),
    ...trialCaptureIds,
  ])

  return NextResponse.json({ deleted: true, id })
}
