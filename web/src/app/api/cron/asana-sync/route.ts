import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'
import { listAsanaSyncStates } from '@/lib/tasks/asana-config'

export const maxDuration = 60

/**
 * GET /api/cron/asana-sync
 *
 * Every 30 min, keeps the Asana→Dial8 read-back honest. Two events per
 * connected sync state, both idempotent and both cheaply no-op'd by their
 * function's own gate:
 *
 *   tasks/asana-ensure-webhook — convergence/self-heal for the registration.
 *     Asana deletes a webhook after 24h of failed deliveries (and when the
 *     watched project is deleted, after a 72h grace), and a create can fail for
 *     reasons that later resolve — so "did we register, and is it still the
 *     right registration?" has to be re-asked on a schedule, not just at the
 *     moment the user picks a project.
 *   tasks/asana-reconcile — the at-most-once safety net. The function's own
 *     6-hour gate means most ticks are a single cheap read; firing it every tick
 *     rather than computing eligibility here keeps one authority for that rule.
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
    states = await listAsanaSyncStates()
  } catch (err) {
    console.error('[asana-sync cron] failed to list sync states:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  let ensured = 0
  let reconciled = 0

  for (const state of states) {
    // Independent try/catch per event: a failed send for one workspace must not
    // stop the fleet, and the two dispatches are unrelated to each other.
    try {
      await inngest.send({
        name: 'tasks/asana-ensure-webhook',
        data: { syncStateId: state.id },
      })
      ensured++
    } catch (err) {
      console.error(`[asana-sync cron] ensure-webhook dispatch failed for ${state.id}:`, err)
    }

    try {
      await inngest.send({
        name: 'tasks/asana-reconcile',
        data: { syncStateId: state.id },
      })
      reconciled++
    } catch (err) {
      console.error(`[asana-sync cron] reconcile dispatch failed for ${state.id}:`, err)
    }
  }

  return NextResponse.json({
    ok: true,
    sync_states: states.length,
    ensure_webhook_triggered: ensured,
    reconcile_triggered: reconciled,
  })
}
