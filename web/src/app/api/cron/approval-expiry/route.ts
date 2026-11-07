/**
 * GET /api/cron/approval-expiry — expire held tool calls whose wait is over
 * (always-on safety fixes; src/lib/safety/approvals.ts, migration 335).
 *
 * An approval waits APPROVAL_TTL_MS (24 h) for the person. Before this, a
 * lapsed one was marked expired only when someone acted on its card, so the
 * row and its card stayed 'pending' indefinitely. Reads already skip a card
 * whose expires_at passed; this makes the stored status true, and the card's
 * realtime UPDATE drops it from any rail still showing it.
 *
 * It only flips pending rows past their expiry (and their cards) to 'expired';
 * idempotent, at most 1,000 a run, in batches of 100.
 *
 * It also sweeps parked loop runs (flow-step-resume.ts sweepParkedRuns, F4):
 * a run whose card was answered but never heard is told again, a resume
 * that died mid-way is ended, and finished runs' step outputs older than
 * 7 days are purged.
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { EXPIRE_SWEEP_MAX, expireLapsedApprovals } from '@/lib/safety/approvals'
import { sweepParkedRuns } from '@/lib/flows/flow-step-resume'

/** Sweeps a run at most (EXPIRE_SWEEP_MAX each). */
const SWEEPS = 10

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    // Batches of EXPIRE_SWEEP_MAX (100: short `in` filters), up to SWEEPS a run.
    const supabase = getServiceClient()
    let expired = 0
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      const batch = await expireLapsedApprovals(supabase)
      expired += batch
      if (batch < EXPIRE_SWEEP_MAX) break
    }
    // F4: no loop run stays parked forever (a lost answer is told again, a
    // resume that died is ended) and finished runs' step outputs are purged.
    const parked = await sweepParkedRuns(supabase)
    return NextResponse.json({ ok: true, expired, parked })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
