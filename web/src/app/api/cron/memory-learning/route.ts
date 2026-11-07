import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { inngest } from '@/lib/inngest/client'
import { CATCHUP_MAX_SESSIONS, runCaptureCatchup, type CatchupSummary } from '@/lib/memory/capture-catchup'
import { runMemoryLearningPass, type PassSummary } from '@/lib/packs/memory-learning'

export const maxDuration = 300

/**
 * GET /api/cron/memory-learning: the nightly memory cron. Learning is on by
 * default (Liam, 2026-10-17), so it runs two passes side by side:
 *
 *   - the Mail tone pass (src/lib/packs/memory-learning.ts), for every active
 *     member with a connected mailbox, no opt-in: it reads their recent sent
 *     mail live from Gmail or Graph, keeps no copy of it, and saves only the
 *     tone lines it learned. Bounded by its own caps (people and utility
 *     calls per run) and MAIL_PASS_DEADLINE_MS, so the run ends inside
 *     maxDuration even when the last person's call is slow;
 *   - the capture pass's catch-up (always-on plan §3b, A2c;
 *     src/lib/memory/capture-catchup.ts): main-chat conversations with new
 *     talk since their last capture that never compacted get the same queued
 *     capture job compaction would have sent, at most CATCHUP_MAX_SESSIONS per
 *     run. It only queues (the model calls run in Inngest).
 *
 * One pass failing never fails the other, and the answer is counts only:
 * never what was said or written.
 *
 * Vercel cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
/** The catch-up only queues, but up to CATCHUP_MAX_SESSIONS of them. */
const CATCHUP_DEADLINE_MS = 90_000
/**
 * The Mail tone pass starts no new person after this. A person's live reads
 * and one utility call (60s timeout) fit in the time left before maxDuration.
 */
const MAIL_PASS_DEADLINE_MS = 180_000

function catchupCounts(summary: CatchupSummary | null) {
  return summary ? { candidates: summary.candidates, considered: summary.considered, queued: summary.queued, stoppedBy: summary.stoppedBy } : { failed: true }
}

function mailCounts(summary: PassSummary | null) {
  return summary
    ? { candidates: summary.candidates, considered: summary.considered, calls: summary.calls, learned: summary.learned, stoppedBy: summary.stoppedBy }
    : { failed: true }
}

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()
  const [mail, catchup] = await Promise.all([
    runMemoryLearningPass(supabase, { deadlineMs: MAIL_PASS_DEADLINE_MS }).catch((err: unknown) => {
      console.error('[memory-learning cron] mail tone pass failed:', err instanceof Error ? err.message : String(err))
      return null
    }),
    runCaptureCatchup(supabase, (event) => inngest.send(event), {
      maxSessions: CATCHUP_MAX_SESSIONS,
      deadlineMs: CATCHUP_DEADLINE_MS,
    }).catch((err: unknown) => {
      console.error('[memory-learning cron] capture catch-up failed:', err instanceof Error ? err.message : String(err))
      return null
    }),
  ])
  return NextResponse.json({ ok: true, mailPass: mailCounts(mail), captureCatchup: catchupCounts(catchup) })
}
