import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { relayActor } from '@/lib/cloud-browser/relay-routes'
import { markSite } from '@/lib/cloud-browser/site-memory'

/**
 * POST /api/browser-relay/site-memory  { url, kind: 'blocked' | 'agent_ban', reason? }
 *
 * The relay met a page that turned its browser away (docs/plans/cloud-browser.md,
 * C4): `blocked` on the cloud exit means the site needs the person's Mac from
 * now on; `agent_ban` means the site forbids agents, and the agent never uses
 * it again. For the token's own person only.
 */
export async function POST(request: Request) {
  const actor = relayActor(request)
  if (actor instanceof Response) return actor
  let body: { url?: unknown; kind?: unknown; reason?: unknown } = {}
  try { body = await request.json() } catch { /* checked below */ }
  if (typeof body.url !== 'string' || (body.kind !== 'blocked' && body.kind !== 'agent_ban')) return badRequest('url and kind (blocked or agent_ban) are required')
  const flag = body.kind === 'agent_ban' ? 'never_automate' : 'needs_home'
  const reason = typeof body.reason === 'string' ? body.reason : body.kind
  try {
    if (!(await markSite(actor.userId, body.url, flag, reason))) return badRequest('not a site')
  } catch (error) {
    console.error('[cloud-browser] site memory:', error instanceof Error ? error.message : error)
    return apiError('Could not remember the site', { status: 500, code: 'INTERNAL' })
  }
  return NextResponse.json({ ok: true })
}
