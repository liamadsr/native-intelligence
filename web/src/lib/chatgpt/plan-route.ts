/**
 * Where a person's AI runs, for an AI path that can run on their own ChatGPT
 * plan (the free tier, docs/plans/chatgpt-free-tier.md): the usage check with
 * the plan opt-in (check_ai_usage_limit(user, true), migration 409), read as
 * "on their plan" or not. A path that runs a model passes the answer on (e.g.
 * runUtilityTask's `chatgptPlan`), so a free user's call runs on their plan
 * and never on Native Intelligence's models.
 *
 * Background jobs use guardBackgroundUsageOnPlan (src/lib/inngest/usage-guard.ts).
 */
import { checkUsageLimits } from '@/lib/ai/auth'
import { getServiceClient } from '@/lib/supabase/service'
import { isChatGptPlanUsage } from './plan-models'

/**
 * checkUsageLimits with the plan opt-in, for a path that already checked
 * usage: it throws exactly as checkUsageLimits does for everyone it refuses,
 * and resolves to whether this person runs on their plan.
 */
export async function usageOnPlan(userId: string, signal?: AbortSignal): Promise<boolean> {
  return isChatGptPlanUsage(await checkUsageLimits(userId, signal, { chatgptPlan: true }))
}

/**
 * For a path with no usage check of its own: whether this person runs on
 * their plan. It refuses no one, so everyone else's path runs as it always
 * has. An unreadable answer (an RPC error, no person) reads as no plan:
 * logged, and the path then runs as before. `attempts`: how many times to
 * read before that (a caller whose answer lasts, like a local agent's token).
 * `failClosed`: throw instead, for a gate whose only job is keeping a free
 * user off Native Intelligence's models (evals' graders).
 */
export async function chatgptPlanFor(
  userId: string | null | undefined,
  opts: { attempts?: number; failClosed?: boolean } = {},
): Promise<boolean> {
  if (!userId) return false
  const attempts = Math.max(1, opts.attempts ?? 1)
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await getServiceClient().rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
    if (!error) return isChatGptPlanUsage(Array.isArray(data) ? data[0] : data)
    if (attempt >= attempts) {
      if (opts.failClosed) throw new Error(`ChatGPT plan check failed: ${error.message}`)
      console.error('[chatgpt-plan] plan check failed (running as before):', error.message)
      return false
    }
  }
}
