/**
 * The time offers' sweep (src/lib/time-offers/sweep.ts), every 5 minutes:
 * offers past their expiry let their held times go, and a booking left
 * between its claim and its calendar event is finished or, after its tries,
 * failed and its host told. The only polling time offers do.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { sweepTimeOffers } from '@/lib/time-offers/sweep'

export const timeOffersSweep = inngest.createFunction(
  {
    id: 'time-offers-sweep',
    retries: 1,
    // Never two sweeps at once: a slow sweep makes the next tick skip, not pile up.
    singleton: { mode: 'skip' },
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => step.run('sweep', () => sweepTimeOffers(getServiceClient())),
)
