/**
 * The REST routes' common part (src/app/api/account/tables/[id]/forms and
 * src/app/api/account/forms): the asker from their session, the body, and
 * a ./manage.ts answer sent as JSON. Server only.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { appOrigin } from '@/lib/twilio/config'
import type { ManageContext, ManageResult } from './manage'

/** Run one manage handler for the signed-in member: 401/400 from requireWorkspace, else its answer. */
export async function runManage(request: Request | null, run: (ctx: ManageContext, body: Record<string, unknown>) => Promise<ManageResult>): Promise<Response> {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  let body: Record<string, unknown> = {}
  if (request) {
    const parsed = (await request.json().catch(() => null)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Send a JSON object.')
    body = parsed as Record<string, unknown>
  }
  try {
    const result = await run({ db: auth.supabase, service: getServiceClient(), workspaceId: auth.workspaceId, userId: auth.user.id, origin: appOrigin() }, body)
    if ('error' in result) return apiError(result.error, { status: result.status })
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[forms.manage] failed:', e instanceof Error ? e.message : String(e))
    return serverError('Could not change the form right now.')
  }
}
