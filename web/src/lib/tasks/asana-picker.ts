/**
 * Shared plumbing for the Asana destination-picker proxy routes
 * (/api/account/asana/{workspaces,projects,sections}).
 *
 * The browser never talks to Asana directly — it would need the access token.
 * Instead each picker route resolves the workspace's connected account, mints a
 * fresh token server-side, and proxies one read. This module owns the two
 * halves every one of those routes repeats: resolving the token, and turning an
 * Asana failure into the route's error contract.
 */
import { apiError, serverError } from '@/lib/api-errors'
import { AsanaUnauthorizedError } from '@/lib/integrations/asana-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadAsanaSyncState } from './asana-config'

/**
 * Resolve a usable Asana access token for a workspace.
 *
 * Returns the token, or a Response to hand straight back:
 *   - no task_sync_state row → 400 `not_connected`
 *   - row present but the token can't be refreshed → 400 `reconnect_required`
 *     (a dead refresh token is indistinguishable from a revoked app, and both
 *     are fixed by the same reconnect).
 */
export async function requireAsanaToken(
  workspaceId: string,
): Promise<{ token: string; accountId: string } | Response> {
  const state = await loadAsanaSyncState(workspaceId)
  if (!state) {
    return apiError('Asana is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  const resolved = await getValidTokenForAccount(state.accountId)
  if (!resolved) {
    return apiError('Reconnect Asana to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }

  return { token: resolved.token, accountId: state.accountId }
}

/**
 * Map an error thrown by the Asana client into a route response.
 *
 * A 401 is the one failure the UI can act on — it means the stored token is no
 * longer accepted (revoked app, changed password, scope removed), and the fix is
 * always the same reconnect. It surfaces as a 400 with code 'reconnect_required'
 * rather than a bare 401 so it can't be confused with the CALLER's session being
 * unauthenticated. Everything else is a 500.
 */
export function asanaErrorResponse(err: unknown, context: string): Response {
  if (err instanceof AsanaUnauthorizedError) {
    return apiError('Reconnect Asana to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }
  console.error(`[asana-picker] ${context} failed:`, err)
  return serverError(err instanceof Error ? err.message : `Failed to ${context}`)
}
