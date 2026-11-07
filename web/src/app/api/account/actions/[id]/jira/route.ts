import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { JIRA_PROVIDER } from '@/lib/tasks/jira-config'
import { pushActionToJira } from '@/lib/tasks/jira-push'
import { parseJiraOverrides, readOverridesBody } from '@/lib/tasks/push-overrides'

/**
 * GET /api/account/actions/[id]/jira — List Jira issues linked to an action.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data: tasks, error } = await supabase
    .from('action_external_task')
    .select('*')
    .eq('action_id', id)
    .eq('provider', JIRA_PROVIDER)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  return NextResponse.json({ tasks })
}

/**
 * POST /api/account/actions/[id]/jira — Push an action to Jira as an issue.
 *
 * The body is OPTIONAL and, when present, is `{ overrides?: {…} }` — the compose
 * panel's one-shot destination for THIS push (see src/lib/tasks/push-overrides).
 * NO BODY IS THE ORIGINAL CONTRACT and still the common one: the destination is
 * then the workspace-level config exactly as before, byte for byte.
 *
 * Malformed overrides are a 400 BEFORE any Jira call, because the alternative is
 * a Jira-side rejection whose message names neither the config nor the panel and
 * that nobody can act on. Coded failures the UI branches on — identical to the
 * Asana route's, which is what lets PushToTrackerMenu stay provider-generic:
 *   409 `already_linked`  — this action already has a Jira issue
 *   400 `not_connected`   — no Jira account connected for the workspace
 *   400 `not_configured`  — connected, but no project/issue type picked yet
 *   400 `reconnect_required` — the stored token is no longer accepted
 *   400 `push_failed`     — Jira refused the create over named fields we cannot
 *                           drop (a required custom field, an issue type that
 *                           isn't valid for the project). Jira-side
 *                           configuration, so the message names the fields; it
 *                           is deliberately NOT in the UI's SETUP_CODES set,
 *                           because "Open settings" would point at the wrong
 *                           product.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: actionId } = await params
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await readOverridesBody(request)
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 })
  const parsed = parseJiraOverrides(body.value)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const result = await pushActionToJira({
      actionId,
      workspaceId,
      userId: user.id,
      supabase,
      // Spread rather than assigned: a bodyless push must call the push with the
      // SAME argument object it always did, with no `overrides: undefined` key
      // appearing out of nowhere.
      ...(parsed.value ? { overrides: parsed.value } : {}),
    })

    if (!result.ok) {
      if (result.code === 'action_not_found') {
        return NextResponse.json({ error: result.error }, { status: 404 })
      }
      if (result.code === 'unauthorized') {
        return NextResponse.json(
          { error: result.error, code: 'reconnect_required' },
          { status: 400 },
        )
      }
      return NextResponse.json(
        { error: result.error, code: result.code },
        { status: 400 },
      )
    }

    // An already-linked action is not an error the user caused twice by
    // accident — return the existing link alongside the 409 so the panel can
    // render the chip it was missing.
    if (!result.created) {
      return NextResponse.json(
        {
          error: 'This action is already linked to a Jira issue',
          code: 'already_linked',
          task: result.link,
        },
        { status: 409 },
      )
    }

    // The degradation flags ride along ONLY when they happened, so an ordinary
    // push answers with exactly the body it always did. They exist because a
    // create that dropped a field the user typed, or an assignee that never
    // landed, is otherwise a success chip over a quietly wrong issue.
    return NextResponse.json(
      {
        task: result.link,
        ...(result.dropped_fields ? { dropped_fields: result.dropped_fields } : {}),
        ...(result.assignee_set === false ? { assignee_set: false } : {}),
      },
      { status: 201 },
    )
  } catch (err) {
    console.error('[jira] push failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to push to Jira' },
      { status: 500 },
    )
  }
}
