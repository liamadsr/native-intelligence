/**
 * Send later (src/lib/email/scheduled-send.ts): one scheduled message, sent
 * at its time. The event is sent with `ts` = the row's send_at, so Inngest
 * holds it until then. The send takes the row 'scheduled' → 'sending' first
 * (one conditional update), so a second delivery of this event, the 5-minute
 * sweep or Send now reaching the same row sends nothing. No retries: a send
 * that failed is the row's 'failed' and the person's notice, never a second
 * try that could send twice.
 */
import { inngest } from './client'
import { SCHEDULED_SEND_EVENT, sendScheduledEmail } from '@/lib/email/scheduled-send'

export const emailScheduledSend = inngest.createFunction(
  {
    id: 'email-scheduled-send',
    retries: 0,
    // One run per row at a time.
    concurrency: { limit: 1, key: 'event.data.scheduledSendId' },
    triggers: [{ event: SCHEDULED_SEND_EVENT }],
  },
  async ({ event, step }) => {
    const id = (event.data as { scheduledSendId?: unknown } | undefined)?.scheduledSendId
    if (typeof id !== 'string' || !id) return { outcome: 'skipped' as const }
    return { outcome: await step.run('send', () => sendScheduledEmail(id)) }
  },
)
