import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'
import { listLinearSyncStates } from '@/lib/tasks/linear-config'

export const maxDuration = 60

/**
 * GET /api/cron/linear-sync
 *
 * Every 30 min, keeps the Linear→Native Intelligence read-back honest. ONE event per connected
 * sync state:
 *
 *   tasks/linear-reconcile — the drift sweep. Linear retries a failed delivery
 *     only three times (+1min / +1h / +6h) and may then disable the webhook
 *     outright with nothing surfacing anywhere, so this poll is the only way a
 *     dropped delivery is ever noticed. Its own 6-hour gate means most ticks are
 *     a single read; firing every tick rather than computing eligibility here
 *     keeps one authority for that rule.
 *
 * DELIBERATELY HALF THE JIRA CRON. The Jira tick also dispatches
 * `tasks/jira-ensure-webhook`, because a dynamic Jira webhook expires 30 days
 * after its last refresh and goes silent — that keepalive is what its cron is
 * really for. Linear's webhooks are APP-level: one URL and one signing secret in
 * the OAuth app console, auto-provisioned by Linear for every organization that
 * authorizes the app. There is no registration we own, no expiry to outrun and
 * nothing to converge, so there is no ensure-webhook function to fire and none
 * is missing.
 *
 * Native Inngest cron triggers are BANNED in this codebase — the mandated
 * pattern is vercel.json cron → inngest.send (see cron/crm-sync/route.ts). This
 * route only dispatches; all the work lives in the function.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  let states: Array<{ id: string; workspaceId: string }>
  try {
    states = await listLinearSyncStates()
  } catch (err) {
    console.error('[linear-sync cron] failed to list sync states:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  let reconciled = 0

  for (const state of states) {
    // Per-state try/catch: a failed send for one workspace must not stop the
    // fleet.
    try {
      await inngest.send({
        name: 'tasks/linear-reconcile',
        data: { syncStateId: state.id },
      })
      reconciled++
    } catch (err) {
      console.error(`[linear-sync cron] reconcile dispatch failed for ${state.id}:`, err)
    }
  }

  return NextResponse.json({
    ok: true,
    sync_states: states.length,
    reconcile_triggered: reconciled,
  })
}
