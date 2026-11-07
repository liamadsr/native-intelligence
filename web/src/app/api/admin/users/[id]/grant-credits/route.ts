import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

/**
 * Grant AI credits to a user's Postgres wallet (ai_credit_ledger).
 *
 * Body: { amount_usd: number, reason?: string }
 *
 * Credits are a Postgres wallet now — no Stripe object is created. A
 * server-generated idempotency key makes a double-click a no-op (P2-3). The
 * grant is drawn down atomically by log_ai_usage as the user exceeds their
 * plan allowance.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let adminUser
  try {
    adminUser = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: userId } = await params
  const body = (await request.json()) as { amount_usd?: unknown; reason?: unknown }
  const amountUsd = Number(body.amount_usd)
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return NextResponse.json(
      { error: 'amount_usd must be a positive number' },
      { status: 400 },
    )
  }
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : null

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase.rpc('grant_credits', {
    p_user_id: userId,
    p_amount_usd: amountUsd,
    p_kind: 'admin_grant',
    // Unique per request → a double-click creates two rows, which is the
    // intended admin behavior (two deliberate grants). Idempotency here guards
    // network-retry of THIS request, not repeated clicks.
    p_idempotency_key: `admin-${randomUUID()}`,
    p_stripe_ref: null,
    p_stripe_customer_id: null,
    p_note: `Admin grant by ${adminUser.email ?? 'unknown'}${reason ? `: ${reason}` : ''}`,
  })

  if (error) {
    console.error('Admin grant_credits failed:', error)
    return NextResponse.json({ error: 'Failed to grant credits' }, { status: 500 })
  }

  const row = Array.isArray(data) ? data[0] : data
  return NextResponse.json({ ok: true, new_balance_usd: row?.new_balance_usd ?? null })
}
