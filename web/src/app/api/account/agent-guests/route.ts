import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { twilioConfig, twilioPhoneNumber } from '@/lib/twilio/config'
import { isGuestPresetId } from '@/lib/guests/presets'
import { createGuest, listGuests, requestCode } from '@/lib/guests/store'
import { guestRefusal, toGuestView, toInvite } from '@/lib/guests/people-server'

/**
 * The people who may text the owner's agent (guest access, PR5: the agent
 * panel's People tab; migration 427). Every read and write is the owner's own
 * rows, through src/lib/guests/store.ts with the service role, fenced on the
 * signed-in user's id. Nothing here texts anyone: guests always text first.
 *
 * GET  → { guests: GuestView[] (invited, requested and active, newest first),
 *          requests: { code, open } | null, dial8Number, available }
 *        The request code is made (closed) the first time it's read.
 * POST { displayName, channels?: ('sms' | 'slack')[], phone?, preset: 'household' | 'colleague',
 *        tools?: string[], askTools?: string[], askBefore?: string[], notes? }
 *      → 201 { guest, invite: { code, text, dial8Number, expiresAt } }
 *        Adds a person as invited, on Text when `channels` is left out. A
 *        number is needed for Text, optional for Slack only. `tools` and `askTools` (the Tool
 *        permissions picks: held, and of those the ones that ask) replace the
 *        preset's; the store cleans both. The invite code is shown this once.
 */

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined)

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const supabase = getServiceClient()
  try {
    const [guests, requests] = await Promise.all([listGuests(supabase, user.id), requestCode(supabase, user.id, workspaceId)])
    return Response.json({
      guests: guests.map(toGuestView),
      requests,
      dial8Number: twilioPhoneNumber(),
      available: twilioConfig() !== null,
    })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Could not read your people')
  }
}

export async function POST(req: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let body: { displayName?: unknown; phone?: unknown; channels?: unknown; preset?: unknown; tools?: unknown; askTools?: unknown; askBefore?: unknown; notes?: unknown }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isGuestPresetId(body.preset)) return badRequest('Pick Household or Colleague.')
  for (const key of ['channels', 'tools', 'askTools', 'askBefore'] as const) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return badRequest(`${key} must be a list`)
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') return badRequest('notes must be text')

  const result = await createGuest(getServiceClient(), {
    ownerUserId: user.id,
    workspaceId,
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
    phone: typeof body.phone === 'string' ? body.phone : null,
    channels: strings(body.channels),
    preset: body.preset,
    tools: strings(body.tools),
    askTools: strings(body.askTools),
    askBefore: strings(body.askBefore),
    notes: body.notes as string | null | undefined,
  })
  if (!result.ok) return guestRefusal(result.reason)
  return Response.json({ guest: toGuestView(result.guest), invite: toInvite(result.guest, result.inviteCode) }, { status: 201 })
}
