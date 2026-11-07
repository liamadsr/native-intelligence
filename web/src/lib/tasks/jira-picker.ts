/**
 * Shared plumbing for the Jira destination-picker proxy routes
 * (/api/account/jira/{sites,projects,issue-types,statuses}).
 *
 * The browser never talks to Atlassian directly — it would need the access
 * token. Instead each picker route resolves the workspace's connected account,
 * mints a fresh token server-side, and proxies one read. This module owns the
 * two halves every one of those routes repeats: resolving the token, and turning
 * a Jira failure into the route's error contract.
 *
 * Sibling of asana-picker.ts, with the SAME error codes on purpose — the
 * settings UI branches on `not_connected` / `reconnect_required` generically, so
 * a second provider that invented its own vocabulary would need its own banner.
 *
 * Note what this deliberately does NOT resolve: the cloudId. It is per-
 * destination config, and the very first picker (sites) exists to discover it,
 * so routes take it as a query param instead.
 */
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import {
  JiraInvalidIdentifierError,
  JiraUnauthorizedError,
} from '@/lib/integrations/jira-api'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { loadJiraSyncState } from './jira-config'

/**
 * Resolve a usable Jira access token for a workspace.
 *
 * Returns the token, or a Response to hand straight back:
 *   - no task_sync_state row → 400 `not_connected`
 *   - row present but the token can't be refreshed → 400 `reconnect_required`.
 *     For Jira that covers one more case than it does for Asana: Atlassian
 *     rotates the refresh token on every use and kills it after 90 days of
 *     inactivity, so `invalid_grant` (a lost rotation, a revoked app, a password
 *     change) all surface here as the same reconnect.
 */
export async function requireJiraToken(
  workspaceId: string,
): Promise<{ token: string; accountId: string } | Response> {
  const state = await loadJiraSyncState(workspaceId)
  if (!state) {
    return apiError('Jira is not connected for this workspace', {
      status: 400,
      code: 'not_connected',
    })
  }

  const resolved = await getValidTokenForAccount(state.accountId)
  if (!resolved) {
    return apiError('Reconnect Jira to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }

  return { token: resolved.token, accountId: state.accountId }
}

/**
 * Map an error thrown by the Jira client into a route response.
 *
 * A 401 is the one failure the UI can act on — it means the stored token is no
 * longer accepted (revoked app, changed password, scope removed), and the fix is
 * always the same reconnect. It surfaces as a 400 with code 'reconnect_required'
 * rather than a bare 401 so it can't be confused with the CALLER's session being
 * unauthenticated. Everything else is a 500.
 */
export function jiraErrorResponse(err: unknown, context: string): Response {
  if (err instanceof JiraUnauthorizedError) {
    return apiError('Reconnect Jira to continue', {
      status: 400,
      code: 'reconnect_required',
    })
  }
  // A malformed identifier is the CALLER's mistake — these routes take `cloudId`
  // (and `projectId`) straight from the query string — so it is a 400, not the
  // 500 the catch-all would otherwise produce.
  if (err instanceof JiraInvalidIdentifierError) {
    return badRequest(err.message)
  }
  console.error(`[jira-picker] ${context} failed:`, err)
  return serverError(err instanceof Error ? err.message : `Failed to ${context}`)
}
