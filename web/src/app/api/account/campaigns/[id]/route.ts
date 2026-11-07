/**
 * /api/account/campaigns/[id] — update one campaign.
 *
 * No DELETE: a campaign is a knowledge ANCHOR that claims and entity links
 * point at, so removing one silently orphans knowledge. Retiring a campaign is
 * `status: 'archived'` — same posture as companies, where delete is a
 * deliberate owner/admin action on a dedicated surface rather than a REST verb.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { CAMPAIGN_COLUMNS, parseCampaignWrite } from '@/lib/campaigns/shape'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const parsed = parseCampaignWrite(body)
  if (!parsed.ok) return badRequest(parsed.error)
  if (Object.keys(parsed.fields).length === 0) {
    return badRequest('Pass at least one field to change')
  }

  const { data, error } = await supabase
    .from('campaign')
    .update({ ...parsed.fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(CAMPAIGN_COLUMNS)
    .maybeSingle()

  if (error) {
    // campaign_sequence_same_workspace (migration 460): another workspace's sequence.
    if (/campaign sequence must be in/.test(error.message)) return badRequest('sequence_id must be a sequence in this workspace')
    console.error('[campaigns] update failed:', error.message)
    return serverError()
  }
  // RLS makes "not yours" and "does not exist" the same answer, which is the
  // right one to give.
  if (!data) return notFound('Campaign not found')

  return NextResponse.json({ campaign: data })
}
