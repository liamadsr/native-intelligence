import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isConnectTokenShape, redeemConnectToken } from '@/lib/agent-links/outside'

/**
 * POST /api/account/agent-links/redeem { token } → { linkId }
 *
 * The signed-in person opened a connect link (/link/<token>, agent links
 * phase E): the waiting request becomes theirs to review and accept on their
 * People tab. Works once. A link sent to an email works only for the account
 * signed in on that email. Refusals carry a code the /link page words:
 * invalid (404), self, wrong_account (403), already_linked (409).
 *
 * requireUser, not requireWorkspaceMember: someone who just signed up may
 * not have a workspace yet, and the request names no workspace of theirs.
 */
export async function POST(req: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let body: { token?: unknown }
  try {
    body = (await req.json()) as { token?: unknown }
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isConnectTokenShape(body.token)) return apiError('This link has expired or was already used', { status: 404, code: 'invalid' })

  const result = await redeemConnectToken(getServiceClient(), { token: body.token, user })
  if (result.ok) return Response.json({ linkId: result.linkId })
  switch (result.reason) {
    case 'invalid':
      return apiError('This link has expired or was already used', { status: 404, code: 'invalid' })
    case 'self':
      return apiError('This is your own connect link', { status: 400, code: 'self' })
    case 'wrong_account':
      return apiError('This request was sent to a different account', { status: 403, code: 'wrong_account' })
    case 'already_linked':
      return apiError('Your agents are already connected or asked', { status: 409, code: 'already_linked' })
    default:
      return serverError('Could not open the request')
  }
}
