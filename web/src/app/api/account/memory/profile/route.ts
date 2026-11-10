import { NextResponse, type NextRequest } from 'next/server'
import { requireUser, requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { PROFILE_FACT_COLUMNS, saveProfileFact, type ProfileFact } from '@/lib/memory/profile-facts'

/**
 * Facts about you (always-on plan §3, slice A2a; migration 328): the "About
 * you" group of What Native Intelligence has learned. The person's own facts, the same in
 * every workspace.
 *
 * Runs on the person's own session, so RLS (user_id = auth.uid()) decides
 * which rows come back and which writes land; the writer fences by user too.
 */

/** GET: the person's live facts (active and proposed), most important then newest first. */
export async function GET(_request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { data, error } = await supabase
    .from('profile_fact')
    .select(PROFILE_FACT_COLUMNS)
    .eq('user_id', user.id)
    .is('retired_at', null)
    .order('importance', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(500)
  if (error) return serverError(error.message)
  return NextResponse.json({ facts: (data ?? []) as ProfileFact[] })
}

/** POST { text, importance? }: add a fact, typed in the editor (active at once). */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.text !== 'string') return badRequest('Send JSON: { text }.')
  if (body.importance !== undefined && typeof body.importance !== 'number') return badRequest('importance must be a number from 1 to 5.')

  const result = await saveProfileFact(supabase, {
    userId: user.id,
    text: body.text,
    source: 'edited',
    importance: body.importance as number | undefined,
    sourceWorkspaceId: workspaceId,
  })
  if (!result.ok) {
    if (result.code === 'SAVE_FAILED') return serverError(result.error)
    return apiError(result.error, { status: result.code === 'INPUT_INVALID' ? 400 : 409, code: result.code })
  }
  return NextResponse.json({ fact: result.fact, already: result.already }, { status: result.already ? 200 : 201 })
}
