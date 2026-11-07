import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { prunePresence } from '@/lib/presence/store'

/**
 * GET /api/cron/notification-purge — daily: old notification rows go
 * (docs/plans/retire-notifications-page.md, "Retention").
 *
 * No list draws notifications any more (the notifications page went); a row
 * is only used for its banner, its bot's notices (the newest 50, plus up to
 * 100 unread) and an agent event's pointer. Nothing ever deleted them, so they
 * piled up forever. `cleanup_old_notifications()` (migration 401) deletes read
 * rows after 30 days and any row after 90, and returns the count. An agent
 * event that pointed at a purged row keeps its own copy of what it says
 * (`agent_event.notification_id` has no foreign key).
 *
 * The same run prunes presence rows no ping has touched in 30 days
 * (user_presence, migration 454: browsers that were cleared or never came
 * back). That prune is housekeeping on its own table, so it runs whatever the
 * notification purge did, and its failure is logged and reported but never
 * fails the run.
 *
 * Schedule: daily via Vercel cron at 03:20 UTC (vercel.json), GET with
 * `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const service = getServiceClient()
  const presencePruned = await prunePresence(service).catch((err: unknown) => {
    console.warn('[notification-purge] presence prune failed:', err instanceof Error ? err.message : err)
    return null
  })
  const { data, error } = await service.rpc('cleanup_old_notifications')
  if (error) {
    console.error('[notification-purge] cleanup failed:', error.message)
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  const deleted = typeof data === 'number' ? data : 0
  console.info(`[notification-purge] deleted=${deleted} presence_pruned=${presencePruned ?? 'failed'}`)
  return NextResponse.json({ ok: true, deleted, presencePruned })
}
