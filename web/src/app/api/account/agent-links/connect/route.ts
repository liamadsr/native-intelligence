import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isGuestPresetId } from '@/lib/guests/presets'
import { listLinks } from '@/lib/agent-links/store'
import { linkRefusal } from '@/lib/agent-links/refusals'
import { createConnectLink } from '@/lib/agent-links/outside'

/**
 * POST /api/account/agent-links/connect
 *   { displayName, preset: 'household' | 'colleague', tools?, askTools?, askBefore?, notes? }
 *   → 201 { link: LinkView, url }
 *
 * A connect link (agent links phase E, decision 3): the requester sends `url`
 * themselves, and whoever opens it first (signing up if they need to) gets
 * the request. Shown this once; it works for 7 days. The half is the
 * requester's, as with any request: what THEIR agent may ask this user's.
 */
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined)

export async function POST(req: Request) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isGuestPresetId(body.preset)) return badRequest('Pick Household or Colleague.')
  for (const key of ['tools', 'askTools', 'askBefore'] as const) {
    if (body[key] !== undefined && !Array.isArray(body[key])) return badRequest(`${key} must be a list`)
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') return badRequest('notes must be text')

  const supabase = getServiceClient()
  const result = await createConnectLink(supabase, {
    requesterUserId: user.id,
    workspaceId,
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
    preset: body.preset,
    tools: strings(body.tools),
    askTools: strings(body.askTools),
    askBefore: strings(body.askBefore),
    notes: body.notes as string | null | undefined,
  })
  if (!result.ok) {
    if (result.reason === 'no_key' || result.reason === 'daily_cap') return serverError('Couldn’t make a link. Try again.')
    return linkRefusal(result.reason)
  }
  try {
    const view = (await listLinks(supabase, user.id, workspaceId)).find((l) => l.id === result.link.id)
    return Response.json({ link: view ?? null, url: result.url }, { status: 201 })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Made, but could not read it back')
  }
}
