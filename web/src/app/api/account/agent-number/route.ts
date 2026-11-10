import { after } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { getAgentNumber } from '@/lib/sms/agent-number'
import { WELCOME_TEXT } from '@/lib/sms/phone-verification'
import { textPerson } from '@/lib/chat/text-turn-server'

/**
 * POST /api/account/agent-number → { number }: gives the person's agent a
 * phone number of its own (the agent panel's Phone tab; src/lib/sms/agent-number.ts):
 * the one it has, else a spare from Native Intelligence's pool (a replacement is then
 * bought, one purchase at a time across Native Intelligence). After the answer, a phone
 * already linked gets the welcome text from the new number, so it is in their
 * Messages. Read the number back with GET /api/account/phone.
 *
 * 202 { pending: true } when no spare is ready: one is being bought, ask
 * again in a few seconds. 503 where there's no pool (production only), 409
 * at the numbers cap, 502 when Twilio refused.
 */
export async function POST() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user } = auth
  const supabase = getServiceClient()

  const result = await getAgentNumber(supabase, { userId: user.id })
  if (result.ok) {
    if (result.fresh) after(() => textPerson(supabase, { userId: user.id, workspaceId: null, body: WELCOME_TEXT, kind: 'welcome' }))
    return Response.json({ number: result.number.phone })
  }
  if (result.reason === 'none_ready') return Response.json({ pending: true }, { status: 202 })
  console.warn(`[agent-number] not given: ${result.reason}${result.error ? ` (${result.error})` : ''}`)
  switch (result.reason) {
    case 'not_configured':
      return apiError('Texting isn’t set up here yet.', { status: 503, code: 'SMS_NOT_CONFIGURED' })
    case 'limit':
      return apiError('Native Intelligence has no numbers to give right now. Try again later.', { status: 409, code: 'AGENT_NUMBERS_LIMIT' })
    case 'twilio_refused':
      return apiError('We couldn’t get a number just now. Try again in a minute.', { status: 502, code: 'AGENT_NUMBER_FAILED' })
    default:
      return serverError('Could not get a number')
  }
}
