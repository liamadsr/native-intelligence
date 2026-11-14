import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { requireCronSecret } from '@/lib/api-auth'

export const maxDuration = 30

/**
 * GET /api/cron/weave
 *
 * Daily safety-net that kicks the nightly knowledge weaver
 * ([src/lib/inngest/knowledge-weaver.ts]). The weaver also carries its own
 * Inngest cron (`0 9 * * *`), but that schedule only fires if Inngest Cloud has
 * the function REGISTERED — and a newly-added cron-triggered function isn't
 * registered until the app re-syncs on deploy. When that sync silently fails
 * (as it did after the 2026-06-12 deploy), the in-function cron never runs and
 * briefs/weaving stop with no error anywhere.
 *
 * This cron job removes that single point of failure: the server's scheduler
 * is independent of Inngest's app registration, so emitting the manual trigger
 * event here guarantees the weaver runs nightly regardless of sync state. The
 * weaver's `concurrency: [{ limit: 1 }]` serializes any overlap with the
 * in-function cron, so running both triggers is safe and idempotent.
 *
 * The server's cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    await inngest.send({ name: 'knowledge/weave.requested' })
  } catch (err) {
    console.error('[weave cron] failed to emit weave.requested:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'send failed' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true, triggered: 'knowledge/weave.requested' })
}
