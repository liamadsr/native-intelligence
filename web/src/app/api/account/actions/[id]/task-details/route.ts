import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import {
  actionExistsInWorkspace,
  lensResponse,
  linkNotFound,
  loadLensLink,
  readTaskDetails,
} from '@/lib/tasks/lens-route'
import { LENS_PROVIDERS, isLensProvider } from '@/lib/tasks/task-lens'

/**
 * GET /api/account/actions/[id]/task-details?provider=jira|asana|linear
 *
 * The property lens's read half: the linked ticket's CURRENT field values, live
 * from the provider, normalized into one shape whichever provider answered.
 *
 * ONE ROUTE, NOT THREE, and the reason is the response shape rather than
 * convenience. Jira, Asana and Linear disagree about nearly every detail of the
 * five fields the panel renders — labels are bare strings / gid-bearing tags /
 * UUID objects; priority is a scheme option / absent / a 0-4 int; "project" is one
 * object / an array membership / an optional refinement. Somebody has to reconcile
 * that, and doing it here means the panel has one fetch and one shape instead of
 * three of each. It is the same division `task-destinations` already drew for
 * "where can this push go": provider-specific collectors, one normalized row.
 *
 * READ-THROUGH, NO CACHE — deliberately. Every value is fetched on lens mount and
 * re-read after a write. The only cached provider read in this codebase shipped a
 * 60s-staleness bug whose fix needed an invalidation call wired into every write
 * funnel; a lens over four fields, three providers, plus the webhook read-back and
 * unlink would need that wiring five times over. Reading live has nothing to
 * invalidate.
 *
 * Coded failures, all of which the panel branches on:
 *   400 `not_connected` / `not_configured` — the workspace never finished setup
 *   400 `reconnect_required` — the stored token is no longer accepted
 *   404 `link_not_found`   — this action has no link for that provider
 *   404 `task_missing`     — RETRYABLE (Jira 404 / Linear null are ambiguous)
 *   404 `task_deleted`     — TERMINAL (an Asana gid that 404s really is gone)
 *   502 `provider_error`   — anything else, including a rate limit
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id: actionId } = await params

  const provider = new URL(request.url).searchParams.get('provider')?.trim()
  if (!isLensProvider(provider)) {
    return badRequest(
      `\`provider\` query param required — one of ${LENS_PROVIDERS.join(', ')}`,
    )
  }

  // The action first, so an id from another workspace answers "action not found"
  // rather than the "not linked" a missing link would produce — see
  // actionExistsInWorkspace for why the distinction is worth one extra query.
  if (!(await actionExistsInWorkspace({ supabase, actionId, workspaceId }))) {
    return notFound('Action not found')
  }

  const link = await loadLensLink({ supabase, actionId, provider, workspaceId })
  if (!link) return linkNotFound(provider)

  return lensResponse(await readTaskDetails({ provider, workspaceId, link }))
}
