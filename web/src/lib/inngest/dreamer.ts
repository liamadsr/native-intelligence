/**
 * The Dreamer's runs (docs/plans/dreamer.md; src/lib/dreamer/run.ts),
 * requested by the hourly member scan (./agent-events.ts agentEventDigest)
 * at 03:00 (the nightly reflection), 07:00, 11:00, 15:00 and 19:00 local.
 *
 * dreamerRun, one per person and slot (Inngest id
 * `dreamer:<user>:<workspace>:<local date>:<hour>`), one at a time per
 * person and five overall (the plan's limit). One step: the gates (home
 * thread, the kill switch, a dormant workspace, the usage limits) and the
 * start through startServerHelper (kind 'dreamer', whose admission holds one
 * working per person and six a UTC day). Its output is the outcome and the
 * run id only. The run itself is a work run (src/lib/inngest/work-run-functions.ts);
 * it reports only to the main agent (notify_parent), never to the person.
 */
import { getServiceClient } from '@/lib/admin'
import { checkUsageLimits } from '@/lib/ai/auth'
import { startServerHelper } from '@/lib/chat/start-helper'
import { readAgentPausedState } from '@/lib/work/agent-paused'
import { DREAMER_REQUESTED_EVENT, dreamerLogLine, parseDreamerRequest, runDreamerFor, type DreamerRunDeps } from '@/lib/dreamer/run'
import { inngest } from './client'
import { workspaceDormancy } from './flow-functions'

/** The live gates and start (each a seam in runDreamerFor). */
export function defaultDreamerDeps(): DreamerRunDeps {
  return {
    pausedState: readAgentPausedState,
    // Fails CLOSED (runDreamerFor): a dormancy that can't be read throws, and the run skips.
    isDormant: async (supabase, workspaceId) => {
      const state = await workspaceDormancy(supabase as Parameters<typeof workspaceDormancy>[0], workspaceId)
      if (state === 'unknown') throw new Error('dormancy could not be read')
      return state === 'dormant'
    },
    // Opted in to the ChatGPT free tier: a person on their own plan passes, as a home turn's check does.
    checkUsage: (userId, workspaceId) => checkUsageLimits(userId, undefined, { chatgptPlan: true, workspaceId }),
    startHelper: startServerHelper,
  }
}

export const dreamerRun = inngest.createFunction(
  {
    id: 'dreamer-run',
    retries: 1,
    // One at a time per person; the plan's limit (5) overall.
    concurrency: [{ limit: 1, key: 'event.data.userId' }, { limit: 5 }],
    triggers: [{ event: DREAMER_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseDreamerRequest(event.data)
    if (!data) {
      console.info(dreamerLogLine(null, { status: 'skipped', reason: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }
    const result = await step.run('start', () => runDreamerFor(getServiceClient(), data, defaultDreamerDeps()))
    console.info(dreamerLogLine(data, result))
    return result
  },
)
