import { requireUser, requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, rateLimited, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { startPhoneVerification } from '@/lib/sms/phone-verification'
import { twilioConfig, twilioPhoneNumber } from '@/lib/twilio/config'
import { agentNumbersAvailable } from '@/lib/sms/agent-number'
import { maskPhone } from '@/lib/twilio/phone'

/**
 * The person's linked phone (Settings → Phone; docs/plans/text-and-calling.md).
 *
 * GET    → { phone: { number, masked, verifiedAt, optedOut, alertsOn, workspaceId } | null,
 *            dial8Number, agentNumber, canGetNumber, available }: their own
 *            rows, read under RLS. `dial8Number` is the number they text: their
 *            agent's own (`agentNumber`, POST /api/account/agent-number) when it
 *            has one, else the Native Intelligence one. `canGetNumber`: it has none and this
 *            Native Intelligence has a pool to give one from (src/lib/sms/agent-number.ts).
 * POST   { phone, consent: true, consentVersion } → texts a 6-digit code to
 *            the number (E.164, or a US/Canada number without +1) in the
 *            current workspace; 400 without the SMS consent ticked on the
 *            current words (src/lib/sms/consent.ts), 429 when asked too often.
 *            Verify with POST /api/account/phone/verify.
 *            There is no switch for the texts Native Intelligence starts while they are
 *            away: a linked phone gets them, and STOP turns them off (Liam,
 *            2026-10-31: "I don't want this to be a setting").
 * DELETE → unlinks the number (their own row, under RLS) and voids any
 *            pending code. Texts from it then get the "link this number" reply.
 */

export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { data, error } = await supabase
    .from('user_phone')
    .select('phone_e164, verified_at, opted_out_at, alerts_consented_at, alerts_consent_version, workspace_id')
    .eq('user_id', user.id)
    .not('verified_at', 'is', null)
    .maybeSingle<{ phone_e164: string; verified_at: string; opted_out_at: string | null; alerts_consented_at: string | null; alerts_consent_version: string | null; workspace_id: string }>()
  if (error) return serverError(error.message)
  // Before migration 465, or on a failed read: no number of its own, and no button for one.
  const own = await supabase.from('agent_phone_number').select('phone_e164').eq('user_id', user.id).maybeSingle<{ phone_e164: string }>()
  const agentNumber = own.error ? null : (own.data?.phone_e164 ?? null)
  return Response.json({
    phone: data
      ? {
          number: data.phone_e164,
          masked: maskPhone(data.phone_e164),
          verifiedAt: data.verified_at,
          optedOut: data.opted_out_at !== null,
          alertsOn: data.alerts_consented_at !== null,
          workspaceId: data.workspace_id,
        }
      : null,
    dial8Number: agentNumber ?? twilioPhoneNumber(),
    agentNumber,
    canGetNumber: !own.error && !agentNumber && agentNumbersAvailable(),
    available: twilioConfig() !== null,
  })
}

export async function POST(req: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let body: { phone?: unknown; consent?: unknown; consentVersion?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const result = await startPhoneVerification(getServiceClient(), {
    userId: user.id,
    workspaceId,
    phone: body.phone,
    consent: body.consent,
    consentVersion: body.consentVersion,
  })
  if (result.ok) return Response.json({ phone: result.phone, masked: maskPhone(result.phone), expiresAt: result.expiresAt })
  switch (result.reason) {
    case 'invalid_phone':
      return badRequest('Enter a mobile number with its country code, like +1 555 123 4567.')
    case 'unsupported_country':
      return badRequest('Native Intelligence can text US and Canadian mobile numbers only for now.')
    case 'no_consent':
      return badRequest('Agree to receive text messages from Native Intelligence first.')
    case 'rate_limited':
      return rateLimited('Too many codes. Wait a few minutes and try again.')
    case 'unsubscribed':
      return apiError('This number opted out of Native Intelligence texts. Text START to the Native Intelligence number first, then try again.', { status: 409, code: 'PHONE_OPTED_OUT' })
    case 'not_configured':
      return apiError('Texting is not set up here yet.', { status: 503, code: 'SMS_NOT_CONFIGURED' })
    case 'send_failed':
      return apiError("We couldn't text that number. Check it and try again.", { status: 502, code: 'SMS_SEND_FAILED' })
    default:
      return serverError('Could not start verification')
  }
}

export async function DELETE() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { error } = await supabase.from('user_phone').delete().eq('user_id', user.id)
  if (error) return serverError(error.message)
  // Pending codes are service-only (no client policy): void them on the service client.
  await getServiceClient()
    .from('phone_verification')
    .update({ consumed_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .is('consumed_at', null)
  return Response.json({ ok: true })
}
