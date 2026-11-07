import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import {
  HOME_ASKS_BATCH_MAX,
  HOME_ASKS_BATCH_TIMEOUT,
  HOME_ASKS_REQUESTED_EVENT,
  announcePendingAsks,
  mergeHomeAsksRequests,
} from '@/lib/attention/home-asks'

/**
 * A call's outcome in the owner's home thread (P13,
 * src/lib/attention/home-asks.ts): the runs' requests batched per person and
 * workspace, so a burst is one message (each request's `added` kept: a batch
 * hands every event over, where a debounce would keep only the last), and one
 * batch at a time per person, so two never race on the same cards.
 */
export const homeAsks = inngest.createFunction(
  {
    id: 'home-asks',
    retries: 2,
    batchEvents: { maxSize: HOME_ASKS_BATCH_MAX, timeout: HOME_ASKS_BATCH_TIMEOUT, key: 'event.data.workspaceId + ":" + event.data.userId' },
    concurrency: [{ limit: 1, key: 'event.data.userId' }],
    triggers: [{ event: HOME_ASKS_REQUESTED_EVENT }],
  },
  async ({ events, step }) => {
    const request = mergeHomeAsksRequests(events.map((e) => e.data))
    if (!request) return { status: 'skipped', reason: 'bad_event' }
    return step.run('announce', () => announcePendingAsks(getServiceClient(), request))
  },
)
