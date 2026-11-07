/**
 * Connected apps' sign-ins, renewed ahead of their expiry (GEN-1171).
 *
 * Hourly: every enabled OAuth MCP server whose access token expires before
 * the next run (or already has) is refreshed through the one refresh path
 * (src/lib/mcp-client/token-refresh.ts: the stored row, its lease, the
 * compare-and-swap save). So a sign-in the provider has dropped is found
 * here, marked and told to the person once (the mark's notice), rather than
 * when a tool call fails; and a refresh token that lapses when unused stays
 * alive. A failure for now (a 5xx, a timeout) leaves the status alone and
 * waits for the next run or call.
 *
 * Flat cost: one read, then one token request per due server (at most
 * KEEPALIVE_MAX), a few at a time. A server already marked is skipped.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/supabase/service'
import { ensureFreshAccessToken, McpTokenExpiredError, type TokenRefreshDeps } from '@/lib/mcp-client/token-refresh'
import type { ConnectedMcpServerRow } from '@/lib/mcp-client/types'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'

/** Renew a token expiring within this window: past the next hourly run, with room to spare. */
export const KEEPALIVE_WINDOW_MS = 75 * 60_000
/** The most servers one run renews (the earliest expiries first); a later run takes the rest. */
export const KEEPALIVE_MAX = 200
/** How many renew at once. */
const KEEPALIVE_PARALLEL = 4

export interface KeepaliveResult {
  due: number
  renewed: number
  needsReconnect: number
  failed: number
}

type Supabase = ReturnType<typeof getServiceClient>

export async function keepMcpTokensFresh(
  supabase: Supabase,
  deps: TokenRefreshDeps & { nowMs?: number } = {},
): Promise<KeepaliveResult> {
  const nowMs = deps.nowMs ?? Date.now()
  const result: KeepaliveResult = { due: 0, renewed: 0, needsReconnect: 0, failed: 0 }
  const read = (skipMarked: boolean) => {
    const query = supabase
      .from('connected_mcp_server')
      .select('*')
      .eq('auth_type', 'oauth2')
      .eq('is_enabled', true)
      .not('refresh_token_encrypted', 'is', null)
      .lt('token_expires_at', new Date(nowMs + KEEPALIVE_WINDOW_MS).toISOString())
    // Marked ones wait for the person, and in the query: they keep the oldest
    // expiry, so left to the limit they would crowd out every healthy one.
    return (skipMarked ? query.is('reauth_required_at', null) : query).order('token_expires_at', { ascending: true }).limit(KEEPALIVE_MAX)
  }
  let { data, error } = await read(true)
  // Before migration 451 there is no mark to skip.
  if (error && isMissingColumnError(error, 'reauth_required_at')) ({ data, error } = await read(false))
  if (error) throw new Error(`connected_mcp_server read failed: ${error.message}`)
  const due = ((data ?? []) as ConnectedMcpServerRow[]).filter((s) => !s.reauth_required_at)
  result.due = due.length

  const queue = [...due]
  const worker = async () => {
    for (let server = queue.shift(); server; server = queue.shift()) {
      try {
        const after = await ensureFreshAccessToken(server, { leewayMs: KEEPALIVE_WINDOW_MS }, { supabase, ...deps })
        if (after.access_token_encrypted !== server.access_token_encrypted) result.renewed++
      } catch (err) {
        if (err instanceof McpTokenExpiredError) result.needsReconnect++
        else result.failed++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(KEEPALIVE_PARALLEL, due.length) }, worker))
  return result
}

export const mcpTokenKeepalive = inngest.createFunction(
  {
    id: 'mcp-token-keepalive',
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ cron: '41 * * * *' }],
  },
  async ({ step }) =>
    step.run('renew-due-tokens', async () => {
      const result = await keepMcpTokensFresh(getServiceClient())
      console.log('[mcp-token-keepalive]', JSON.stringify(result))
      return result
    }),
)
