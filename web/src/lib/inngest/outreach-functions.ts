/**
 * Outreach's background work (roadmap D2/D3):
 *
 *   review-request-on-job   a customer's job is done or paid (the job/completed
 *                           event, for the reasons in REVIEW_REQUEST_REASONS):
 *                           the business's review link goes to them once for
 *                           that job (src/lib/reviews/request.ts). No link set,
 *                           no customer, no address, opted out, asked in the
 *                           last month: nothing sends.
 *   campaign-rolling-pass   Mondays at 09:00 Pacific: each rolling campaign
 *                           that is on gets ONE launch card for the people
 *                           newly matching its audience (src/lib/campaigns/
 *                           launch.ts refreshRollingCampaign), in the home
 *                           thread of whoever last said yes to it; the router
 *                           takes it to them (by text, with its code). It never
 *                           sends: the card does, on their yes. A workspace
 *                           whose agent is paused is skipped.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { JOB_COMPLETED_EVENT, jobRefOf, type JobDoneReason } from '@/lib/jobs/events'
import { sendReviewRequest } from '@/lib/reviews/request'
import { CAMPAIGN_LAUNCH_COLUMNS, refreshRollingCampaign, type CampaignForLaunch } from '@/lib/campaigns/launch'
import { isAgentPaused } from '@/lib/work/agent-paused'
import { fetchAllRows } from '@/lib/supabase/paging'

/** The event a review request follows: a job done (the owner, a booking) or paid (track C's payment link). */
export const REVIEW_REQUEST_TRIGGER = JOB_COMPLETED_EVENT

/**
 * The reasons that ask for a review. Both today, one ask per customer a
 * month (src/lib/reviews/request.ts). To ask only once a job is PAID, take
 * 'done' out.
 */
export const REVIEW_REQUEST_REASONS: ReadonlySet<JobDoneReason> = new Set<JobDoneReason>(['done', 'paid'])

export const reviewRequestOnJob = inngest.createFunction(
  {
    id: 'review-request-on-job',
    // A throw before the claim (a failed read) retries; after the claim a
    // retry finds the row and sends nothing again.
    retries: 2,
    triggers: [{ event: REVIEW_REQUEST_TRIGGER }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as { workspaceId?: unknown; contactId?: unknown; reason?: unknown }
    const jobRef = jobRefOf(data)
    if (typeof data.workspaceId !== 'string' || !jobRef) return { outcome: 'invalid_event' }
    // A job with no customer (a payment link sent to no contact) has nobody to ask.
    if (typeof data.contactId !== 'string' || !data.contactId) return { outcome: 'no_contact' }
    const reason: JobDoneReason = data.reason === 'paid' ? 'paid' : 'done'
    if (!REVIEW_REQUEST_REASONS.has(reason)) return { outcome: 'reason_off', reason }
    const job = { workspaceId: data.workspaceId, contactId: data.contactId, jobRef }
    return step.run('send-review-request', () => sendReviewRequest(getServiceClient(), job))
  },
)

export const campaignRollingPass = inngest.createFunction(
  {
    id: 'campaign-rolling-pass',
    retries: 1,
    singleton: { mode: 'skip' },
    triggers: [{ cron: 'TZ=America/Los_Angeles 0 9 * * 1' }],
  },
  async ({ step }) => {
    const campaigns = (await step.run('find-rolling', async () => {
      const supabase = getServiceClient()
      const { data, error } = await fetchAllRows<CampaignForLaunch>(() =>
        supabase
          .from('campaign')
          .select(CAMPAIGN_LAUNCH_COLUMNS)
          .eq('rolling', true)
          .eq('status', 'active')
          .not('sequence_id', 'is', null)
          .not('launched_by', 'is', null),
      )
      if (error) throw new Error(`rolling campaigns read failed: ${error.message}`)
      return data
    })) as CampaignForLaunch[]
    const outcomes: Record<string, number> = {}
    for (const campaign of campaigns) {
      const result = await step.run(`campaign-${campaign.id}`, async () => {
        const supabase = getServiceClient()
        if (await isAgentPaused(supabase, campaign.workspace_id)) return { outcome: 'paused' }
        return refreshRollingCampaign(supabase, campaign)
      })
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1
    }
    return { campaigns: campaigns.length, outcomes }
  },
)
