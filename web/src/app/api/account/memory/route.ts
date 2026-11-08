import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notMember, serverError } from '@/lib/api-errors'
import { AREA_KEYS, isAreaKey } from '@/lib/packs/registry'
import { canManageWorkspaceMemory, isMemoryScope, type MemoryLine } from '@/lib/packs/memory-types'
import { MEMORY_LINE_COLUMNS, memberRole, saveMemoryLine } from '@/lib/packs/memory-write'

/**
 * What Native Intelligence has learned, in the current workspace (one-agent plan Part 3,
 * "Memory"; migration 317): the editor's read and its add.
 *
 * Runs on the person's own session, so RLS decides which lines come back
 * (their own personal lines and the workspace's) and which writes land; the
 * response says whether they may manage the workspace's lines, so the editor
 * shows Accept, Edit and Delete only where they work.
 */

/** GET ?area=mail: the lines (every area when absent), and the caller's standing. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const area = request.nextUrl.searchParams.get('area')
  if (area !== null && !isAreaKey(area)) return badRequest(`area must be one of ${AREA_KEYS.join(', ')}.`)

  const role = await memberRole(supabase, workspaceId, user.id)
  if (!role) return notMember()

  let q = supabase.from('area_memory').select(MEMORY_LINE_COLUMNS).eq('workspace_id', workspaceId)
  if (area) q = q.eq('area', area)
  const { data, error } = await q.order('created_at', { ascending: true }).limit(2000)
  if (error) return serverError(error.message)

  return NextResponse.json({
    userId: user.id,
    canManageWorkspace: canManageWorkspaceMemory(role),
    lines: (data ?? []) as MemoryLine[],
  })
}

/** POST { area, scope, text }: add a line, typed in the editor. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest('Send JSON: { area, scope, text }.')
  if (!isAreaKey(body.area)) return badRequest(`area must be one of ${AREA_KEYS.join(', ')}.`)
  if (!isMemoryScope(body.scope)) return badRequest('scope must be personal or workspace.')
  if (typeof body.text !== 'string') return badRequest('text must be the line, as a string.')

  const result = await saveMemoryLine(supabase, {
    workspaceId,
    userId: user.id,
    area: body.area,
    scope: body.scope,
    text: body.text,
    source: 'edited',
  })
  if (!result.ok) {
    if (result.code === 'NOT_MEMBER') return notMember()
    if (result.code === 'SAVE_FAILED') return serverError(result.error)
    return apiError(result.error, { status: result.code === 'NOTE_FULL' || result.code === 'TOO_MANY_PROPOSALS' ? 409 : 400, code: result.code })
  }
  return NextResponse.json({ line: result.line, already: result.already }, { status: result.already ? 200 : 201 })
}
