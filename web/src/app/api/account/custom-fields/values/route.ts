import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound } from '@/lib/api-errors'
import {
  CUSTOM_FIELD_ENTITIES,
  customFieldTable,
  describeCustomFields,
  isCustomFieldEntity,
  listCustomFieldDefinitions,
  setRecordCustomFields,
} from '@/lib/crm/custom-fields'
import { customFieldWriteRefusal } from '@/lib/crm/custom-field-access'
import { fieldReferenceCheck, fieldValueLabels } from '@/lib/crm/custom-field-references'
import { isUuid, updateDeal } from '@/lib/crm/deals'

const KIND_ERROR = `entity_type is one of: ${CUSTOM_FIELD_ENTITIES.join(', ')}`

/**
 * GET ?entity_type&id: a record's custom fields, every defined one with its
 * value (null when unset). The record is read through the caller's RLS, so a
 * record they can't see is not found. Any kind the registry marks
 * `customFields`. `editable` says whether the caller may change them (a record
 * shared to them for viewing only: no), asked only when there are fields.
 * `labels` names the people and linked records the values hold (only those
 * the caller can read); `members` are the people a person field can take.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const entity = request.nextUrl.searchParams.get('entity_type')
  const id = request.nextUrl.searchParams.get('id')
  if (!isCustomFieldEntity(entity) || !isUuid(id)) return badRequest(`entity_type and id are required; ${KIND_ERROR}`)
  const [defs, row] = await Promise.all([
    listCustomFieldDefinitions(supabase, workspaceId, entity),
    supabase.from(customFieldTable(entity)).select('custom_fields').eq('id', id).eq('workspace_id', workspaceId).maybeSingle(),
  ])
  if (!row.data) return notFound('Not found')
  const values = (row.data as { custom_fields?: Record<string, unknown> }).custom_fields ?? {}
  const people = defs.some((d) => d.field_type === 'person')
  const [editable, labels, members] = await Promise.all([
    defs.length === 0 || entity === 'deal' || customFieldWriteRefusal(supabase, user.id, workspaceId, entity, id).then((r) => r === null),
    fieldValueLabels(supabase, workspaceId, defs, [values]),
    people
      ? Promise.resolve(supabase.from('member').select('id, display_name').eq('workspace_id', workspaceId).neq('role', 'guest').order('display_name')).then(
          (res) => ((res.data ?? []) as Array<{ id: string; display_name: string | null }>).map((m) => ({ id: m.id, name: m.display_name?.trim() || 'Member' })),
          () => [],
        )
      : [],
  ])
  return NextResponse.json({
    fields: describeCustomFields(defs, values),
    definitions: defs,
    editable,
    labels,
    members,
  })
}

/**
 * POST { entity_type, id, values }: set custom field values on a record. A
 * deal's go through updateDeal (logged, undoable); every other kind checks
 * the caller's edit right on the record first (custom-field-access), then
 * writes through their own RLS, which reads back the row it changed: a record
 * they may only view is a 403, never a silent no-op.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const values = body?.values
  if (!body || !isUuid(body.id) || !values || typeof values !== 'object' || Array.isArray(values)) {
    return badRequest('entity_type, id and values are required')
  }
  if (!isCustomFieldEntity(body.entity_type)) return badRequest(KIND_ERROR)
  if (body.entity_type === 'deal') {
    const result = await updateDeal(supabase, workspaceId, body.id, { custom_fields: values as Record<string, unknown> }, { userId: user.id, source: 'person' })
    if (!result.ok) return result.error === 'Deal not found' ? notFound(result.error) : badRequest(result.error)
    return NextResponse.json({ custom_fields: result.deal.custom_fields })
  }
  const refusal = await customFieldWriteRefusal(supabase, user.id, workspaceId, body.entity_type, body.id)
  if (refusal) return refusal.reason === 'not_found' ? notFound(refusal.error) : forbidden(refusal.error)
  const result = await setRecordCustomFields(supabase, workspaceId, body.entity_type, body.id, values as Record<string, unknown>, {
    checkReferences: fieldReferenceCheck(supabase, { workspaceId, userId: user.id }),
  })
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(result.error)
    if (result.reason === 'forbidden') return forbidden(result.error)
    return badRequest(result.error)
  }
  return NextResponse.json({ custom_fields: result.custom_fields })
}
