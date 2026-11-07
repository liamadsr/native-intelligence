import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { conflict, forbidden, rateLimited, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { connectAvailability } from '@/lib/payments/config'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { textSetupLink } from '@/lib/payments/setup'

/**
 * GET  /api/account/payments: the workspace's card payments, as the owner
 *      sees them (roadmap C1): whether Stripe is connected and ready.
 * POST /api/account/payments: text me my Stripe setup link (an owner or admin;
 *      the same single-use link the agent texts).
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const availability = connectAvailability()
  const account = availability.ok ? await getConnectedAccount(getServiceClient(), auth.workspaceId) : null
  return NextResponse.json({
    available: availability.ok,
    connected: !!account && account.status !== 'disconnected',
    status: account?.status ?? null,
    linkedVia: account?.linkedVia ?? null,
    chargesEnabled: account?.chargesEnabled ?? false,
    payoutsEnabled: account?.payoutsEnabled ?? false,
  })
}

export async function POST() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const result = await textSetupLink(getServiceClient(), { workspaceId: auth.workspaceId, userId: auth.user.id })
  if (result.sent) return NextResponse.json({ sent: true, expiresAt: result.expiresAt })
  if (result.reason === 'not_admin') return forbidden('Only a workspace owner or admin can connect Stripe')
  if (result.reason === 'too_soon' || result.reason === 'daily_cap') return rateLimited('A setup link was just sent')
  if (result.reason === 'payments_off') return conflict('Card payments are not available yet', undefined, 'PAYMENTS_OFF')
  if (result.reason === 'no_phone') return NextResponse.json({ sent: false, reason: 'no_phone', url: result.url })
  return serverError('Could not send the setup link')
}
