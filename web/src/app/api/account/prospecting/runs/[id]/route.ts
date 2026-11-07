/**
 * /api/account/prospecting/runs/[id] — one run, with `is_live` derived.
 *
 * This is the POLL endpoint (§9): the UI hits it every 3s from a
 * self-re-arming `setTimeout` gated on `is_live`, the same pattern
 * `cloud-run-view.tsx` and `useEnrichment` use. Progress is durable in
 * `prospecting_run.progress`, never streamed, so a reload mid-run rehydrates
 * exactly and a run that finished with the tab closed shows its full result.
 *
 * `is_live` is computed server-side rather than left to each caller: the
 * status vocabulary diverges from `AgentRunStatus` (no `pr_open`, plus
 * `budget_exhausted`) and a client that hardcoded the live list would poll a
 * budget-exhausted run forever.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getRun } from '@/lib/prospecting/runs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const result = await getRun(supabase, { workspaceId, runId: id })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('Run not found')
    return serverError()
  }
  return NextResponse.json({ run: result.run, is_live: result.run.is_live })
}
