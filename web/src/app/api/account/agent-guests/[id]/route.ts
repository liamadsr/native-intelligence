import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { askToolsWithDefaults, isGuestPresetId, normalizeGuestTools, presetSettings } from '@/lib/guests/presets'
import { getGuest, removeGuest, updateGuest, type GuestPatch } from '@/lib/guests/store'
import { guestRefusal, toGuestView } from '@/lib/guests/people-server'
import { GUEST_CALENDAR_EMAILS_RAW_MAX } from '@/lib/guests/people'

/**
 * One person on the owner's People tab (guest access, PR5).
 *
 * GET    → { guest }: one of the owner's people, removed ones too (a chat
 *          request card reads whether the request is still pending).
 * PATCH { channels?, phone?, preset?: 'household' | 'colleague', tools?, askTools?, askBefore?, displayName?, notes?, calendarEmails? }
 *         → changes a listed person. `preset` resets their tools and asks to
 *           the preset's; `tools`, `askTools` and `askBefore` then set them
 *           (the Tool permissions picks; the store cleans them). `channels`
 *           sets Text and Slack; taking one away forgets its binding, and
 *           Text needs a number (`phone`, for someone added without one).
 *           `calendarEmails` replaces the addresses their calendar invites
 *           come from (up to 5; the store trims, lower-cases and dedupes
 *           them, and refuses one that isn't an address).
 *       → { guest }
 * DELETE → no more access (Remove); what their agent learned about them is
 *          deleted. → { ok: true }
 *
 * A JOIN request is settled by ./approve and ./ignore.
 */

type Params = { params: Promise<{ id: string }> }

const strings = (value: unknown[]): string[] => value.filter((v): v is string => typeof v === 'string')

export async function GET(_req: Request, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  try {
    const guest = await getGuest(getServiceClient(), auth.user.id, id)
    return guest ? Response.json({ guest: toGuestView(guest) }) : guestRefusal('not_found')
  } catch {
    return serverError('Could not read that person')
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth
  const { id } = await params

  let body: {
    channels?: unknown
    phone?: unknown
    preset?: unknown
    tools?: unknown
    askTools?: unknown
    askBefore?: unknown
    displayName?: unknown
    notes?: unknown
    calendarEmails?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const supabase = getServiceClient()

  if (body.preset !== undefined && !isGuestPresetId(body.preset)) return badRequest('Pick Household or Colleague.')
  for (const key of ['channels', 'tools', 'askTools', 'askBefore', 'calendarEmails'] as const) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return badRequest(`${key} must be a list`)
  }
  if (body.displayName !== undefined && typeof body.displayName !== 'string') return badRequest('displayName must be text')
  if (body.phone !== undefined && typeof body.phone !== 'string') return badRequest('phone must be text')
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') return badRequest('notes must be text')
  // An oversized list is refused here, before anything walks it.
  if (Array.isArray(body.calendarEmails) && body.calendarEmails.length > GUEST_CALENDAR_EMAILS_RAW_MAX) return guestRefusal('bad_calendar_emails')

  const patch: GuestPatch = {}
  if (isGuestPresetId(body.preset)) {
    const settings = presetSettings(body.preset)
    patch.tools = settings.tools
    patch.askTools = settings.askTools
    patch.askBefore = settings.askBefore
  }
  if (Array.isArray(body.tools)) patch.tools = strings(body.tools)
  // A preset with tools of the owner's own and no asks: each tool beyond the preset starts on its default.
  if (isGuestPresetId(body.preset) && Array.isArray(body.tools) && !Array.isArray(body.askTools)) {
    const settings = presetSettings(body.preset)
    const tools = normalizeGuestTools(patch.tools)
    patch.askTools = askToolsWithDefaults(settings.askTools, tools.filter((t) => !settings.tools.includes(t)), tools, patch.askBefore ?? settings.askBefore)
  }
  if (Array.isArray(body.askTools)) patch.askTools = strings(body.askTools)
  if (Array.isArray(body.askBefore)) patch.askBefore = strings(body.askBefore)
  if (Array.isArray(body.channels)) patch.channels = strings(body.channels)
  if (typeof body.phone === 'string') patch.phone = body.phone
  if (typeof body.displayName === 'string') patch.displayName = body.displayName
  if (body.notes !== undefined) patch.notes = body.notes as string | null
  // Every entry goes to the store as sent: a non-text one is refused there, never dropped quietly.
  if (Array.isArray(body.calendarEmails)) patch.calendarEmails = body.calendarEmails
  if (Object.keys(patch).length === 0) return badRequest('Nothing to change')

  const result = await updateGuest(supabase, user.id, id, patch)
  return result.ok ? Response.json({ guest: toGuestView(result.guest) }) : guestRefusal(result.reason)
}

export async function DELETE(_req: Request, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth
  const { id } = await params
  const result = await removeGuest(getServiceClient(), user.id, id)
  return result.ok ? Response.json({ ok: true }) : guestRefusal(result.reason)
}
