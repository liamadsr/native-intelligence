/**
 * /api/account/evals/cases/[id] — one case: read, refine, delete.
 *
 * GET returns the FULL row — script, chunks and expected outcomes — because
 * this is what the case editor opens. The list route deliberately does not.
 * It also returns the template capture's PARTICIPANTS alongside it: they live
 * on the capture, not the case row, and without them the editor has no way to
 * read the current list back — which is how a paste that stages only the
 * speakers it named used to overwrite the rest.
 *
 * PATCH goes through `updateEvalCase`, which recomputes the frozen chunks and
 * rewrites the template capture's transcript whenever the script changes.
 * Those two must move together: a script edited without re-freezing would
 * replay through boundaries computed from the OLD timings, and every run
 * before and after the edit would silently stop being comparable.
 *
 * DELETE removes the case and then its captures — the template AND every
 * per-trial clone. See `../../delete-captures.ts` for why they need their own
 * delete and what guards it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { participantsFromJson, updateEvalCase } from '@/lib/evals/create-case'
import { getCase } from '@/lib/evals/queries'
import { UpdateCaseSchema } from '../../schemas'
import { parseBody } from '../../parse-body'
import { collectTrialCaptureIds, deleteEvalCaptures } from '../../delete-captures'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const caseRow = await getCase(supabase, id)
  // `getCase` takes no workspace (a trial resolves a case by id under the
  // service client), so the route checks it here — a case from another
  // workspace is a 404, exactly as an unknown id is.
  if (!caseRow || caseRow.workspace_id !== workspaceId) return notFound('Case not found')

  // On the caller's own client: the template capture is `visibility: 'private'`
  // under its author, so a member who cannot read it simply gets no list rather
  // than a failed case load.
  const [{ data: capture, error: captureError }, { data: selfRow }] = await Promise.all([
    supabase
      .from('captures')
      .select('participants')
      .eq('id', caseRow.capture_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle(),
    // The jsonb carries no `is_self`, only the 'organizer' role the self entry
    // happens to get. The self `capture_participant` row is the authoritative
    // one, and the editor needs the flag: it sends the FULL list back on save.
    supabase
      .from('capture_participant')
      .select('speaker_label')
      .eq('capture_id', caseRow.capture_id)
      .eq('is_self', true)
      .limit(1)
      .maybeSingle(),
  ])
  if (captureError) {
    console.error('[evals] case participants read failed:', captureError.message)
  }
  const participants = participantsFromJson(
    (capture as { participants?: unknown } | null)?.participants,
    (selfRow as { speaker_label?: string | null } | null)?.speaker_label?.trim() || null,
  )

  return NextResponse.json({ case: caseRow, participants })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  // Read on the CALLER's client first: this is what enforces both membership
  // and the case's own `visibility` (a private case is creator-only under
  // migration 252's select policy). The service write below inherits that
  // decision rather than making its own.
  const existing = await getCase(supabase, id)
  if (!existing || existing.workspace_id !== workspaceId) return notFound('Case not found')

  const parsed = await parseBody(request, UpdateCaseSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  try {
    const caseRow = await updateEvalCase(getServiceClient(), {
      caseId: id,
      workspaceId,
      name: body.name,
      script: body.script,
      expected: body.expected,
      participants: body.participants,
      polarity: body.polarity,
      modes: body.modes,
    })
    return NextResponse.json({ case: caseRow })
  } catch (err) {
    console.error('[evals] update case failed:', err)
    return serverError()
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const existing = await getCase(supabase, id)
  if (!existing || existing.workspace_id !== workspaceId) return notFound('Case not found')

  const service = getServiceClient()
  // Before the delete: `eval_trial` cascades from the case, and its rows are
  // the only record of the per-trial clone captures.
  const trialCaptureIds = await collectTrialCaptureIds(service, workspaceId, [id])

  const { error } = await supabase
    .from('eval_case')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) {
    console.error('[evals] delete case failed:', error.message)
    return serverError()
  }

  await deleteEvalCaptures(service, workspaceId, [existing.capture_id, ...trialCaptureIds])

  return NextResponse.json({ deleted: true, id })
}
