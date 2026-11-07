/**
 * The website flow's background steps (roadmap track E,
 * src/lib/website/deploy.ts):
 *
 *   website-pr-opened      a change's pull request opened: wait up to about
 *                          four minutes for the host's preview (a host that
 *                          makes none is skipped after two looks), then raise
 *                          the owner's merge card, preview link and all.
 *   website-change-merged  the owner's yes merged it: once a minute for
 *                          about twenty minutes, the host's production deploy
 *                          and (for the form wiring) the live check; then the
 *                          owner is told, honestly, either way.
 *
 * Each send carries an event id (src/lib/website/events.ts): one preview
 * wait per change and head, one deploy watch per change.
 */
import { getServiceClient } from '@/lib/supabase/service'
import { raiseMergeCard } from '@/lib/website/approval'
import { changePreview, DEPLOY_POLLS, giveUpDeploy, pollDeploy } from '@/lib/website/deploy'
import { WEBSITE_CHANGE_MERGED, WEBSITE_PR_OPENED, type WebsiteEventData } from '@/lib/website/events'
import { inngest } from './client'

/** Looks for a preview before the card goes without one. */
export const PREVIEW_POLLS = 8

export const websitePrOpened = inngest.createFunction(
  {
    id: 'website-pr-opened',
    retries: 2,
    triggers: [{ event: WEBSITE_PR_OPENED }],
  },
  async ({ event, step }) => {
    const data = event.data as WebsiteEventData
    const svc = getServiceClient()
    let previewUrl: string | null = null
    let previewHead: string | null = null
    let none = 0
    for (let i = 0; i < PREVIEW_POLLS; i++) {
      const found = await step.run(`preview-${i}`, () => changePreview(svc, data))
      if (found.state === 'success') {
        previewUrl = found.url
        previewHead = found.head ?? null
        break
      }
      if (found.state === 'failure') break
      // No deployment at all, twice: this host makes no previews.
      if (found.state === 'none' && ++none >= 2) break
      await step.sleep(`wait-preview-${i}`, '30s')
    }
    // The preview counts only for the head it was made for (raiseMergeCard re-reads the head).
    return step.run('merge-card', () => raiseMergeCard(svc, { ...data, previewUrl, previewHead }))
  },
)

export const websiteChangeMerged = inngest.createFunction(
  {
    id: 'website-change-merged',
    retries: 2,
    triggers: [{ event: WEBSITE_CHANGE_MERGED }],
  },
  async ({ event, step }) => {
    const data = event.data as WebsiteEventData
    const svc = getServiceClient()
    for (let poll = 0; poll < DEPLOY_POLLS; poll++) {
      await step.sleep(`wait-${poll}`, poll === 0 ? '45s' : '60s')
      const result = await step.run(`poll-${poll}`, () => pollDeploy(svc, { ...data, poll }))
      if (result.done) return result
    }
    await step.run('give-up', () => giveUpDeploy(svc, data))
    return { done: true, outcome: 'not_seen' }
  },
)
