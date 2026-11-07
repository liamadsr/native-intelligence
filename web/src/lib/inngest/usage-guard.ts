import type { SupabaseClient } from '@supabase/supabase-js'
import { NonRetriableError } from 'inngest'
import { getServiceClient } from '@/lib/supabase/service'
import { isChatGptPlanUsage } from '@/lib/chatgpt/plan-models'

/**
 * Usage gate for background (Inngest) AI jobs (P1-4).
 *
 * Unlike the request-path `checkUsageLimits` (which throws a 429 Response),
 * background jobs need a non-Response signal. This calls the same
 * check_ai_usage_limit RPC and throws a NonRetriableError when the user is over
 * their limit — so Inngest fails the run immediately instead of burning retries
 * on work that will always be blocked.
 *
 * Fails OPEN on RPC/infra error (returns without throwing): a background job is
 * lower-stakes than a live request, and Inngest already retries transient
 * failures. The request-path gate is the authoritative fail-closed guard.
 */
export async function guardBackgroundUsage(userId: string | null | undefined): Promise<void> {
  if (!userId) return // unattributed system jobs (e.g. weaver) — see caller notes
  const supabase = getServiceClient()
  const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId })
  if (error) {
    console.error('[usage-guard] check_ai_usage_limit failed (allowing):', error.message)
    return
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row && row.allowed === false) {
    throw new NonRetriableError(
      `Usage limit reached for user ${userId} (${row.reason ?? 'blocked'}); skipping background AI job.`,
    )
  }
}

/**
 * guardBackgroundUsage for a job whose model work can run on the person's own
 * ChatGPT plan (the free tier, src/lib/chatgpt/plan-route.ts): the same gate
 * with the plan opt-in (check_ai_usage_limit(user, true), migration 409),
 * resolving to whether the person runs on their plan. The job passes that on
 * (runUtilityTask's `chatgptPlan`), so a free user's job runs on their plan;
 * everyone else is gated exactly as by guardBackgroundUsage, with the same
 * fail-open posture (an RPC error or no person reads as no plan).
 */
export async function guardBackgroundUsageOnPlan(userId: string | null | undefined): Promise<{ chatgptPlan: boolean }> {
  if (!userId) return { chatgptPlan: false }
  const supabase = getServiceClient()
  const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
  if (error) {
    console.error('[usage-guard] check_ai_usage_limit failed (allowing):', error.message)
    return { chatgptPlan: false }
  }
  const row = Array.isArray(data) ? data[0] : data
  if (row && row.allowed === false) {
    throw new NonRetriableError(
      `Usage limit reached for user ${userId} (${row.reason ?? 'blocked'}); skipping background AI job.`,
    )
  }
  return { chatgptPlan: isChatGptPlanUsage(row) }
}

/**
 * The same gate as a boolean, for a caller deciding whether to ENQUEUE AI work
 * at all (the triage reconciler: a fire for a user without a subscription only
 * fails `subscription_required` downstream and sends a `work_failed` notice).
 * Reads the same check_ai_usage_limit row run-skill's gate reads, with the same
 * posture: blocked only on an explicit `allowed: false`; an RPC error or an
 * empty row fails OPEN (the downstream gate still runs). Opted in to the
 * ChatGPT free tier as run-skill's gate is: a person on their own plan is
 * allowed, and their run goes on the plan there.
 */
export async function isUsageAllowed(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
  if (error) {
    console.error('[usage-guard] check_ai_usage_limit failed (allowing):', error.message)
    return true
  }
  const row = Array.isArray(data) ? data[0] : data
  return !(row && (row as { allowed?: boolean }).allowed === false)
}
