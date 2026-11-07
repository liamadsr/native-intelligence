import { requireUser } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { trackServerEvent, type ProductEvent } from '@/lib/posthog'
import { HUD_TELEMETRY_EVENTS } from '@/lib/hud-telemetry'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/analytics/hud-event
 *
 * Durable sink for the live HUD's telemetry (lib/hud-telemetry.ts), emitted
 * from the desktop's recording window (hooks/use-agent-nudge-relay.ts) and the
 * HUD itself (app/hud/agent, components/live-hud). These exist so "did the
 * agent's nudge show on the HUD?" is answerable from PostHog — the 2026-10-19
 * Owen call could only be guessed at.
 *
 * Same contract as /api/analytics/recording-event: server-side so the event
 * lands on the same person/workspace profile as every other product event,
 * an allowlist so a client can't fire arbitrary product events through it,
 * scalar properties only, and fail-soft. Auth is requireUser's, so the HUD
 * window's Bearer counts when its cookie is stale.
 *
 * The workspace is the body's when it says one (null included: the HUD window
 * says null until it knows its call's, since its header can be another
 * window's), else the `x-workspace-id` header workspace-fetch adds. It only
 * groups the event, so it is taken as a UUID and not checked against
 * membership (like recording-event's). Property keys are plain snake_case and
 * never the server's own (`platform`, `environment`, `workspace_id`, or a
 * PostHog `$` key), so a client can't overwrite what trackServerEvent sets.
 */

// One list for the client's events and this allowlist (lib/hud-telemetry.ts);
// typed as ProductEvent, so a HUD event missing from the taxonomy won't compile.
const ALLOWED: ReadonlySet<ProductEvent> = new Set<ProductEvent>(HUD_TELEMETRY_EVENTS)

/** Caps on what one event may carry: these are ids, kinds and flags, never content. */
const MAX_PROPERTIES = 24
const MAX_STRING_LENGTH = 200

const PROPERTY_KEY = /^[a-z][a-z0-9_]{0,63}$/
const RESERVED_KEYS: ReadonlySet<string> = new Set(['platform', 'environment', 'workspace_id'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let body: { event?: string; workspaceId?: string | null; properties?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON')
  }

  const event = body?.event as ProductEvent | undefined
  if (!event || !ALLOWED.has(event)) return badRequest('Unknown event')

  const props: Record<string, unknown> = {}
  if (body.properties && typeof body.properties === 'object') {
    for (const [k, v] of Object.entries(body.properties)) {
      if (Object.keys(props).length >= MAX_PROPERTIES) break
      if (!PROPERTY_KEY.test(k) || RESERVED_KEYS.has(k)) continue
      if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) props[k] = v
      else if (typeof v === 'string') props[k] = v.slice(0, MAX_STRING_LENGTH)
    }
  }

  const claimed = 'workspaceId' in body ? body.workspaceId : request.headers.get('x-workspace-id')
  const workspaceId = typeof claimed === 'string' && UUID.test(claimed) ? claimed : null

  trackServerEvent(event, { userId: user.id, workspaceId, email: user.email }, props)

  return NextResponse.json({ tracked: true })
}
