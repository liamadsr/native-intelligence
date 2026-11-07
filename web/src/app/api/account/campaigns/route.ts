/**
 * /api/account/campaigns — list + create.
 *
 * Runs on the RLS-scoped client from `requireWorkspace`, never the service
 * client: migration 267 gives `campaign` a single member-only policy with no
 * visibility fence, so RLS IS the boundary and a query returning nothing means
 * the caller may not see it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import {
  CAMPAIGN_COLUMNS,
  CAMPAIGN_STATUSES,
  parseCampaignWrite,
  type Campaign,
} from '@/lib/campaigns/shape'
import { campaignCounts } from '@/lib/campaigns/counts'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('campaign')
    .select(CAMPAIGN_COLUMNS)
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('[campaigns] list failed:', error.message)
    return serverError()
  }

  // A campaign that sends: its counts (from its sequence's enrollments) and
  // its sequence's name, for the list.
  const campaigns = (data ?? []) as unknown as Campaign[]
  const sequenceIds = [...new Set(campaigns.map((c) => c.sequence_id).filter((id): id is string => !!id))]
  if (sequenceIds.length === 0) return NextResponse.json({ campaigns })
  try {
    const [counts, sequences] = await Promise.all([
      campaignCounts(supabase, { workspaceId, campaigns }),
      supabase.from('sequence').select('id, name').eq('workspace_id', workspaceId).in('id', sequenceIds),
    ])
    const names = new Map(((sequences.data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]))
    return NextResponse.json({
      campaigns: campaigns.map((c) => (c.sequence_id ? { ...c, counts: counts.get(c.id), sequence_name: names.get(c.sequence_id) ?? null } : c)),
    })
  } catch (err) {
    console.error('[campaigns] counts failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ campaigns })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('name is required')

  const parsed = parseCampaignWrite(body)
  if (!parsed.ok) return badRequest(parsed.error)

  const { data, error } = await supabase
    .from('campaign')
    .insert({
      workspace_id: workspaceId,
      name,
      ...parsed.fields,
      status: parsed.fields.status ?? CAMPAIGN_STATUSES[0],
    })
    .select(CAMPAIGN_COLUMNS)
    .single()

  if (error) {
    if (/campaign sequence must be in/.test(error.message)) return badRequest('sequence_id must be a sequence in this workspace')
    console.error('[campaigns] create failed:', error.message)
    return serverError()
  }

  return NextResponse.json({ campaign: data }, { status: 201 })
}
