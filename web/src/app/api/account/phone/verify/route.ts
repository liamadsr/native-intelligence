import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, rateLimited, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { verifyPhoneCode } from '@/lib/sms/phone-verification'
import { maskPhone } from '@/lib/twilio/phone'

/**
 * POST /api/account/phone/verify  { code }
 *
 * Checks the 6-digit code POST /api/account/phone texted and links the number
 * to the caller (src/lib/sms/phone-verification.ts). The first link of a
 * number texts a welcome that says it's an AI agent and how to STOP.
 */
export async function POST(req: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let body: { code?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const result = await verifyPhoneCode(getServiceClient(), { userId: user.id, code: body.code })
  if (result.ok) return Response.json({ phone: result.phone, masked: maskPhone(result.phone), welcomed: result.welcomed })
  switch (result.reason) {
    case 'invalid_code':
      return badRequest("That code doesn't match. Check the text and try again.")
    case 'no_pending':
    case 'expired':
      return apiError('That code expired. Send a new one.', { status: 410, code: 'CODE_EXPIRED' })
    case 'too_many_attempts':
      return rateLimited('Too many tries. Send a new code.')
    case 'not_configured':
      return apiError('Texting is not set up on this Dial8 yet.', { status: 503, code: 'SMS_NOT_CONFIGURED' })
    default:
      return serverError('Could not verify the code')
  }
}
