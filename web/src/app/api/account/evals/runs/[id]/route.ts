/**
 * /api/account/evals/runs/[id] — one run with its trials and their checks.
 *
 * This is the POLL endpoint. The replay and run-detail screens hit it from a
 * 3s self-re-arming `setTimeout` gated on the run's server-authored `is_live`,
 * the prospecting `use-run-poll` contract (spec §8.3). Progress lives durably
 * in `eval_run.progress` and is never streamed, so a reload mid-run rehydrates
 * exactly and a run that finished with the tab closed shows its full result.
 *
 * Trials come back WITHOUT their traces (`TRIAL_LIST_FIELDS`): a twenty-case
 * run's traces together are megabytes, and this endpoint is polled every three
 * seconds. A trace loads when a trial row is opened.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { getRunDetail } from '@/lib/evals/queries'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const detail = await getRunDetail(supabase, id)
  // `getRunDetail` resolves by id alone (the Inngest lane reads it under the
  // service client), so the workspace check lives here. A run from another
  // workspace is a 404, exactly as an unknown id is.
  if (!detail || detail.run.workspace_id !== workspaceId) return notFound('Run not found')

  return NextResponse.json({ run: detail.run, trials: detail.trials })
}
