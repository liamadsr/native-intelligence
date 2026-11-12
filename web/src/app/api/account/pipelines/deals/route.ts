import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { dealsLinkedTo, isUuid } from '@/lib/crm/deals'

/**
 * GET ?company_id= or ?contact_id=: the deals a company or a contact is on
 * (a contact's and a company's Deals tab), from their relation edges, each
 * with its pipeline's name and its stage's outcome.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const params = request.nextUrl.searchParams
  const companyId = params.get('company_id')
  const contactId = params.get('contact_id')
  const target = companyId ? { kind: 'company' as const, id: companyId } : contactId ? { kind: 'contact' as const, id: contactId } : null
  if (!target || !isUuid(target.id)) return badRequest('company_id or contact_id is a record id.')
  try {
    const { deals, pipelines } = await dealsLinkedTo(supabase, workspaceId, target)
    const names = new Map(pipelines.map((p) => [p.id, p.name]))
    return NextResponse.json({
      deals: deals.map((d) => ({
        id: d.id,
        name: d.name,
        pipeline_id: d.pipeline_id,
        pipeline: names.get(d.pipeline_id) ?? null,
        stage: d.stage,
        status: d.status,
        value: d.value,
        currency: d.currency,
        expected_close_date: d.expected_close_date,
        owner_id: d.owner_id,
        updated_at: d.updated_at,
      })),
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load deals')
  }
}
