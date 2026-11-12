/**
 * Whether a person's plan pays for search data.
 *
 * Paid search data is bought with our own money, so it is for people on a
 * plan that pays: a subscription, or a trial that is still running. It is
 * NOT for
 *   - a person on their own ChatGPT plan (the free tier): their AI runs on
 *     their plan and costs us nothing, and there is no plan-side stand-in
 *     for search data;
 *   - a person with no plan that pays at all: the default plan after its
 *     trial ended and with no credits (`subscription_required`), or no plan
 *     configured.
 * A person on a paying plan who has used up this month's AI allowance still
 * counts as paying: search data has its own budget (./spend.ts).
 *
 * The answer comes from the usage check every AI path uses
 * (check_ai_usage_limit with the plan opt-in). It THROWS when the check
 * can't be read: the callers refuse rather than buy on an answer they don't
 * have (./access.ts, rank/gate.ts, ai-visibility/gate.ts).
 */
import { getServiceClient } from '@/lib/supabase/service'
import 'server-only'

const NOT_PAYING_REASONS: ReadonlySet<string> = new Set([
  'chatgpt_plan',
  'chatgpt_plan_exhausted',
  'chatgpt_plan_unsupported',
  'subscription_required',
  'no_plan_configured',
])

/** True when this person's plan does not pay for search data. Throws when the plan can't be read. */
export async function onFreePlan(
  userId: string,
  opts: { attempts?: number } = {},
): Promise<boolean> {
  const attempts = Math.max(1, opts.attempts ?? 1)
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await getServiceClient().rpc(
      'check_ai_usage_limit',
      { p_user_id: userId, p_chatgpt_plan: true },
    )
    if (!error) {
      const row = (Array.isArray(data) ? data[0] : data) as
        | { reason?: unknown }
        | null
        | undefined
      // No row is no answer: refuse to guess.
      if (!row) throw new Error('seo plan check returned nothing')
      return typeof row.reason === 'string' && NOT_PAYING_REASONS.has(row.reason)
    }
    if (attempt >= attempts)
      throw new Error(`seo plan check failed: ${error.message}`)
  }
}
