import 'server-only'
import type { BrowserCommandActor } from '@/lib/browser-agent/command-handlers'
import { relayDeviceId, requireBrowserRelay } from './relay-token'
import { APP_RELAY_HOSTS } from '@/lib/app-url'
import { requestOrigin } from '@/lib/security/same-origin'

/**
 * Shared by the relay routes (src/app/api/browser-relay/*; docs/plans/cloud-browser.md
 * C2): the relay's actor, from its token alone. One user, one workspace, and
 * the device is its sandbox.
 */
export function relayActor(request: Request): BrowserCommandActor | Response {
  const claims = requireBrowserRelay(request)
  if (claims instanceof Response) return claims
  return { userId: claims.userId, workspaceId: claims.workspaceId, deviceId: relayDeviceId(claims) }
}

/**
 * The relay host `request` was sent to, when it is one of the app's own
 * (`browser-relay.` on either of its domains), else null. A running relay
 * keeps calling the host it was started with, which is the other domain's
 * for a while after the app's address moves: a firewall rule set again for
 * that relay (the exit switch) must keep naming the host it calls.
 */
export function relayOriginCalled(request: Request): string | null {
  const origin = requestOrigin(request)
  try {
    return origin && origin.startsWith('https://') && APP_RELAY_HOSTS.includes(new URL(origin).hostname) ? origin : null
  } catch {
    return null
  }
}

/** The app build the relay must match; a relay from another build is told to restart. */
export const relayAppVersion = () => process.env.VERCEL_GIT_COMMIT_SHA || 'dev'
