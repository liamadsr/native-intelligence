/**
 * /api/account/environments/chat (docs/plans/environments.md §6, §7 Q1): a
 * chat's environment, where its agent sends work.
 *
 * GET  ?conversationId=<id>
 *      { environmentId: string | null, source: 'chat' | 'default' | 'mac' |
 *        'workspace' | 'none', environment: Environment | null }
 *      In order: the chat's own, the person's default for the chat's
 *      workspace, their most recently online Mac, the workspace's default
 *      cloud environment, else none (src/lib/environments/chat.ts).
 *      `environment` is the item GET /api/account/environments lists. Without
 *      a conversationId (a chat not made yet), the same order from the
 *      default on, in the current workspace.
 * PUT  { conversationId, environmentId: string | null }
 *      Sets the chat's environment (its owner only; one of their Macs, or a
 *      cloud environment of the chat's workspace they can use) and records it
 *      as their default for that workspace. null clears the chat's (the next
 *      default applies). Without a conversationId, only the default is set.
 *      { environmentId }
 * Both refuse a capture-device token (requireEnvironmentsWorkspace).
 */
import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { resolveChatEnvironment, setChatEnvironment } from '@/lib/environments/chat'
import { environmentErrorResponse, readJsonObject, requireEnvironmentsWorkspace } from '@/lib/environments/http'

export async function GET(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const conversationId = new URL(request.url).searchParams.get('conversationId')
  try {
    const view = await resolveChatEnvironment(getServiceClient(), {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      conversationId: conversationId || null,
    })
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return environmentErrorResponse(err, 'chat environment')
  }
}

export async function PUT(request: Request) {
  const auth = await requireEnvironmentsWorkspace(request)
  if (auth instanceof Response) return auth
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  if (!('environmentId' in body)) return badRequest('environmentId is required (null clears the chat’s)')
  try {
    const set = await setChatEnvironment(getServiceClient(), {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      conversationId: body.conversationId,
      environmentId: body.environmentId,
    })
    return NextResponse.json(set)
  } catch (err) {
    return environmentErrorResponse(err, 'set chat environment')
  }
}
