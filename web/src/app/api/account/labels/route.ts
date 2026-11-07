import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const LABEL_FIELDS = 'id, name, color, group_name, scopes, created_at'

const VALID_SCOPES = ['action', 'email_thread', 'project', 'initiative', 'capture']

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
  if (scope && VALID_SCOPES.includes(scope)) {
    query = query.or(`scopes.is.null,scopes.cs.{${scope}}`)
  }

  const { data, error } = await query
    .order('group_name', { ascending: true, nullsFirst: false })
    .order('name', { ascending: true })

  if (error) return serverError(error.message)

  return NextResponse.json({ labels: data || [] })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const body = await request.json()
  const name = (body.name || '').trim()

  if (!name) return badRequest('Name is required')

  const { data, error } = await supabase
    .from('label')
    .insert({
      workspace_id: workspaceId,
      name,
      color: body.color || '#6b7280',
      group_name: body.group_name || null,
      scopes: Array.isArray(body.scopes) && body.scopes.length > 0
        ? body.scopes.filter((s: string) => VALID_SCOPES.includes(s))
        : null,
    })
    .select(LABEL_FIELDS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return apiError('A label with that name already exists', { status: 409, code: 'CONFLICT' })
    }
    return serverError(error.message)
  }

  return NextResponse.json({ label: data })
}
