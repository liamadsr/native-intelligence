/**
 * GET /api/local-agent/sessions?conversationId=…&live=1 — the person's local
 * agents (newest first, at most 100), optionally one conversation's, or only
 * the live ones. Returns {sessions: SessionRow[]}.
 *
 * GET /api/local-agent/sessions?code=1 — the Code view's list: every coding
 * job of the person's in the window's workspace (their Code tab's, an
 * action's Start, the chat agent's, a loop's), each with the action it works
 * named (`action`: id, identifier, title).
 *
 * POST /api/local-agent/sessions — the person starts a job from the chat
 * composer's Code tab (src/lib/local-agent/code-start.ts): their own typed
 * send, in a folder on one of their Macs, on the agent they picked.
 *   Body: {conversationId, folderId, request, worker, requestId, environmentId?, newJob?, model?, effort?}
 *     model, effort  (721) the model and effort for the person's own coding
 *                  agent, each an id its Mac's offer lists or null for its
 *                  default; refused (409 MODEL_NOT_OFFERED) unless that Mac's
 *                  app says the agent takes them
 *     worker       a coding agent's id the Mac offers, or null for Native
 *                  Intelligence's own agent (required)
 *     requestId    one per send: a retry with it gets the first job back
 *     environmentId  the chat's environment: a cloud one is refused (409
 *                  CODE_CLOUD_NEXT)
 *     newJob       true: a new job, never the folder's next turn (an idle
 *                  job there ends to make room; a working one is FOLDER_BUSY)
 *   The request is refused (400 REQUEST_TOO_LONG) past what fits the Mac's
 *   cap beside the note its agent reads first.
 *   201 {session, created: true, joined, deviceOnline}: a new job (edits on
 *   its own branch); 200 the same shape when the send went to this chat's
 *   job already working in that folder on that agent (joined) or was a retry.
 *   Refusals are api-errors bodies with a sentence: 400, 403 (read-only
 *   folder, a device token), 404 (not their folder or chat), 409
 *   (FOLDER_BUSY, WORKER_NOT_OFFERED, NOT_A_REPOSITORY, CODE_CLOUD_NEXT,
 *   DEVICE_REMOVED).
 * Only a signed-in person's session (requireWorkspace): never a run token
 * or a capture device's.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, readJsonBody, requireLocalAgentUser, requireLocalAgentWorkspace } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'
import { startCodeJob } from '@/lib/local-agent/code-start'
import { attachSessionActions, isUuid, listSessions } from '@/lib/local-agent/store'

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  // `code=1`: the Code view's list, every coding job of the person's in the window's workspace (it
  // needs one), each with the action it works named.
  if (params.get('code') === '1') {
    const scoped = await requireLocalAgentWorkspace(request)
    if (scoped instanceof Response) return scoped
    try {
      const svc = getServiceClient()
      const sessions = await listSessions(svc, scoped.user.id, { codeIn: scoped.workspaceId })
      return NextResponse.json({ sessions: await attachSessionActions(svc, scoped.workspaceId, sessions) })
    } catch (err) {
      return errorResponse(err, 'list code sessions')
    }
  }
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const conversationId = params.get('conversationId')
  const live = params.get('live') === '1' || params.get('live') === 'true'
  if (conversationId && !isUuid(conversationId)) return NextResponse.json({ sessions: [] })
  try {
    const sessions = await listSessions(getServiceClient(), auth.user.id, {
      ...(conversationId ? { conversationId } : {}),
      ...(live ? { live } : {}),
    })
    return NextResponse.json({ sessions })
  } catch (err) {
    return errorResponse(err, 'list sessions')
  }
}

export async function POST(request: Request) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentWorkspace(request)
  if (auth instanceof Response) return auth
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  try {
    const started = await startCodeJob(getServiceClient(), {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      conversationId: body.conversationId,
      folderId: body.folderId,
      request: body.request,
      // Absent is not "our own agent": the person always says who.
      worker: 'worker' in body ? body.worker : undefined,
      requestId: body.requestId,
      ...(body.environmentId !== undefined ? { environmentId: body.environmentId } : {}),
      ...(body.newJob === true ? { newJob: true } : {}),
      // 721: the model and effort for the person's own coding agent, when the composer offered a choice.
      ...('model' in body ? { model: body.model } : {}),
      ...('effort' in body ? { effort: body.effort } : {}),
    })
    return NextResponse.json(started, { status: started.created ? 201 : 200 })
  } catch (err) {
    return errorResponse(err, 'code start')
  }
}
