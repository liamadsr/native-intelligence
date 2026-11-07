/**
 * Where the public sky shows: every page outside the signed-in app, so a new
 * public page gets it with no change here. The exceptions, and why:
 *  - /account, /admin: their own shells (the dashboard mounts the app's sky).
 *  - /hud: the desktop app's transparent overlay windows.
 *  - /auth, /oauth-popup-callback, /mcp-oauth-popup-callback, /mcp (the MCP
 *    consent popup), /sign-out: callbacks, popups and redirects.
 *  - /welcome: the post-sign-in handoff to the desktop app, its own black screen.
 *  - /s: a shared capture or document, read like the app's content.
 *  - /dev: developer tools.
 *  - /api: not pages.
 */

const EXCLUDED = [
  '/account',
  '/admin',
  '/hud',
  '/auth',
  '/oauth-popup-callback',
  '/mcp-oauth-popup-callback',
  '/mcp',
  '/sign-out',
  '/welcome',
  '/s',
  '/dev',
  '/api',
] as const

/** Whether the public sky belongs behind the page at `pathname`. */
export function publicSkyShowsOn(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return !EXCLUDED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
