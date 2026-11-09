import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { listPipelines } from '@/lib/crm/deals'

/** GET: the workspace's pipelines and their stages in order (seeds the default on first use). */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json({ pipelines: await listPipelines(auth.supabase, auth.workspaceId) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load pipelines')
  }
}
