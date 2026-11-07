import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isGuestPresetId } from '@/lib/guests/presets'
import { acceptLink, listLinks } from '@/lib/agent-links/store'
import { linkRefusal } from '@/lib/agent-links/refusals'

/**
 * POST { preset, tools?, askTools?, askBefore?, notes?, workspaceId? } → { link: LinkView }
 *
 * The person asked says yes, with their half: what the requester's agent may
 * ask theirs. Their agent answers from `workspaceId` (one of theirs; the
 * workspace People is open in when left out). A half they already had for
 * the requester keeps its tools.
 */
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined)

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const { id } = await params

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
  if (body.workspaceId !== undefined && typeof body.workspaceId !== 'string') return badRequest('workspaceId must be text')

  const supabase = getServiceClient()
  const answeringFrom = typeof body.workspaceId === 'string' ? body.workspaceId : workspaceId
  const result = await acceptLink(supabase, {
    linkId: id,
    userId: user.id,
    workspaceId: answeringFrom,
    preset: body.preset,
    tools: strings(body.tools),
    askTools: strings(body.askTools),
    askBefore: strings(body.askBefore),
    notes: typeof body.notes === 'string' ? body.notes : null,
  })
  if (!result.ok) return linkRefusal(result.reason)
  try {
    const view = (await listLinks(supabase, user.id, workspaceId)).find((l) => l.id === id)
    return Response.json({ link: view ?? null })
  } catch (error) {
    return serverError(error instanceof Error ? error.message : 'Accepted, but could not read it back')
  }
}
