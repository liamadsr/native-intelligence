import { getServiceClient } from '@/lib/supabase/service'
import { AGENT_NUMBERS_BALANCE_EVENT, RECLAIMED_TEXT, balanceSpares, reclaimIdleAgentNumbers } from '@/lib/sms/agent-number'
import { textPerson } from '@/lib/chat/text-turn-server'
import { inngest } from './client'

/**
 * The agent-number pool (src/lib/sms/agent-number.ts). Every purchase and
 * release is {@link agentNumbersBalance}, one run at a time across Native Intelligence, and
 * at most one run every 30 s (a click asking again every 3 s asks once): a
 * run of clicks finds the spares already bought, and a purchase the service
 * keeps refusing costs one number a run, not one a click. Ids and counts only
 * in the logs.
 */
export const agentNumbersBalance = inngest.createFunction(
  {
    id: 'agent-numbers-balance',
    retries: 1,
    concurrency: [{ limit: 1 }],
    rateLimit: { limit: 1, period: '30s' },
    triggers: [{ event: AGENT_NUMBERS_BALANCE_EVENT }],
  },
  async ({ event, step }) => {
    const release = (event.data as { release?: unknown } | undefined)?.release === true
    const pool = await step.run('balance', () => balanceSpares(getServiceClient(), { release }))
    console.info(`[agent-numbers] release=${release} spares=${pool.spares} bought=${pool.bought} released=${pool.released}`)
    return pool
  },
)

/**
 * Daily at 17:00 UTC (9am in California, noon in New York: the campaign
 * sends nothing between 9pm and 8am but urgent texts, and this is not one):
 * take back the numbers nobody has texted in 30 days, tell their people (from
 * the Native Intelligence number: theirs is gone), then balance the pool with release on (a
 * number costs Native Intelligence every month it is held).
 */
export const agentNumbersDaily = inngest.createFunction(
  {
    id: 'agent-numbers-daily',
    retries: 1,
    triggers: [{ cron: '0 17 * * *' }],
  },
  async ({ step }) => {
    const reclaimed = await step.run('reclaim-idle', () => reclaimIdleAgentNumbers(getServiceClient()))
    const told = await step.run('tell-reclaimed', async () => {
      let sent = 0
      for (const userId of reclaimed) {
        const result = await textPerson(getServiceClient(), { userId, workspaceId: null, body: RECLAIMED_TEXT, kind: 'notice' })
        if (result.sent) sent++
      }
      return sent
    })
    await step.sendEvent('balance', { name: AGENT_NUMBERS_BALANCE_EVENT, data: { release: true } })
    console.info(`[agent-numbers] reclaimed=${reclaimed.length} told=${told}`)
    return { reclaimed: reclaimed.length, told }
  },
)
