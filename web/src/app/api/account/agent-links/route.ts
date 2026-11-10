import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, rateLimited, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isGuestPresetId } from '@/lib/guests/presets'
import { listLinkCandidates, listLinks, requestLink } from '@/lib/agent-links/store'
import { linkRefusal } from '@/lib/agent-links/refusals'
import { claimEmailRequests, requestLinkByEmail, type OutsideRequestResult } from '@/lib/agent-links/outside'

/**
 * The signed-in user's agent links (migration 435; contracts in project
 * files agent-links/contracts.md): who their agent may talk to, and who asked.
 *
 * GET  → first binds any request sent by email to this user's confirmed
 *        address (claimEmailRequests), then { links: LinkView[] (requested both ways and active, newest first),
 *          candidates: LinkCandidate[] (teammates here not yet linked or asked) }
 * POST { peerUserId? (a teammate here) | email?, displayName, preset: 'household' | 'colleague',
 *        tools?, askTools?, askBefore?, notes?, guestId? }
 *      → 201 { link: LinkView }
 *        Asks them; nothing flows until they accept. By email, one email goes
 *        out with a connect link, and the answer is the same whether or not
 *        the address is on Native Intelligence (decision 3; at most 10 a day). `tools`/`askTools` are
 *        this user's half: what THEIR agent may ask this user's. `guestId`
 *        makes someone already on their list the half, keeping its tools.
 */

const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined)

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const supabase = getServiceClient()
  try {
    await claimEmailRequests(supabase, user)
    const links = await listLinks(supabase, user.id, workspaceId)
    const candidates = await listLinkCandidates(supabase, user.id, workspaceId, links)
    return Response.json({ links, candidates })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Could not read your agent links')
  }
}

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
  const ask = {
    requesterUserId: user.id,
    workspaceId,
    guestId: typeof body.guestId === 'string' ? body.guestId : null,
    displayName: typeof body.displayName === 'string' ? body.displayName : '',
    preset: body.preset,
    tools: strings(body.tools),
    askTools: strings(body.askTools),
    askBefore: strings(body.askBefore),
    notes: body.notes as string | null | undefined,
  }
  const peerUserId = typeof body.peerUserId === 'string' ? body.peerUserId : null
  // Someone outside, by email: the outside phase's path (lookup, connect token, the one email).
  const result: OutsideRequestResult =
    !peerUserId && typeof body.email === 'string'
      ? await requestLinkByEmail(supabase, { ...ask, email: body.email })
      : await requestLink(supabase, { ...ask, peerUserId, email: null })
  if (!result.ok) {
    if (result.reason === 'daily_cap') return rateLimited('You’ve asked 10 people by email today. Try again tomorrow.')
    if (result.reason === 'no_key') return serverError('Couldn’t save that. Try again.')
    return linkRefusal(result.reason)
  }
  try {
    const view = (await listLinks(supabase, user.id, workspaceId)).find((l) => l.id === result.link.id)
    return Response.json({ link: view ?? null }, { status: 201 })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Asked, but could not read it back')
  }
}
