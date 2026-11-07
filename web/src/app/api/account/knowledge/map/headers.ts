/**
 * Shared response headers for the three Knowledge Map routes.
 *
 * Every map response is per WORKSPACE and per VIEWER (§3: the map is built only
 * from rows that viewer's RLS lets through), so it must never be stored by a
 * shared cache. `Vary` names the three inputs that select the identity: the
 * session cookie, a Bearer token (desktop/device auth), and the workspace
 * header the desktop app sends when several windows point at different
 * workspaces — without it a proxy could hand window B the map of window A.
 */
export const MAP_HEADERS: Record<string, string> = {
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie, Authorization, x-workspace-id',
}
