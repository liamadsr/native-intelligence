import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'
import { listJiraSyncStates } from '@/lib/tasks/jira-config'

export const maxDuration = 60

/**
 * GET /api/cron/jira-sync
 *
 * Every 30 min, keeps the Jira→Dial8 read-back alive. Two events per connected
 * sync state, both idempotent and both cheaply no-op'd by their function's own
 * gate:
 *
 *   tasks/jira-ensure-webhook — convergence AND, uniquely for Jira, KEEPALIVE.
 *     A dynamic webhook expires 30 days after its last create/refresh no matter
 *     how healthy it is, so this is not only a self-heal: without it read-back
 *     goes silent on a schedule. The function refreshes at a 7-day cadence, so a
 *     typical tick is one cheap list call.
 *   tasks/jira-reconcile — the drift sweep. A 3LO app cannot query Atlassian for
 *     failed deliveries (`GET /webhook/failed` is Connect-only), so this poll is
 *     the only way a dropped delivery is ever noticed. Its own 6-hour gate means
 *     most ticks are a single read; firing every tick rather than computing
 *     eligibility here keeps one authority for that rule.
 *
 * Native Inngest cron triggers are BANNED in this codebase — the mandated
 * pattern is vercel.json cron → inngest.send (see cron/crm-sync/route.ts). This
 * route only dispatches; all the work lives in the functions.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  let states: Array<{ id: string; workspaceId: string }>
  try {
    states = await listJiraSyncStates()
  } catch (err) {
    console.error('[jira-sync cron] failed to list sync states:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  let ensured = 0
  let reconciled = 0

  for (const state of states) {
    // Independent try/catch per event: a failed send for one workspace must not
    // stop the fleet, and the two dispatches are unrelated to each other.
    try {
      await inngest.send({
        name: 'tasks/jira-ensure-webhook',
        data: { syncStateId: state.id },
      })
      ensured++
    } catch (err) {
      console.error(`[jira-sync cron] ensure-webhook dispatch failed for ${state.id}:`, err)
    }

    try {
      await inngest.send({
        name: 'tasks/jira-reconcile',
        data: { syncStateId: state.id },
      })
      reconciled++
    } catch (err) {
      console.error(`[jira-sync cron] reconcile dispatch failed for ${state.id}:`, err)
    }
  }

  return NextResponse.json({
    ok: true,
    sync_states: states.length,
    ensure_webhook_triggered: ensured,
    reconcile_triggered: reconciled,
  })
}
