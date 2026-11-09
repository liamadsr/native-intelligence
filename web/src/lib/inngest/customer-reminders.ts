/**
 * Reminders and confirmations (roadmap issue #11, src/lib/customers/reminders.ts):
 *
 *   customer-reminders-pass   hourly: every business with reminders on and a
 *                             live number, whose own zone reads 10 o'clock,
 *                             gets one customers/reminders.requested for its
 *                             local date, with the event id
 *                             `customer-reminders:<workspace>:<date>` (Inngest
 *                             drops a second one with the same id).
 *   customer-reminders-send   one business's day: tomorrow's booked jobs and
 *                             meetings with customers, each customer texted
 *                             once from the business's number (claimed before
 *                             it goes), and one line to the owner.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { REMINDERS_EVENT, findReminderBusinesses, planReminders, sendDayReminders, type ReminderBusiness } from '@/lib/customers/reminders'

export const customerRemindersPass = inngest.createFunction(
  {
    id: 'customer-reminders-pass',
    retries: 1,
    // Never two passes at once: a slow pass makes the next tick skip, not pile up.
    singleton: { mode: 'skip' },
    triggers: [{ cron: '0 * * * *' }],
  },
  async ({ step }) => {
    const businesses = (await step.run('find-businesses', () => findReminderBusinesses(getServiceClient()))) as ReminderBusiness[]
    const requests = planReminders(businesses, Date.now())
    if (requests.length) await step.sendEvent('request-reminders', requests)
    return { businesses: businesses.length, requested: requests.length }
  },
)

export const customerRemindersSend = inngest.createFunction(
  {
    id: 'customer-reminders-send',
    // A retry re-runs the step: every reminder is claimed before it is texted, so none goes twice.
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }],
    triggers: [{ event: REMINDERS_EVENT }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as { workspaceId?: unknown; localDate?: unknown }
    if (typeof data.workspaceId !== 'string' || typeof data.localDate !== 'string') return { outcome: 'invalid_event' }
    const args = { workspaceId: data.workspaceId, localDate: data.localDate }
    return step.run('send', () => sendDayReminders(getServiceClient(), args))
  },
)
