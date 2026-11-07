/**
 * The agent browser's command queue: the server-side enqueue path.
 *
 * A browser agent tool (running server-side, in-process or in eve's Nitro
 * runtime) ENQUEUES a command here (service role). The person's cloud browser
 * relay (src/lib/cloud-browser/relay) long-polls for it, claims, runs it on the
 * sandbox's Chrome and settles the row; a `wait_for_browser_command` tool polls
 * the row for the result. See migration 290 and docs/plans/cloud-browser.md (C2).
 */

import { getServiceClient } from '@/lib/supabase/service'
import type { BrowserCommandAttribution } from './attribution'
import { browserComputerTopic, type ComputerRing } from './queue-topic'

/** How long an enqueued command waits for the relay to claim it before it
 *  expires. A cold start of the browser takes 3–10 s; if it can't start, the
 *  agent should learn quickly rather than hang. */
const ENQUEUE_TTL_MS = 90 * 1000

export interface EnqueueBrowserCommand {
  userId: string
  workspaceId: string
  agentId?: string | null
  sessionId?: string | null
  /** Trusted server dispatch context; never accepted from command request JSON. */
  attribution?: BrowserCommandAttribution
  tabId?: string | null
  command: string
  request?: Record<string, unknown>
  targetOrigin?: string | null
  requiresApproval?: boolean
}

/** Insert a command row; the relay's long-poll picks it up. Returns the new row id. */
export async function enqueueBrowserCommand(
  cmd: EnqueueBrowserCommand,
): Promise<string> {
  if (['navigate', 'click', 'type'].includes(cmd.command)) {
    throw new Error('Browser actions require run_browser_task; Jev controls navigation and interaction.')
  }
  const svc = getServiceClient()
  const expiresAt = new Date(Date.now() + ENQUEUE_TTL_MS).toISOString()
  const { attribution: _untrustedAttribution, ...request } = cmd.request ?? {}
  const attribution = cmd.attribution?.workspace_id === cmd.workspaceId ? cmd.attribution : undefined

  const { data, error } = await svc
    .from('browser_command_queue')
    .insert({
      user_id: cmd.userId,
      workspace_id: cmd.workspaceId,
      agent_id: cmd.agentId ?? null,
      session_id: attribution?.eve_session_id ?? cmd.sessionId ?? null,
      tab_id: cmd.tabId ?? null,
      command: cmd.command,
      request: { ...request, ...(attribution ? { attribution } : {}) },
      target_origin: cmd.targetOrigin ?? null,
      requires_approval: cmd.requiresApproval ?? false,
      status: 'waiting_for_device',
      expires_at: expiresAt,
    })
    .select('id')
    .single()

  if (error || !data) {
    throw new Error(`failed to enqueue browser command: ${error?.message ?? 'no row'}`)
  }

  return data.id
}

/**
 * The person's windows on `workspaceId` (queue-topic.ts): show or hide the live
 * view, or read the computer again (C3). Fire-and-drop and best effort: the
 * windows read the computer again on their own, so a missed ring only waits.
 */
export async function ringComputer(ref: { userId: string; workspaceId: string }, event: ComputerRing): Promise<void> {
  const svc = getServiceClient()
  try {
    const channel = svc.channel(browserComputerTopic(ref.userId), { config: { private: true, broadcast: { ack: false } } })
    await channel.send({ type: 'broadcast', event, payload: { workspaceId: ref.workspaceId } })
    await svc.removeChannel(channel)
  } catch {
    /* the listeners' polls cover a missed ring */
  }
}

/**
 * Fail a command no browser can run (its browser could not start), unless the
 * relay already claimed it: a compare-and-set on waiting_for_device.
 */
export async function failWaitingBrowserCommand(userId: string, id: string, message: string): Promise<void> {
  await getServiceClient()
    .from('browser_command_queue')
    .update({ status: 'failed', error_message: message.slice(0, 500), finished_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .eq('status', 'waiting_for_device')
}

/** Poll a command row for a terminal result. Returns the row, or null if it's
 *  still pending. Used by the wait_for_browser_command tool.
 *
 *  LAZY REAP: a `waiting_for_device` row past its TTL (no device claimed it) or a
 *  `claimed` row past its lease (a device died before settling) is stuck forever
 *  otherwise — the tool would poll it to its own budget. Flip such a row to
 *  `expired` on read (idempotent CAS), so the tool learns fast and returns its
 *  clean "your browser didn't pick this up" message. The cron backstop handles rows
 *  nobody reads back. */
export async function readBrowserCommand(userId: string, id: string) {
  const svc = getServiceClient()
  const { data } = await svc
    .from('browser_command_queue')
    .select('id, status, result, error_message, command, tab_id, expires_at, lease_expires_at')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle()
  if (!data) return null

  const now = Date.now()
  const staleWaiting =
    data.status === 'waiting_for_device' &&
    !!data.expires_at &&
    new Date(data.expires_at).getTime() < now
  const staleClaimed =
    data.status === 'claimed' &&
    !!data.lease_expires_at &&
    new Date(data.lease_expires_at).getTime() < now
  if (staleWaiting || staleClaimed) {
    // CAS on the same status so a device settling concurrently still wins.
    const { data: reaped } = await svc
      .from('browser_command_queue')
      .update({
        status: 'expired',
        error_message: staleClaimed
          ? 'Your browser claimed this command but did not finish it (lease expired).'
          : 'Your browser did not pick up the command before it expired.',
        finished_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('user_id', userId)
      .eq('status', data.status)
      .select('id, status, result, error_message, command, tab_id')
      .maybeSingle()
    if (reaped) return reaped
    // Lost the race — re-read the now-terminal row.
    const { data: fresh } = await svc
      .from('browser_command_queue')
      .select('id, status, result, error_message, command, tab_id')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    return fresh ?? data
  }
  return data
}

/**
 * Sweep stranded rows to `expired`. The cron backstop for rows that no
 * wait_for_browser_command polls (fire-and-forget commands). Same two cases as
 * the lazy reap in readBrowserCommand, done in bulk. Returns how many it expired.
 */
export async function reapExpiredBrowserCommands(): Promise<{
  waiting: number
  claimed: number
}> {
  const svc = getServiceClient()
  const nowIso = new Date().toISOString()

  const { data: w } = await svc
    .from('browser_command_queue')
    .update({
      status: 'expired',
      error_message: 'Your browser did not pick up the command before it expired.',
      finished_at: nowIso,
    })
    .eq('status', 'waiting_for_device')
    .lt('expires_at', nowIso)
    .select('id')
  const { data: c } = await svc
    .from('browser_command_queue')
    .update({
      status: 'expired',
      error_message: 'Your browser claimed this command but did not finish it (lease expired).',
      finished_at: nowIso,
    })
    .eq('status', 'claimed')
    .lt('lease_expires_at', nowIso)
    .select('id')

  return { waiting: w?.length ?? 0, claimed: c?.length ?? 0 }
}

export const BROWSER_COMMAND_TERMINAL_STATES = [
  'completed',
  'failed',
  'denied',
  'expired',
] as const

export function isTerminalBrowserStatus(status: string): boolean {
  return (BROWSER_COMMAND_TERMINAL_STATES as readonly string[]).includes(status)
}
