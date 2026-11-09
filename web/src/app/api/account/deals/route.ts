import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createDeal, findDeals } from '@/lib/crm/deals'
import { dealInputFromBody } from '@/lib/crm/deal-input'

/** GET: deals (search, stage, status, company_id, contact_id). POST: a new deal. Roadmap #8. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const p = request.nextUrl.searchParams
  try {
    const status = p.get('status')
    const { deals, pipelines } = await findDeals(supabase, workspaceId, {
      search: p.get('search') ?? undefined,
      stage: p.get('stage') ?? undefined,
      status: status === 'open' || status === 'won' || status === 'lost' ? status : 'all',
      company_id: p.get('company_id') ?? undefined,
      contact_id: p.get('contact_id') ?? undefined,
      limit: Number(p.get('limit')) || 100,
    })
    return NextResponse.json({ deals, pipelines })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load deals')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = await request.json().catch(() => null)
  const input = dealInputFromBody(body)
  if (!input.ok) return badRequest(input.error)
  if (!input.input.name) return badRequest('A deal needs a name.')
  const result = await createDeal(supabase, workspaceId, { ...input.input, name: input.input.name }, { userId: user.id, source: 'person' })
  if (!result.ok) return badRequest(result.error)
  return NextResponse.json({ deal: result.deal }, { status: 201 })
}
