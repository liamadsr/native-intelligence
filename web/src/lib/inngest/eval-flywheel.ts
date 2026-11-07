import { inngest } from './client'
import { getServiceClient } from '@/lib/supabase/service'
import { purgeCandidates, sweepChatFailures, sweepFailedJobs, type StageCounts } from '@/lib/evals/flywheel/sweep'

/**
 * Every 30 minutes: the evals flywheel's sweep (docs/plans/always-on-agent.md
 * §8; src/lib/evals/flywheel/sweep.ts). Chat turns that hit REPEATED_FAILURE
 * or INPUT_INVALID and background jobs that failed become `eval_candidate`
 * rows; old dismissed and unreviewed rows go. One step per stage, so a retry
 * repeats only the stage that failed (each is idempotent on its dedupe keys
 * anyway). No model call, no notification. One `[eval-flywheel]` line per
 * pass, counts only.
 */
export const evalFlywheelSweep = inngest.createFunction(
  {
    id: 'eval-flywheel-sweep',
    retries: 1,
    // Never two passes at once: a slow pass makes the next tick skip, not pile up.
    singleton: { mode: 'skip' },
    triggers: [{ cron: '*/30 * * * *' }],
  },
  async ({ step }) => {
    const chat = (await step.run('chat-failures', () => sweepChatFailures(getServiceClient()))) as StageCounts
    const loops = (await step.run('failed-jobs', () => sweepFailedJobs(getServiceClient()))) as StageCounts
    const purged = await step.run('purge', () => purgeCandidates(getServiceClient()))
    console.info(sweepLogLine(chat, loops, purged))
    return { status: 'done', chat, loops, purged }
  },
)

/** The pass's one log line: counts only. */
export function sweepLogLine(chat: StageCounts, loops: StageCounts, purged: { dismissed: number; stale: number }): string {
  const stage = (c: StageCounts) => `scanned=${c.scanned} found=${c.found} new=${c.inserted} known=${c.known} passed=${c.passed} failed=${c.failed}`
  return `[eval-flywheel] chat ${stage(chat)} | loops ${stage(loops)} | purged dismissed=${purged.dismissed} stale=${purged.stale}`
}
