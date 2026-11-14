/**
 * GET /api/local-agent/agent/tools — the Native Intelligence tools of a job that runs on
 * the person's own coding agent (board step 4, src/lib/local-agent/worker-tools.ts).
 *
 * The desktop fetches it at each launch of a job with a worker and writes it
 * where the adapter reads it; each call then travels agent → adapter →
 * desktop → POST /api/local-agent/agent/tool. Only the desktop talks here,
 * with the job's session token (`la1.…`, the one it holds for the
 * pull-request route): authorizeMacBody's checks, then the session must have
 * a worker (Native Intelligence's own agent reads its tools from the spec route:
 * 409 NOT_A_WORKER_JOB).
 *
 * Answers, exactly (the adapter validates it):
 *   { "version": 1,
 *     "instructions": "<at most 4,000 characters>",
 *     "tools": [ { "name", "description", "inputSchema": <JSON Schema, type object> } ] }
 * at most 64 tools, names `^[a-z][a-z0-9_]{0,63}$`: the PINNED board tools
 * inside the job's ceiling (macWorkerCeiling, which the tool route enforces
 * call by call), then `search_tools` and `call_tool`, through which the
 * agent reaches the rest of the ceiling.
 */
import { NextResponse } from 'next/server'
import { apiError, conflict } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { resolveChatCeiling } from '@/lib/chat/chat-ceiling'
import { authorizeMacBody, macWorkerCeiling } from '@/lib/local-agent/agent-access'
import { unattendedToolReview } from '@/lib/local-agent/agent-seams'
import { actionIdOfJobKey } from '@/lib/local-agent/store'
import { NOT_A_WORKER_JOB_CODE, WORKER_TOOLS_VERSION, workerInstructions, workerToolEntries, type WorkerCard } from '@/lib/local-agent/worker-tools'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const svc = getServiceClient()
  const body = await authorizeMacBody(request, svc)
  if (body instanceof Response) return body
  const worker = body.session.worker
  if (!worker) {
    return conflict('This job runs Native Intelligence’s own agent: its tools come with its spec.', undefined, NOT_A_WORKER_JOB_CODE)
  }
  try {
    // The caller class the tool route will use (a loop's job is unattended).
    const unattended = await unattendedToolReview(svc, { userId: body.session.userId, sessionId: body.session.id })
    if (unattended && 'refused' in unattended) return apiError(unattended.reason, { status: 403, code: unattended.code })
    const caller = unattended ? unattended.caller : body.caller
    const chatCeiling = await resolveChatCeiling(svc, { workspaceId: body.session.workspaceId, agentToolCeiling: null, externalMcpToolNames: [] })
    const ceiling = macWorkerCeiling(chatCeiling, [], { caller, localModel: body.session.localModel })
    const tools = workerToolEntries(ceiling)
    const [workspaceName, card] = await Promise.all([readWorkspaceName(svc, body.session.workspaceId), readCard(svc, body.session.id, body.session.workspaceId)])
    return NextResponse.json({
      version: WORKER_TOOLS_VERSION,
      instructions: workerInstructions({ workspaceName, card, worker, tools: tools.map((t) => t.name) }),
      tools,
    })
  } catch (err) {
    console.error('[local-agent] worker tools failed:', err instanceof Error ? err.message : err)
    return apiError('Could not list the tools just now. Try again.', { status: 503, code: 'UNAVAILABLE' })
  }
}

async function readWorkspaceName(svc: ReturnType<typeof getServiceClient>, workspaceId: string): Promise<string | null> {
  const { data } = await svc.from('workspace').select('name').eq('id', workspaceId).maybeSingle()
  const name = (data as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.trim() ? name : null
}

/** The card the job works on (its key names it; the action is read in the job's workspace), or null. */
async function readCard(svc: ReturnType<typeof getServiceClient>, sessionId: string, workspaceId: string): Promise<WorkerCard | null> {
  const { data: row, error } = await svc.from('local_agent_session').select('idempotency_key').eq('id', sessionId).maybeSingle()
  if (error) throw new Error(error.message)
  const actionId = actionIdOfJobKey((row as { idempotency_key?: string | null } | null)?.idempotency_key)
  if (!actionId) return null
  const { data: action, error: actionError } = await svc
    .from('actions')
    .select('id, identifier, title')
    .eq('id', actionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (actionError) throw new Error(actionError.message)
  const a = action as { id: string; identifier?: string | null; title?: string | null } | null
  return a ? { id: a.id, identifier: a.identifier ?? null, title: a.title ?? null } : null
}
