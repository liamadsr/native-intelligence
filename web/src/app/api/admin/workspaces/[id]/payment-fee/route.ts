import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { badRequest, notFound, serverError, unauthorized } from '@/lib/api-errors'
import { MAX_FEE_BPS, MAX_FEE_CENTS } from '@/lib/payments/fees'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_ACCOUNT = 'No Stripe account connected for this workspace'

/**
 * GET/PATCH /api/admin/workspaces/[id]/payment-fee (roadmap C2)
 *
 * Dial8's optional platform fee on a workspace's customer payments
 * (stripe_connect_account.application_fee_bps / _cents, migration 459). Both
 * default to 0 and stay 0 until pricing is decided: nothing depends on a fee.
 * Dial8 staff only (requireAdmin); a workspace's own members can't change it.
 * It applies to links made after the change, never to a link already sent.
 *
 * PATCH body: { bps: 0..2000, cents: 0..10000 } (whole numbers).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }
  const { id } = await params
  if (!UUID.test(id)) return badRequest('Invalid workspace id')
  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase.from('stripe_connect_account').select('application_fee_bps, application_fee_cents, status').eq('workspace_id', id).maybeSingle()
  if (error) return serverError('Failed to read the payment fee')
  if (!data) return notFound(NO_ACCOUNT)
  return NextResponse.json({ bps: data.application_fee_bps, cents: data.application_fee_cents, status: data.status })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }
  const { id } = await params
  if (!UUID.test(id)) return badRequest('Invalid workspace id')
  const body = (await request.json().catch(() => ({}))) as { bps?: unknown; cents?: unknown }
  const whole = (value: unknown, max: number) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null)
  const bps = whole(body.bps ?? 0, MAX_FEE_BPS)
  const cents = whole(body.cents ?? 0, MAX_FEE_CENTS)
  if (bps === null || cents === null) {
    return badRequest(`bps must be a whole number 0..${MAX_FEE_BPS} and cents 0..${MAX_FEE_CENTS}`)
  }
  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('stripe_connect_account')
    .update({ application_fee_bps: bps, application_fee_cents: cents, updated_at: new Date().toISOString() })
    .eq('workspace_id', id)
    .select('application_fee_bps, application_fee_cents')
  if (error) return serverError('Failed to set the payment fee')
  if (!data?.length) return notFound(NO_ACCOUNT)
  return NextResponse.json({ bps: data[0].application_fee_bps, cents: data[0].application_fee_cents })
}
