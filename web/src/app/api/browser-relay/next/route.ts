import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/supabase/service'
import { relayActor, relayAppVersion } from '@/lib/cloud-browser/relay-routes'
import { readDriver } from '@/lib/cloud-browser/store'

export const maxDuration = 30

/** The relay waits this long for a command before asking again. */
const LONG_POLL_MS = 25_000
const POLL_EVERY_MS = 1000

/**
 * GET /api/browser-relay/next?v=<relay build>
 *
 * The cloud browser relay's long-poll (docs/plans/cloud-browser.md, C2): the
 * oldest command waiting for this person's browser in this workspace, or null
 * after ~25 s. A relay from another app build gets 426 and restarts with the
 * current one. Polling is not activity: only a claim keeps the browser up.
 * Each answer says who drives the browser now (C4: the person's session keeps
 * the Mac's address while they drive).
 */
export async function GET(request: Request) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  if (new URL(request.url).searchParams.get('v') !== relayAppVersion())
    return NextResponse.json({ error: 'relay out of date', version: relayAppVersion() }, { status: 426 })
  const db = getServiceClient()
  const until = Date.now() + LONG_POLL_MS
  for (;;) {
    const { data, error } = await db.from('browser_command_queue').select('id, command')
      .eq('user_id', actor.userId).eq('workspace_id', actor.workspaceId).eq('status', 'waiting_for_device')
      .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (data || Date.now() + POLL_EVERY_MS >= until || request.signal.aborted) {
      const driver = await readDriver({ userId: actor.userId, workspaceId: actor.workspaceId }).catch(() => 'agent' as const)
      return NextResponse.json({ command: data ?? null, driver })
    }
    await new Promise(resolve => setTimeout(resolve, POLL_EVERY_MS))
  }
}
