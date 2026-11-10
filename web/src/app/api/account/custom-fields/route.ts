import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITIES,
  defineCustomField,
  isCustomFieldEntity as isEntity,
  listCustomFieldDefinitions,
  type CustomFieldType,
} from '@/lib/crm/custom-fields'

const isType = (v: unknown): v is CustomFieldType => (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(v)

/**
 * GET ?entity_type=<kind>: the workspace's custom fields (every kind's when
 * absent). POST: define one. The kinds are the registry's `customFields` flag.
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
  const options = Array.isArray(body.options) ? body.options.filter((o): o is string => typeof o === 'string') : undefined
  const result = await defineCustomField(auth.supabase, auth.workspaceId, {
    entity_type: body.entity_type,
    label: body.label,
    field_type: body.field_type,
    options,
  })
  if (!result.ok) return badRequest(result.error)
  return NextResponse.json({ field: result.field, existed: result.existed }, { status: result.existed ? 200 : 201 })
}
