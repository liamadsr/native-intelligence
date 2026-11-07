import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { requireCronSecret } from '@/lib/api-auth'

/**
 * POST /api/cron/mcp-cleanup — Daily housekeeping for all MCP-related tables.
 *
 * Covers BOTH directions:
 *  - Inbound (clients connecting TO Dial8): mcp_auth_code, mcp_oauth_token
 *  - Outbound (Dial8 connecting TO external servers): external_mcp_oauth_state
 *
 * Schedule: daily via Vercel cron at 03:00 UTC. Vercel's scheduler always
 * issues GET with `Authorization: Bearer ${CRON_SECRET}`, so the handler is
 * exported as GET. POST is aliased below so manual curl-triggering still works.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  // Inbound: delete expired/consumed auth codes (older than 10 minutes)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  const { count: codesDeleted } = await supabase
    .from('mcp_auth_code')
    .delete({ count: 'exact' })
    .lt('created_at', tenMinutesAgo)

  // Inbound: delete tokens that expired more than 30 days ago.
  // Keep recently-expired tokens so refresh can still work within a window.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { count: tokensDeleted } = await supabase
    .from('mcp_oauth_token')
    .delete({ count: 'exact' })
    .lt('expires_at', thirtyDaysAgo)

  // Outbound: delete any expired external-MCP OAuth state rows. The
  // happy-path callback consumes its own row, but an abandoned flow
  // (user closed the popup, browser crashed) leaves a row behind. With
  // the atomic delete-on-callback's TTL filter, expired rows are also
  // intentionally not consumed — so they accumulate without this sweep.
  const nowIso = new Date().toISOString()
  const { count: oauthStatesDeleted } = await supabase
    .from('external_mcp_oauth_state')
    .delete({ count: 'exact' })
    .lt('expires_at', nowIso)

  return NextResponse.json({
    success: true,
    auth_codes_deleted: codesDeleted ?? 0,
    expired_tokens_deleted: tokensDeleted ?? 0,
    external_oauth_states_deleted: oauthStatesDeleted ?? 0,
  })
}

// Allow manual curl-triggering via POST too (same handler, same bearer check).
export const POST = GET
