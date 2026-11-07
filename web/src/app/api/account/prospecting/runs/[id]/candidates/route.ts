/**
 * GET /api/account/prospecting/runs/[id]/candidates — the transparency ledger.
 *
 * This is what makes dedup trustworthy (§6). A dedup that silently drops
 * repeats is indistinguishable from a search that found nothing, so EVERY
 * candidate a round saw — new, suppressed and invalid — comes back, grouped by
 * outcome and, within `suppressed`, by the rule that caught it, each carrying a
 * link to the record responsible where one exists.
 *
 * Group order is the exclusion set's own precedence order, so the most
 * actionable reason ("already in this list") reads first.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { listRunCandidates } from '@/lib/prospecting/runs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const result = await listRunCandidates(supabase, { workspaceId, runId: id })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('Run not found')
    return serverError()
  }
  return NextResponse.json({
    run: result.run,
    groups: result.groups,
    total: result.total,
  })
}
