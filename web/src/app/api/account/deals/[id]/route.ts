import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getDeal, isUuid, listDealEvents, listPipelines, lookupDealNames, updateDeal } from '@/lib/crm/deals'
import { listCustomFieldDefinitions } from '@/lib/crm/custom-fields'
import { dealInputFromBody } from '@/lib/crm/deal-input'

type Ctx = { params: Promise<{ id: string }> }

/** GET: one deal with names, its pipelines, its custom field definitions and its recent changes. */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  try {
    const deal = await getDeal(supabase, workspaceId, id)
    if (!deal) return notFound('Deal not found')
    const [pipelines, names, events, fields] = await Promise.all([
      listPipelines(supabase, workspaceId),
      lookupDealNames(supabase, workspaceId, [deal]),
      listDealEvents(supabase, workspaceId, id, 20),
      listCustomFieldDefinitions(supabase, workspaceId, 'deal'),
    ])
    return NextResponse.json({
      deal,
      pipelines,
      company: deal.company_id ? { id: deal.company_id, name: names.companies.get(deal.company_id) ?? null } : null,
      contacts: deal.contact_ids.map((cid) => ({ id: cid, name: names.contacts.get(cid) ?? null })),
      owner: deal.owner_id ? { id: deal.owner_id, display_name: names.owners.get(deal.owner_id) ?? null } : null,
      events,
      custom_field_definitions: fields,
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the deal')
  }
}

/**
 * PATCH: change a deal (the board's drag sends `{ stage_id }`). Logged as the
 * person's change, so it is undoable like the agent's.
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Deal not found')
  const body = await request.json().catch(() => null)
  const input = dealInputFromBody(body)
  if (!input.ok) return badRequest(input.error)
  const result = await updateDeal(supabase, workspaceId, id, input.input, { userId: user.id, source: 'person' })
  if (!result.ok) return result.error === 'Deal not found' ? notFound(result.error) : badRequest(result.error)
  return NextResponse.json({ deal: result.deal, change_id: result.eventId })
}

/** DELETE: the person's click only (the agent has no delete). */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Deal not found')
  const { data, error } = await supabase.from('deal').delete().eq('id', id).eq('workspace_id', workspaceId).select('id')
  if (error) return serverError(error.message)
  if (!data?.length) return notFound('Deal not found')
  return NextResponse.json({ deleted: true })
}
