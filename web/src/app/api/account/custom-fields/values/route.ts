import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { describeCustomFields, listCustomFieldDefinitions, setRecordCustomFields } from '@/lib/crm/custom-fields'
import { isUuid, updateDeal } from '@/lib/crm/deals'

/** GET ?entity_type&id: a record's custom fields, every defined one with its value (null when unset). */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const entity = request.nextUrl.searchParams.get('entity_type')
  const id = request.nextUrl.searchParams.get('id')
  if ((entity !== 'deal' && entity !== 'contact' && entity !== 'company') || !isUuid(id)) return badRequest('entity_type and id are required')
  const [defs, row] = await Promise.all([
    listCustomFieldDefinitions(supabase, workspaceId, entity),
    supabase.from(entity).select('custom_fields').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (!row.data) return notFound('Not found')
  return NextResponse.json({ fields: describeCustomFields(defs, (row.data as { custom_fields?: unknown }).custom_fields), definitions: defs })
}

/** POST { entity_type, id, values }: set custom field values on a deal, contact or company. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const values = body?.values
  if (!body || !isUuid(body.id) || !values || typeof values !== 'object' || Array.isArray(values)) {
    return badRequest('entity_type, id and values are required')
  }
  if (body.entity_type === 'deal') {
    const result = await updateDeal(supabase, workspaceId, body.id, { custom_fields: values as Record<string, unknown> }, { userId: user.id, source: 'person' })
    if (!result.ok) return result.error === 'Deal not found' ? notFound(result.error) : badRequest(result.error)
    return NextResponse.json({ custom_fields: result.deal.custom_fields })
  }
  if (body.entity_type !== 'contact' && body.entity_type !== 'company') return badRequest('entity_type is deal, contact or company')
  const result = await setRecordCustomFields(supabase, workspaceId, body.entity_type, body.id, values as Record<string, unknown>)
  if (!result.ok) return result.error.endsWith('not found') ? notFound(result.error) : badRequest(result.error)
  return NextResponse.json({ custom_fields: result.custom_fields })
}
