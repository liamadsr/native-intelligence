import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { ASANA_PROVIDER } from '@/lib/tasks/asana-config'
import { pushActionToAsana } from '@/lib/tasks/asana-push'
import { parseAsanaOverrides, readOverridesBody } from '@/lib/tasks/push-overrides'

/**
 * GET /api/account/actions/[id]/asana — List Asana tasks linked to an action.
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
    .eq('provider', ASANA_PROVIDER)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  return NextResponse.json({ tasks })
}

/**
 * POST /api/account/actions/[id]/asana — Push an action to Asana as a task.
 *
 * The body is OPTIONAL and, when present, is `{ overrides?: {…} }` — the compose
 * panel's one-shot destination for THIS push (see src/lib/tasks/push-overrides).
 * NO BODY IS THE ORIGINAL CONTRACT and still the common one: the destination is
 * then the workspace-level config exactly as before, byte for byte.
 *
 * Malformed overrides are a 400 before any Asana call. Coded failures the UI
 * branches on:
 *   409 `already_linked`  — this action already has an Asana task
 *   400 `not_connected`   — no Asana account connected for the workspace
 *   400 `not_configured`  — connected, but no project picked yet
 *   400 `reconnect_required` — the stored token is no longer accepted
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
  const parsed = parseAsanaOverrides(body.value)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const result = await pushActionToAsana({
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
          error: 'This action is already linked to an Asana task',
          code: 'already_linked',
          task: result.link,
        },
        { status: 409 },
      )
    }

    return NextResponse.json({ task: result.link }, { status: 201 })
  } catch (err) {
    console.error('[asana] push failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to push to Asana' },
      { status: 500 },
    )
  }
}
