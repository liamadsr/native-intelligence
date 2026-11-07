import 'server-only'
import { NextResponse } from 'next/server'
import type { BrowserCommandActor } from '@/lib/browser-agent/command-handlers'
import { browserApprovalStep } from '@/lib/browser-agent/approval-grant'
import { browserTaskSchema } from '@/lib/browser-agent/task-contract'
import { createToolApproval } from '@/lib/safety/approvals'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * A browser task reached a sensitive step (docs/plans/cloud-browser.md, C2):
 * raise an approval card for exactly that step, in the chat that asked for the
 * task (or the person's home thread). Accepting replays run_browser_task with
 * a grant for that step (approval-grant.ts); the task that asked has stopped.
 * Only the relay holding the task's lease may ask.
 */
export async function requestBrowserApproval(actor: BrowserCommandActor, id: string, request: Request): Promise<Response> {
  let body: { summary?: unknown; tabId?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const step = typeof body.summary === 'string' && body.summary.length <= 2000 ? browserApprovalStep(body.summary) : null
  if (!step) return NextResponse.json({ error: 'Invalid approval step' }, { status: 400 })

  const svc = getServiceClient()
  const { data: row } = await svc.from('browser_command_queue').select('id, command, request, workspace_id, lease_expires_at')
    .eq('id', id).eq('user_id', actor.userId).eq('workspace_id', actor.workspaceId).eq('claimed_by_device_id', actor.deviceId)
    .eq('status', 'claimed').eq('command', 'run_task').gt('lease_expires_at', new Date().toISOString()).maybeSingle()
  const task = browserTaskSchema.safeParse(row?.request?.task)
  if (!row || !task.success) return NextResponse.json({ error: 'Task is no longer authorized' }, { status: 409 })

  // The replay is the same task, continuing in the tab where the step is.
  const tabId = typeof body.tabId === 'string' && body.tabId.length <= 200 ? body.tabId : undefined
  const input = { goal: task.data.goal, ...(task.data.startUrl ? { startUrl: task.data.startUrl } : {}),
    completion: task.data.completion, ...(tabId ? { tab_id: tabId } : {}) }
  const conversationId = typeof row.request?.attribution?.conversation_id === 'string' ? row.request.attribution.conversation_id : null
  const host = new URL(step.origin).host
  const held = await createToolApproval(svc, {
    door: 'chat', userId: actor.userId, workspaceId: row.workspace_id, toolName: 'run_browser_task', sideEffect: 'external-write',
    input, conversationId, context: { browser: step }, reason: 'browser_sensitive_step',
    card: {
      title: `${step.target} on ${host}`.slice(0, 200),
      why: `Your browser task reached this step on ${host}, and it needs your OK. Accept and the task runs again, and this one step goes through.`,
    },
  })
  if (!held.ok) return NextResponse.json({ error: held.error, code: held.code }, { status: held.code === 'TOO_MANY_PENDING' ? 429 : 409 })
  return NextResponse.json({ approvalId: held.approvalId })
}
