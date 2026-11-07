/**
 * The owner's daily list of jobs (roadmap F3, src/lib/customers/daily-jobs.ts):
 *
 *   daily-jobs-pass   hourly: every business whose own zone reads 7 o'clock
 *                     gets one customers/daily-jobs.requested for its local
 *                     date, with the event id `daily-jobs:<workspace>:<date>`
 *                     (Inngest drops a second one with the same id).
 *   daily-jobs-send   one business's list: that day's confirmed bookings, in
 *                     one text to the profile's owner and the same words in
 *                     their home thread. Nothing booked, or the agent paused:
 *                     nothing at all.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import {
  DAILY_JOBS_EVENT,
  buildDailyJobs,
  findDailyJobsBusinesses,
  planDailyJobs,
  textDailyJobs,
  writeDailyJobsHome,
  type DailyJobsBusiness,
} from '@/lib/customers/daily-jobs'

export const dailyJobsPass = inngest.createFunction(
  {
    id: 'daily-jobs-pass',
    retries: 1,
    // Never two passes at once: a slow pass makes the next tick skip, not pile up.
    singleton: { mode: 'skip' },
    triggers: [{ cron: '0 * * * *' }],
  },
  async ({ step }) => {
    const businesses = (await step.run('find-businesses', () => findDailyJobsBusinesses(getServiceClient()))) as DailyJobsBusiness[]
    const requests = planDailyJobs(businesses, Date.now())
    if (requests.length) await step.sendEvent('request-daily-jobs', requests)
    return { businesses: businesses.length, requested: requests.length }
  },
)

export const dailyJobsSend = inngest.createFunction(
  {
    id: 'daily-jobs-send',
    // A retry re-runs only the step that failed: a text already sent is never sent again.
    retries: 1,
    triggers: [{ event: DAILY_JOBS_EVENT }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as { workspaceId?: unknown; localDate?: unknown }
    if (typeof data.workspaceId !== 'string' || typeof data.localDate !== 'string') return { outcome: 'invalid_event' }
    const args = { workspaceId: data.workspaceId, localDate: data.localDate }
    const plan = await step.run('build', () => buildDailyJobs(getServiceClient(), args))
    if (plan.outcome !== 'ready') return { outcome: plan.outcome }
    const home = await step.run('home-thread', () => writeDailyJobsHome(getServiceClient(), { ...args, userId: plan.userId, body: plan.body }))
    const texted = await step.run('text-owner', () => textDailyJobs(getServiceClient(), { workspaceId: args.workspaceId, userId: plan.userId, body: plan.body }))
    return { outcome: 'sent', jobs: plan.jobs, home, texted }
  },
)
