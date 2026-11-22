/**
 * GET: one thread of a company's team-shared email (migration 680), read
 * live from its owner's mailbox, view only. Only a thread the database lists
 * for this reader on this company (company_team_email_threads); anything else
 * is 404. A disconnected mailbox or a gone thread is 410. People only.
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { noStore, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'
import { readCompanyTeamThread } from '@/lib/email-share/company-team'
import { EMAIL_SHARE_UNAVAILABLE_TEXT } from '@/lib/email-share/types'

type Params = { params: Promise<{ id: string; threadId: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id, threadId } = await params
  try {
    const result = await readCompanyTeamThread(getServiceClient(), id, threadId, { userId: caller.userId, workspaceId: caller.workspaceId })
    if (result.state === 'not_found') return shareFailure({ ok: false, status: 404, code: 'not_found', error: 'Not found' })
    if (result.state === 'unavailable') return shareFailure({ ok: false, status: 410, code: 'unavailable', error: EMAIL_SHARE_UNAVAILABLE_TEXT })
    return noStore({ thread: result.thread })
  } catch (err) {
    return shareError(err, `company-team thread=${threadId}`, "Couldn't open that email")
  }
}
