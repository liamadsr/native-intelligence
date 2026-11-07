/**
 * Deterministic pick of "the" subscription row for a user.
 *
 * `subscriptions` has NO unique constraint on user_id — multi-row states are
 * expected: an admin-granted `granted_%` row can coexist with a real Stripe
 * subscription, and canceled rows accumulate next to an active one. (A partial
 * unique index on user_id was considered and rejected: the Stripe webhook
 * upserts on stripe_subscription_id, an upsert can't target two constraints,
 * and that handler swallows errors — a violation would silently drop the
 * subscription.)
 *
 * This helper is the tie-break, mirroring the SQL side (migration 199 /
 * check_ai_usage_limit): qualify rows with status IN ('active','trialing'),
 * prefer the max FUTURE current_period_end (the date the allowance aligns to),
 * then granted rows (NULL period end -> calendar fallback), then the freshest
 * stale end (the 3-day plan-resolution grace window). With no qualifying row
 * at all, fall back to the newest row — the subscription block renders null
 * for those users anyway.
 */

export interface SubscriptionRow {
  status: string
  stripe_subscription_id: string
  stripe_customer_id: string | null
  current_period_start: string | null
  current_period_end: string | null
  cancel_at_period_end: boolean | null
  created_at: string | null
}

function maxBy<T>(rows: T[], score: (row: T) => number): T {
  let best = rows[0]
  let bestScore = score(best)
  for (let i = 1; i < rows.length; i++) {
    const s = score(rows[i])
    if (s > bestScore) {
      best = rows[i]
      bestScore = s
    }
  }
  return best
}

const periodEndMs = (row: SubscriptionRow) =>
  row.current_period_end ? new Date(row.current_period_end).getTime() : 0

const createdAtMs = (row: SubscriptionRow) =>
  row.created_at ? new Date(row.created_at).getTime() : 0

export function pickSubscriptionRow<T extends SubscriptionRow>(
  rows: T[] | null | undefined,
  now: Date = new Date(),
): T | null {
  if (!rows || rows.length === 0) return null

  const qualifying = rows.filter(
    (r) => r.status === 'active' || r.status === 'trialing',
  )
  if (qualifying.length > 0) {
    // Future period end wins — this is what the SQL aligns the allowance to.
    const future = qualifying.filter((r) => periodEndMs(r) > now.getTime())
    if (future.length > 0) return maxBy(future, periodEndMs)
    // Admin-granted rows carry a NULL period end (calendar fallback in SQL).
    const granted = qualifying.filter((r) => r.current_period_end == null)
    if (granted.length > 0) return maxBy(granted, createdAtMs)
    // All ends stale/past: the plan-resolution grace window. Freshest end wins.
    return maxBy(qualifying, periodEndMs)
  }

  // No active/trialing row (canceled-only users): newest row, preserving the
  // pre-helper behavior — hasActiveSubscription is false so the response's
  // subscription block is null regardless.
  return maxBy(rows, createdAtMs)
}
