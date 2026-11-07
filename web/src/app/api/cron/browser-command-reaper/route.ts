/**
 * GET /api/cron/browser-command-reaper — expire stranded browser commands.
 *
 * The browser command queue (migration 290) is drained by the cloud browser's
 * relay in seconds (docs/plans/cloud-browser.md), and every row a `wait_for_browser_command` tool polls is
 * reaped lazily on read (see readBrowserCommand). This cron is the BACKSTOP for
 * the rows nobody reads back — a fire-and-forget command whose browser never came
 * up, or a relay that claimed a row and died before settling. Without it
 * those rows sit at `waiting_for_device` / `claimed` forever.
 *
 * It only ever flips a stranded row to `expired` (a terminal state); it never
 * touches a completed/failed/denied row or a still-live one within its TTL/lease.
 * Idempotent: a run that finds nothing stranded is a no-op. Cheap enough to run
 * often because the TTL is 90s — a few-minutes cadence keeps orphans from
 * lingering without competing with the relay's own fast settle.
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { reapExpiredBrowserCommands } from '@/lib/browser-agent/queue'

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    const { waiting, claimed } = await reapExpiredBrowserCommands()
    return NextResponse.json({ ok: true, expired: { waiting, claimed } })
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
