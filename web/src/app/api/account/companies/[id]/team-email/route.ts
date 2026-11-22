/**
 * A company's email, shared with the team (migration 680).
 *
 * GET: the sharing status (the switch, my consent, who shares) and the
 * threads I may see, newest first, each read live from its owner's mailbox.
 * POST { action }: as the signed-in person, through the database's own
 * functions (each checks the caller and the company again):
 *   'sharing'  { on }             the company's switch (anyone who can see it)
 *   'consent'  { on }             MY agreement to share MY mail with this company
 *   'private'  { thread_id, on }  keep one of MY threads private (every company)
 *   'stop_all'                    stop sharing my mail with every company here
 * People only: a device token is refused (shared mail opens in the app).
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { noStore, shareCaller, shareError } from '@/lib/email-share/http'
import { companySharingStatus, listCompanyTeamThreads } from '@/lib/email-share/company-team'
import { isUuid } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  if (!isUuid(id)) return notFound('Company not found')
  const svc = getServiceClient()
  const me = { userId: caller.userId, workspaceId: caller.workspaceId }
  try {
    const status = await companySharingStatus(svc, id, me)
    if (!status) return notFound('Company not found')
    const threads = status.enabled ? await listCompanyTeamThreads(svc, id, me) : []
    return noStore({ status, threads })
  } catch (err) {
    return shareError(err, `company-team list company=${id}`, "Couldn't load the shared email")
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  if (!isUuid(id)) return notFound('Company not found')
  const body = (await request.json().catch(() => null)) as { action?: unknown; on?: unknown; thread_id?: unknown } | null
  const on = body?.on === true
  const db = caller.supabase
  let res: { error: { message: string; code?: string } | null }
  switch (body?.action) {
    case 'sharing':
      res = await db.rpc('set_company_email_sharing', { p_company_id: id, p_on: on })
      break
    case 'consent':
      res = await db.rpc('set_company_email_consent', { p_company_id: id, p_on: on })
      break
    case 'private':
      if (!isUuid(body.thread_id)) return badRequest('Which thread?')
      res = await db.rpc('set_email_thread_team_private', { p_thread_index_id: body.thread_id, p_private: on })
      break
    case 'stop_all':
      res = await db.rpc('stop_sharing_my_company_email', { p_workspace_id: caller.workspaceId })
      break
    default:
      return badRequest('Unknown action')
  }
  if (res.error) {
    if (res.error.code === 'P0002') return notFound('Not found')
    return serverError("Couldn't save that")
  }
  const status = await companySharingStatus(getServiceClient(), id, { userId: caller.userId, workspaceId: caller.workspaceId })
  return noStore({ ok: true, status })
}
