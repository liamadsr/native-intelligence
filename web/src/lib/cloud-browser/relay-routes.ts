import 'server-only'
import type { BrowserCommandActor } from '@/lib/browser-agent/command-handlers'
import { relayDeviceId, requireBrowserRelay } from './relay-token'

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

/** The app build the relay must match; a relay from another build is told to restart. */
export const relayAppVersion = () => process.env.VERCEL_GIT_COMMIT_SHA || 'dev'
