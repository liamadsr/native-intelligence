import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'

export const maxDuration = 30

/**
 * GET /api/cron/inngest-sync
 *
 * Half-hourly self-sync of the Inngest function registry. The Vercel↔Inngest
 * integration does NOT reliably re-register the app on production deploys:
 * after the 2026-06-12 deploy the knowledge-weaver cron silently never ran, and
 * the 2026-10-15 request logs show no deploy-time PUT to /api/inngest at all
 * across two production deploys. A deploy that adds a function (captureIngest
 * did) would otherwise never fire it. A stale registry has no error surface
 * anywhere: functions just don't run.
 *
 * This cron closes that hole from Vercel's scheduler (independent of Inngest's
 * registration state, same rationale as /api/cron/weave): it PUTs the app's
 * own /api/inngest, which is inngest/next's self-registration handshake.
 *
 * The PUT deliberately targets the CANONICAL production URL — Inngest records
 * the host the registration request arrives on, so registering a
 * deployment-specific *.vercel.app URL would pin Inngest to a deployment that
 * goes stale on the next deploy. `VERCEL_PROJECT_PRODUCTION_URL` is the
 * project's production domain (custom domain when one exists).
 *
 * `modified` is NOT a drift signal, so it is passed through and never logged.
 * This route used to warn "registry was STALE" on `modified: true`, and it
 * fired on every run (48 of 48 on 2026-10-15), including runs on the same
 * deployment with nothing else syncing: this cron's PUTs are the only
 * `/api/inngest` PUTs in the prod and preview request logs, and the register
 * body inngest/next sends is byte-identical run to run (captured and diffed:
 * same url, same 60 function configs, no deploy id, no timestamp). Inngest
 * Cloud answers `modified: true` to every out-of-band sync of an unchanged
 * app, so the warning was noise that buried real failures. A failed
 * registration (non-2xx, or the request itself failing) stays loud below.
 *
 * Vercel cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  // Fails CLOSED on an unset secret (see requireCronSecret).
  const denied = requireCronSecret(request)
  if (denied) return denied

  // Vercel crons only run on production, but guard anyway: a preview
  // deployment must never register ITSELF as the app's URL.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return NextResponse.json({ ok: true, skipped: `env ${process.env.VERCEL_ENV}` })
  }

  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || 'dial8.ai'
  const registerUrl = `https://${host}/api/inngest`

  try {
    const res = await fetch(registerUrl, { method: 'PUT' })
    const body = (await res.json().catch(() => null)) as
      | { message?: string; modified?: boolean }
      | null

    if (!res.ok) {
      console.error(`[inngest-sync] registration failed: ${res.status}`, body)
      return NextResponse.json(
        { error: `registration failed: ${res.status}` },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, url: registerUrl, modified: body?.modified ?? false })
  } catch (err) {
    console.error('[inngest-sync] registration request failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'sync failed' },
      { status: 502 },
    )
  }
}
