import { requireUser } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { listAnswerWorkspaces } from '@/lib/agent-links/outside'

/**
 * GET /api/account/agent-links/answer-workspaces
 *   → { workspaces: [{ id, name, outsideAllowed }] }
 *
 * The signed-in person's workspaces, any of which could answer a link request
 * (decision 4: one agent on each side, from one workspace). People's Review
 * screen shows a picker when there's more than one; outsideAllowed is the
 * workspace admin's switch, false where an outside link can't answer.
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const workspaces = await listAnswerWorkspaces(getServiceClient(), auth.user.id)
  if (!workspaces) return serverError('Could not read your workspaces')
  return Response.json({ workspaces })
}
