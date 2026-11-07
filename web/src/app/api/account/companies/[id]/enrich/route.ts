import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { inngest } from '@/lib/inngest/client'
import { apiError, notFound, noWorkspace, serverError, unauthorized } from '@/lib/api-errors'
import { hasPermanentFailure } from '@/lib/crm/enrichment'
import { getServiceClient } from '@/lib/admin'
import { openManualEnrichment, settleManualEnrichment } from '@/lib/work/enrichment-mirror'

/**
 * POST /api/account/companies/[id]/enrich
 *
 * Manually queue web enrichment for one company. Sibling of the contact
 * trigger — same contract: 202 + the work runs in Inngest
 * (crm/enrich-company.manual), re-enrichment of an already-enriched row is
 * allowed (fill-empty write-back makes it non-destructive), and a
 * permanent-failure marker is refused with 409 rather than burning another paid
 * search. Enrichment runs only when someone asks, so this click is the one
 * way a company gets enriched outside Prospecting and onboarding.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return noWorkspace()

  const { id } = await params

  const { data: company, error } = await supabase
    .from('company')
    .select('id, metadata, name')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!company) return notFound('Company not found')

  if (hasPermanentFailure(company.metadata)) {
    return apiError(
      'This company previously failed enrichment in a way that will not succeed on retry.',
      { status: 409, code: 'ENRICHMENT_PERMANENTLY_FAILED' },
    )
  }

  const { error: markErr } = await supabase
    .from('company')
    .update({ enrichment_status: 'pending' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
  if (markErr) return serverError(markErr.message)

  // The Activity row for this click (owned by the clicker); the handler settles
  // it by the run key the event carries. Fail-soft: no row, no key.
  const workRunKey = await openManualEnrichment(getServiceClient(), {
    workspaceId,
    userId: user.id,
    table: 'company',
    recordId: id,
    name: company.name as string | null,
  })

  try {
    await inngest.send({
      name: 'crm/enrich-company.manual',
      data: { companyId: id, workspaceId, userId: user.id, workRunKey },
    })
  } catch (err) {
    // Nothing will run for this click: settle its row rather than leave it
    // queued for the reaper.
    await settleManualEnrichment(
      getServiceClient(),
      workRunKey,
      { status: 'failed', error: 'The search could not be queued' },
      { workspaceId, table: 'company', recordId: id },
    )
    throw err
  }

  return NextResponse.json({ status: 'pending' }, { status: 202 })
}
