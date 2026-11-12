import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import {
  CUSTOM_FIELD_ENTITIES,
  changeCustomFieldType,
  defineCustomField,
  isCustomFieldEntity as isEntity,
  isCustomFieldType as isType,
  listCustomFieldDefinitions,
  undoCustomFieldChange,
  type CustomFieldConfig,
} from '@/lib/crm/custom-fields'
import { isUuid } from '@/lib/crm/deals'

const options = (v: unknown) => (Array.isArray(v) ? v.filter((o): o is string => typeof o === 'string') : undefined)
const config = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as CustomFieldConfig) : undefined)

/**
 * GET ?entity_type=<kind>: the workspace's custom fields (every kind's when
 * absent). POST: define one. PATCH: change one's type, or undo a type
 * change. The kinds are the registry's `customFields` flag.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const entity = request.nextUrl.searchParams.get('entity_type')
  if (entity !== null && !isEntity(entity)) return badRequest(`entity_type is one of: ${CUSTOM_FIELD_ENTITIES.join(', ')}`)
  try {
    return NextResponse.json({ fields: await listCustomFieldDefinitions(auth.supabase, auth.workspaceId, entity ?? undefined) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load fields')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || !isEntity(body.entity_type) || !isType(body.field_type) || typeof body.label !== 'string') {
    return badRequest('entity_type, label and field_type are required')
  }
  const result = await defineCustomField(auth.supabase, auth.workspaceId, {
    entity_type: body.entity_type,
    label: body.label,
    field_type: body.field_type,
    options: options(body.options),
    config: config(body.config),
  })
  if (!result.ok) return badRequest(result.error)
  return NextResponse.json({ field: result.field, existed: result.existed }, { status: result.existed ? 200 : 201 })
}

/**
 * PATCH { id, field_type, options?, config? }: the field becomes another type,
 * every record's value converted, or nothing changes and the answer says how
 * many values don't fit (migration 526). PATCH { undo: change_id } takes a
 * type change back. Both answer the field and the change's id.
 */
export async function PATCH(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return badRequest('id and field_type, or undo, are required')
  const result = isUuid(body.undo)
    ? await undoCustomFieldChange(auth.supabase, auth.workspaceId, body.undo)
    : isUuid(body.id) && isType(body.field_type)
      ? await changeCustomFieldType(auth.supabase, auth.workspaceId, {
          id: body.id,
          field_type: body.field_type,
          options: options(body.options),
          config: config(body.config),
        })
      : null
  if (!result) return badRequest('id and field_type, or undo, are required')
  if (!result.ok) {
    if (result.reason === 'not_found') return notFound(result.error)
    if (result.reason === 'forbidden') return forbidden(result.error)
    return badRequest(result.error)
  }
  return NextResponse.json(result.value)
}
