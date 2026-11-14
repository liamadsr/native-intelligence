import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import {
  AGE_OUT_DAYS,
  AGE_OUT_BATCH,
  discoverAgeOutWorkspaces,
  sweepWorkspaces,
} from '@/lib/flows/proposal-create-age-out'

export const maxDuration = 60

/**
 * GET /api/cron/proposal-age-out — WS-4d, the deterministic queue floor. The
 * only mechanism that actually makes "pending trends DOWN" true (F7).
 *
 * ON BY DEFAULT (Liam, 2026-10-17: opinionated platform, no configuration
 * fatigue): stale suggestions clear themselves. AGE_OUT_ENABLED is only a kill
 * switch: exactly 'false' makes the route a no-op. It only ever dismisses
 * create proposals; anything that reacts to a dismissal (a trigger settling the
 * proposal's For You card) reacts to these the same way. Two modes:
 *
 * - **Cron (no `workspace` param)**: discover every workspace holding stale
 *   CREATE proposals server-side and sweep each, under a SINGLE global 500-cap
 *   per tick (stop mid-list when reached; the next tick resumes since swept rows
 *   leave the eligible set — no cursor). This is what makes the sweep schedulable
 *   across all workspaces from vercel.json.
 * - **Explicit (`workspace=id,id`)**: the supervised/manual path — sweep exactly
 *   those ids, each with its own AGE_OUT_BATCH cap (unchanged v1 behavior).
 *
 * The server's cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  if (process.env.AGE_OUT_ENABLED === 'false') {
    return NextResponse.json({ ok: true, skipped: 'AGE_OUT_ENABLED is false' })
  }

  const supabase = getServiceClient()
  const cutoffIso = new Date(Date.now() - AGE_OUT_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const wsParam = request.nextUrl.searchParams.get('workspace')
  const explicitIds = (wsParam ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Explicit mode (supervised/manual): sweep exactly the named workspaces, each
  // capped independently at AGE_OUT_BATCH. Passing budget = ids.length * cap
  // means no cross-workspace budget is shared, so each gets its own full 500 —
  // identical to v1 (sweepWorkspaces caps each per-workspace sweep at the min of
  // remaining and AGE_OUT_BATCH; with this budget the min is always the cap).
  if (explicitIds.length > 0) {
    const results = await sweepWorkspaces(supabase, {
      workspaceIds: explicitIds,
      cutoffIso,
      budget: explicitIds.length * AGE_OUT_BATCH,
    })
    return NextResponse.json({ ok: true, mode: 'explicit', workspaces: results })
  }

  // Cron mode: discover all workspaces with stale proposals, sweep under ONE
  // global per-tick cap. Scan bound tracks the cap so discovery can't outrun the
  // work a single tick will do.
  const workspaceIds = await discoverAgeOutWorkspaces(supabase, {
    cutoffIso,
    scanLimit: AGE_OUT_BATCH,
  })
  const results = await sweepWorkspaces(supabase, {
    workspaceIds,
    cutoffIso,
    budget: AGE_OUT_BATCH,
  })
  return NextResponse.json({ ok: true, mode: 'all', workspaces: results })
}
