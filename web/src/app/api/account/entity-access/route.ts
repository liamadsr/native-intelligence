/**
 * /api/account/entity-access (the shared entity layer, phase 5; migration 492)
 *   GET  ?type=document|capture|contact|company&id=<uuid>
 *        → { can_share, restricted, grants } the people, teams and channels
 *        a record is shared with, for its share dialog. 404 when the person
 *        can't read the record.
 *   POST { type, id, grantee_kind: 'member'|'team'|'channel', grantee_id }
 *        → { id } a view grant, as the person (only someone who may share
 *        the record: a private doc's or capture's creator, a restricted
 *        contact's creator or an admin, a company's admin). 403 otherwise,
 *        409 when that grantee already has one.
 * Runs as the person, under RLS (src/lib/entity-access/store.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { addEntityGrant, loadEntityAccess } from '@/lib/entity-access/store'
import { isGrantableType, isGranteeKind } from '@/lib/entity-access/model'
import { isUuid } from '@/lib/team-chat/types'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const type = request.nextUrl.searchParams.get('type')
  const id = request.nextUrl.searchParams.get('id')
  if (!isGrantableType(type) || !isUuid(id)) return badRequest('type and id are required')
  try {
    const access = await loadEntityAccess(auth.supabase, { workspaceId: auth.workspaceId, memberId: auth.member.id }, type, id)
    if (!access) return notFound()
    return NextResponse.json(access)
  } catch (err) {
    console.error('[entity-access] list failed:', err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const { type, id, grantee_kind: kind, grantee_id: granteeId } = input
  if (!isGrantableType(type) || !isUuid(id) || !isGranteeKind(kind) || !isUuid(granteeId)) {
    return badRequest('type, id, grantee_kind and grantee_id are required')
  }
  const result = await addEntityGrant(auth.supabase, { workspaceId: auth.workspaceId, memberId: auth.member.id }, type, id, { kind, id: granteeId })
  if ('id' in result) return NextResponse.json({ id: result.id }, { status: 201 })
  if (result.error === 'forbidden') return forbidden(result.message)
  if (result.error === 'exists') return conflict(result.message)
  if (result.error === 'invalid') return badRequest(result.message)
  console.error('[entity-access] add failed:', result.message)
  return serverError()
}
