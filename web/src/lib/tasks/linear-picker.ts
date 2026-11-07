/**
 * Shared plumbing for the Linear destination-picker proxy routes
 * (/api/account/linear/{teams,projects,states}).
 *
 * The browser never talks to Linear directly — it would need the access token.
 * Instead each picker route resolves the workspace's connected account, mints a
 * fresh token server-side, and proxies one read. This module owns the two halves
 * every one of those routes repeats: resolving the token, and turning a Linear
 * failure into the route's error contract.
 *
 * Sibling of jira-picker.ts and asana-picker.ts, with the SAME error codes on
 * purpose — the settings UI branches on `not_connected` / `reconnect_required`
 * generically, so a third provider that invented its own vocabulary would need
 * its own banner.
 *
 * Note what this has no equivalent of: Jira's cloudId. Linear has one API
 * endpoint and a token belongs to exactly one organization, so there is nothing
 * to address a call to and no "sites" picker to discover it with. The first
 * picker is teams.
 */
import { apiError, serverError } from '@/lib/api-errors'
import { LinearUnauthorizedError } from '@/lib/integrations/linear-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadLinearSyncState } from './linear-config'

/**
 * Resolve a usable Linear access token for a workspace.
 *
 * Returns the token, or a Response to hand straight back:
 *   - no task_sync_state row → 400 `not_connected`
 *   - row present but the token can't be refreshed → 400 `reconnect_required`.
 *     Linear rotates its refresh token on every use, so a lost rotation (or a
 *     revoked app) lands here as the same reconnect Jira's `invalid_grant` does.
 */
export async function requireLinearToken(
  workspaceId: string,
): Promise<{ token: string; accountId: string } | Response> {
  const state = await loadLinearSyncState(workspaceId)
  if (!state) {
    return apiError('Linear is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  const resolved = await getValidTokenForAccount(state.accountId)
  if (!resolved) {
    return apiError('Reconnect Linear to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }

  return { token: resolved.token, accountId: state.accountId }
}

/**
 * Map an error thrown by the Linear client into a route response.
 *
 * A rejected token is the one failure the UI can act on — it means the stored
 * credentials are no longer accepted (revoked app, removed scope), and the fix
 * is always the same reconnect. It surfaces as a 400 with code
 * 'reconnect_required' rather than a bare 401 so it can't be confused with the
 * CALLER's session being unauthenticated. Everything else is a 500.
 *
 * There is no malformed-identifier case to handle here (jira-picker's third
 * branch): Linear ids travel as GraphQL variables, never interpolated into a URL
 * or a query string, so a hostile value is inert and simply fails to match.
 */
export function linearErrorResponse(err: unknown, context: string): Response {
  if (err instanceof LinearUnauthorizedError) {
    return apiError('Reconnect Linear to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }
  console.error(`[linear-picker] ${context} failed:`, err)
  return serverError(err instanceof Error ? err.message : `Failed to ${context}`)
}
