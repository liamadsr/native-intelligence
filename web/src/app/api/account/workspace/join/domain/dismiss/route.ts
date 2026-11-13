/**
 * POST { workspace_ids }: "Not now" on /join/team. Those workspaces are
 * never offered to this person by email domain again (their account's
 * app_metadata, written by the service role). Only workspaces actually on
 * offer to them are recorded.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { dismissDomainOffers } from '@/lib/workspace-join/domain-offer'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX = 50

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let ids: unknown
  try {
    ids = ((await request.json()) as { workspace_ids?: unknown })?.workspace_ids
  } catch {
    return badRequest('Invalid JSON')
  }
  if (!Array.isArray(ids) || ids.length > MAX || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) {
    return badRequest('workspace_ids must be a list of workspace ids')
  }

  try {
    const dismissed = await dismissDomainOffers(getServiceClient(), user, ids as string[])
    return NextResponse.json({ dismissed })
  } catch (err) {
    console.error('[workspace-join] dismiss failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}
