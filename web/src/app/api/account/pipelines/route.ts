import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createPipeline, listPipelines, type DealStageKind } from '@/lib/crm/deals'

/**
 * GET: the workspace's pipelines (Tables, phase 7: a pipeline is a table),
 * the default first, each with its stages; makes the default ("Sales") the
 * first time. POST { name, stages? }: a new pipeline.
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  try {
    const pipelines = await listPipelines(supabase, workspaceId)
    return NextResponse.json({
      pipelines: pipelines.map((p) => ({ id: p.id, name: p.name, is_default: p.is_default, visibility: p.visibility, stages: p.stages })),
      default_id: pipelines.find((p) => p.is_default)?.id ?? pipelines[0]?.id ?? null,
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load pipelines')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.name !== 'string') return badRequest('A pipeline needs a name.')
  const stages = Array.isArray(body.stages)
    ? (body.stages as unknown[])
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).name === 'string')
        .map((s) => ({ name: s.name as string, outcome: (['won', 'lost'].includes(s.outcome as string) ? s.outcome : 'open') as DealStageKind }))
    : undefined
  try {
    const result = await createPipeline(supabase, workspaceId, { name: body.name, stages }, { userId: user.id, source: 'person' })
    if (!result.ok) return badRequest(result.error)
    return NextResponse.json({ id: result.id }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not make the pipeline')
  }
}
