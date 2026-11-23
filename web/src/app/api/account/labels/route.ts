import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { cleanScopes, isScope, LABEL_FIELDS, labelWriteError, toLabelResponse, type LabelRow } from '@/lib/tags/label-rows'
import { isTagColor, TAG_DEFAULT_COLOR } from '@/lib/tags/palette'

// Labels are tags (docs/plans/tags.md). Row-level security returns the
// workspace's tags and the caller's own personal ones (migration 700).

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const scope = request.nextUrl.searchParams.get('scope')

  let query = supabase
    .from('label')
    .select(LABEL_FIELDS)
    .eq('workspace_id', workspaceId)

  // Filter by scope: return labels that are universal (scopes IS NULL) or include the requested scope
  if (isScope(scope)) {
    query = query.or(`scopes.is.null,scopes.cs.{${scope}}`)
  }

  const { data, error } = await query
    .order('group_name', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })

  if (error) return serverError(error.message)

  return NextResponse.json({ labels: ((data ?? []) as LabelRow[]).map(toLabelResponse) })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''

  if (!name) return badRequest('Name is required')
  if (body.color !== undefined && !isTagColor(body.color)) return badRequest('A tag color is #rrggbb')

  const { data, error } = await supabase
    .from('label')
    .insert({
      workspace_id: workspaceId,
      name,
      color: body.color || TAG_DEFAULT_COLOR,
      group_name: body.group_name || null,
      scopes: cleanScopes(body.scopes),
      // A personal tag: only its maker sees it.
      owner_user_id: body.personal === true ? user.id : null,
    })
    .select(LABEL_FIELDS)
    .single()

  if (error) {
    const known = labelWriteError(error.code)
    if (known) {
      return apiError(known.message, { status: known.status, code: known.status === 409 ? 'CONFLICT' : undefined })
    }
    return serverError(error.message)
  }

  return NextResponse.json({ label: toLabelResponse(data as LabelRow) })
}
