import { NextResponse, type NextRequest } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import { requireCronSecret } from '@/lib/api-auth'

/**
 * GET /api/cron/reset-ai-usage-plans
 *
 * Zeroes out `ai_user_plans` rows whose `usage_reset_date` has passed.
 *
 * Why a cron: `check_ai_usage_limit` has lazy-reset logic at the top of the
 * function — but that only fires when a user makes an LLM request. Dormant
 * users never trigger it, so the admin dashboard shows stale counters from
 * their last active period. This job runs hourly to keep the table honest.
 *
 * The reset sets the next `usage_reset_date` to the first of next month.
 * Safe to run often — it's idempotent (the WHERE clause filters to expired
 * rows only).
 *
 * Schedule: daily at 00:05 UTC via Vercel cron. Users who actively make
 * requests get lazy-reset within their next call; dormant users get caught
 * by this job within 24h.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data, error } = await supabase.rpc('reset_expired_ai_user_plans')

  if (error) {
    console.error('[reset-ai-usage-plans] RPC failed:', error)
    return NextResponse.json(
      { error: 'Reset failed', detail: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    success: true,
    rows_reset: data ?? 0,
  })
}
