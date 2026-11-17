import 'server-only'
import { NextResponse } from 'next/server'
import { siteForUrl } from '@/lib/browser-agent/blocked-sites'
import type { BrowserCommandActor } from '@/lib/browser-agent/command-handlers'
import { browserTaskSchema } from '@/lib/browser-agent/task-contract'
import { createToolApproval } from '@/lib/safety/approvals'
import { getServiceClient } from '@/lib/supabase/service'

/**
 * A browser task reached a sign-in page (browser-agent/sign-in-page.ts). The
 * agent never types a password or a code and we store none, so the person
 * signs in themselves, in their own browser's live view: this raises a card
 * for that, in the chat that asked for the task (or the person's home
 * thread). The card's button opens the browser with them driving; handing it
 * back, or saying they are signed in, replays run_browser_task as it was asked, in the same
 * tab. The task that asked has stopped (`needs_sign_in`).
 *
 * The replay carries no grant: it is the person's own request again, and
 * every step of it is checked as the first run's was. A replay that still
 * finds the sign-in page raises a new card. Only the relay holding the task's
 * lease may ask, and the card names the site from the address alone: nothing
 * the page says is shown.
 */
/**
 * The card's words: what the agent was doing (the task's goal, the person's own
 * request as the agent passed it on, cut short) and what happens next. Pure.
 */
export function signInCardWhy(goal: string): string {
  const doing = goal.replace(/\s+/g, ' ').trim()
  const short = doing.length > 140 ? `${doing.slice(0, 139).trimEnd()}…` : doing
  return `I was working on "${short}" and it asked me to sign in. I never type passwords, so sign in yourself and I'll pick up where I stopped.`
}

export async function requestBrowserSignIn(actor: BrowserCommandActor, id: string, request: Request): Promise<Response> {
  let body: { url?: unknown; tabId?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  const site = typeof body.url === 'string' && body.url.length <= 4000 && /^https?:\/\//i.test(body.url) ? siteForUrl(body.url) : null
  if (!site) return NextResponse.json({ error: 'Invalid sign-in page' }, { status: 400 })

  const svc = getServiceClient()
  const { data: row } = await svc.from('browser_command_queue').select('id, command, request, workspace_id, lease_expires_at')
    .eq('id', id).eq('user_id', actor.userId).eq('workspace_id', actor.workspaceId).eq('claimed_by_device_id', actor.deviceId)
    .eq('status', 'claimed').eq('command', 'run_task').gt('lease_expires_at', new Date().toISOString()).maybeSingle()
  const task = browserTaskSchema.safeParse(row?.request?.task)
  if (!row || !task.success) return NextResponse.json({ error: 'Task is no longer authorized' }, { status: 409 })

  // The replay is the same task, in the tab the person signs in on.
  const tabId = typeof body.tabId === 'string' && body.tabId.length <= 200 ? body.tabId : undefined
  const input = { goal: task.data.goal, ...(task.data.startUrl ? { startUrl: task.data.startUrl } : {}),
    completion: task.data.completion, ...(tabId ? { tab_id: tabId } : {}) }
  const conversationId = typeof row.request?.attribution?.conversation_id === 'string' ? row.request.attribution.conversation_id : null
  const held = await createToolApproval(svc, {
    door: 'chat', userId: actor.userId, workspaceId: row.workspace_id, toolName: 'run_browser_task', sideEffect: 'external-write',
    input, conversationId, context: { browserSignIn: { site } }, reason: 'browser_sign_in',
    card: {
      title: `${site} needs you to sign in`.slice(0, 200),
      why: signInCardWhy(task.data.goal),
    },
  })
  if (!held.ok) return NextResponse.json({ error: held.error, code: held.code }, { status: held.code === 'TOO_MANY_PENDING' ? 429 : 409 })
  return NextResponse.json({ approvalId: held.approvalId })
}
