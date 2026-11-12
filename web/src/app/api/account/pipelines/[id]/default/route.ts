import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { isUuid, setDefaultPipeline } from '@/lib/crm/deals'

/** POST: make this pipeline the workspace's default (540's set_default_pipeline). */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Pipeline not found')
  try {
    const result = await setDefaultPipeline(supabase, id)
    if (result.ok) return NextResponse.json({ id })
    if (result.reason === 'not_found') return notFound(result.error)
    if (result.reason === 'forbidden') return forbidden(result.error)
    return badRequest(result.error)
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not make it the default')
  }
}
