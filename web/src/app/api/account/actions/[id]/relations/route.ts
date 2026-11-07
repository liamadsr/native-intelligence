import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const RELATION_TYPES = ['blocks', 'blocked_by', 'related', 'duplicate'] as const
const INVERSE_MAP: Record<string, string> = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id } = await params

  // Outgoing (this action is the source) and incoming (this action is the
  // target) relations are independent — fetch in parallel.
  const [{ data: outgoing }, { data: incoming }] = await Promise.all([
    supabase
      .from('action_relation')
      .select(
        'id, type, related_action_id, related:actions!related_action_id(id, identifier, title, status_id, workflow_state:workflow_state!status_id(name, color))',
      )
      .eq('action_id', id),
    supabase
      .from('action_relation')
      .select(
        'id, type, action_id, source:actions!action_id(id, identifier, title, status_id, workflow_state:workflow_state!status_id(name, color))',
      )
      .eq('related_action_id', id),
  ])

  // blocks/blocked_by are stored as a pair (POST writes the inverse row), so
  // the incoming half of a pair is already listed as an outgoing row. Only
  // flip incoming rows that have no outgoing twin (single-row data).
  const outgoingKeys = new Set(
    (outgoing || []).map((r) => `${r.related_action_id}:${r.type}`),
  )
  const incomingOnly = (incoming || []).filter(
    (r) => !outgoingKeys.has(`${r.action_id}:${INVERSE_MAP[r.type] || r.type}`),
  )

  const relations = [
    ...(outgoing || []).map((r) => {
      const related = r.related as unknown as {
        id: string
        identifier: string
        title: string
        status_id: string
        workflow_state: { name: string; color: string } | null
      } | null
      return {
        id: r.id,
        type: r.type,
        action_id: related?.id,
        identifier: related?.identifier,
        title: related?.title,
        status_name: related?.workflow_state?.name || '',
        status_color: related?.workflow_state?.color || '#6b7280',
      }
    }),
    ...incomingOnly.map((r) => {
      const source = r.source as unknown as {
        id: string
        identifier: string
        title: string
        status_id: string
        workflow_state: { name: string; color: string } | null
      } | null
      // Flip the type for incoming (if A blocks B, then B sees "blocked_by A")
      const displayType = INVERSE_MAP[r.type] || r.type
      return {
        id: r.id,
        type: displayType,
        action_id: source?.id,
        identifier: source?.identifier,
        title: source?.title,
        status_name: source?.workflow_state?.name || '',
        status_color: source?.workflow_state?.color || '#6b7280',
      }
    }),
  ]

  return NextResponse.json({ relations })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params
  const body = await request.json()
  const { related_action_id, type } = body as {
    related_action_id?: string
    type?: string
  }

  if (!related_action_id || !type) {
    return badRequest('related_action_id and type are required')
  }

  if (!RELATION_TYPES.includes(type as (typeof RELATION_TYPES)[number])) {
    return badRequest('Invalid relation type')
  }

  if (id === related_action_id) {
    return badRequest('Cannot relate an action to itself')
  }

  // Verify both actions belong to this workspace — two independent lookups,
  // checked in the original order (source first) after both resolve.
  const [{ data: sourceAction }, { data: relatedAction }] = await Promise.all([
    supabase
      .from('actions')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('actions')
      .select('id')
      .eq('id', related_action_id)
      .eq('workspace_id', workspaceId)
      .single(),
  ])
  if (!sourceAction) {
    return notFound('Action not found')
  }
  if (!relatedAction) {
    return notFound('Related action not found')
  }

  // Create the relation
  const { data, error } = await supabase
    .from('action_relation')
    .insert({ action_id: id, related_action_id, type })
    .select('id, type, action_id, related_action_id')
    .single()

  if (error) {
    return serverError(error.message)
  }

  // Create inverse for blocks/blocked_by
  const inverse = INVERSE_MAP[type]
  if (inverse) {
    await supabase
      .from('action_relation')
      .insert({
        action_id: related_action_id,
        related_action_id: id,
        type: inverse,
      })
      .select()
      .single()
  }

  return NextResponse.json({ relation: data })
}
