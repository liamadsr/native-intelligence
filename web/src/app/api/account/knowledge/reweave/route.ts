import { requireWorkspaceMember } from '@/lib/api-auth'
import { rateLimited, serverError } from '@/lib/api-errors'
import { inngest } from '@/lib/inngest/client'
import { NextResponse } from 'next/server'

/**
 * POST /api/account/knowledge/reweave — the manual "regenerate briefs now"
 * lever (plan item 18).
 *
 * Fires the same `knowledge/weave.requested` event the nightly Vercel cron
 * emits (see /api/cron/weave), which kicks the knowledge weaver on demand.
 * The weaver ignores event data and processes every workspace with backlog,
 * serialized by its own `concurrency: [{ limit: 1 }]`, so firing it here is
 * safe and idempotent — it just means a user who dumped a batch of docs in
 * doesn't have to wait for the nightly run to see the brief refresh.
 *
 * Rate-limited naively per workspace: a second request inside the window is
 * rejected with 429 rather than queuing another whole-graph pass. The map is
 * in-memory (per server instance, resets on restart) — the same posture as
 * /api/early-access. Good enough for a manual button; the weaver's own
 * concurrency gate is the real backstop against overlap.
 */

const REWEAVE_COOLDOWN_MS = 10 * 60 * 1000 // 10 minutes
const lastRequestedByWorkspace = new Map<string, number>()

export async function POST() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const now = Date.now()
  const last = lastRequestedByWorkspace.get(workspaceId)
  if (last !== undefined && now - last < REWEAVE_COOLDOWN_MS) {
    const res = rateLimited(
      'Briefs were already queued for a refresh. Try again in a few minutes.',
    )
    res.headers.set('Retry-After', String(Math.ceil((REWEAVE_COOLDOWN_MS - (now - last)) / 1000)))
    return res
  }

  try {
    await inngest.send({ name: 'knowledge/weave.requested' })
  } catch (err) {
    console.error('[knowledge/reweave] failed to emit weave.requested:', err)
    return serverError(err instanceof Error ? err.message : 'Failed to queue reweave')
  }

  lastRequestedByWorkspace.set(workspaceId, now)

  return NextResponse.json(
    { ok: true, queued: 'knowledge/weave.requested' },
    { status: 202 },
  )
}
