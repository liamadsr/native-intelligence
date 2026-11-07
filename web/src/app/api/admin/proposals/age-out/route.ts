import { NextResponse, type NextRequest } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { ageOutStaleProposals } from '@/lib/flows/proposal-age-out'

/**
 * POST /api/admin/proposals/age-out — the supervised graveyard drain (E1).
 *
 * The one-time bulk clear of the stale proposal backlog, run by an admin (Liam)
 * with a human present. It targets whichever environment the admin panel is
 * pointed at (getAdminServiceClient honors the admin_env cookie), so a
 * production drain is a deliberate act: select prod in the panel, preview, then
 * execute.
 *
 * FLOW (always preview first):
 *   1. { dryRun: true }  → returns matched counts + per-workspace breakdown,
 *      writes nothing. Look at it.
 *   2. { dryRun: false } → dismisses the matched rows (marker: extra.aged_out).
 *
 * Body:
 *   dryRun?: boolean        default true (never execute unless explicitly false)
 *   olderThanDays?: number  default 30 (the E1 horizon)
 *   workspaceId?: string    optional scope (e.g. just the Corvanne graveyard)
 *   limit?: number          optional safety cap
 *
 * The sweep only ever DISMISSES pending, untouched, non-demo proposals older
 * than the horizon (see proposal-age-out.ts) — it never deletes or touches the
 * board, and it's reversible.
 */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    dryRun?: boolean
    olderThanDays?: number
    workspaceId?: string
    limit?: number
  }

  // Default to a DRY RUN — executing requires an explicit dryRun:false, so a
  // misclick can never dismiss hundreds of rows.
  const dryRun = body.dryRun !== false
  const olderThanDays =
    typeof body.olderThanDays === 'number' && body.olderThanDays > 0 ? body.olderThanDays : 30

  const supabase = await getAdminServiceClient()

  try {
    const result = await ageOutStaleProposals(supabase, {
      dryRun,
      olderThanDays,
      workspaceId: body.workspaceId,
      limit: typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined,
    })
    return NextResponse.json({
      ok: true,
      ...result,
      note: dryRun
        ? 'DRY RUN — nothing was written. Re-run with { "dryRun": false } to execute.'
        : `Dismissed ${result.dismissed} stale proposal(s).`,
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Age-out failed' },
      { status: 500 },
    )
  }
}
