import 'server-only'
import type { BrowserCommandActor } from '@/lib/browser-agent/command-handlers'
import { relayDeviceId, requireBrowserRelay, type BrowserRelayClaims } from './relay-token'
import { APP_RELAY_HOSTS } from '@/lib/app-url'
import { requestOrigin } from '@/lib/security/same-origin'
import { canonicalAddress, parseGitGateAddresses } from '@/lib/agent-run/git-gate-address'
import { BROWSER_RELAY_ALLOWED_ADDRESSES_ENV, cloudBrowserBackendKind } from './config'
import * as store from './store'

/**
 * Shared by the relay routes (src/app/api/browser-relay/*; docs/plans/cloud-browser.md
 * C2): the relay's actor, from its token alone. One user, one workspace, and
 * the device is its sandbox. Every relay route passes through here.
 */
export async function relayActor(request: Request): Promise<BrowserCommandActor | Response> {
  const claims = await requireAcceptedRelay(request)
  if (claims instanceof Response) return claims
  return { userId: claims.userId, workspaceId: claims.workspaceId, deviceId: relayDeviceId(claims) }
}

const unauthorized = () => Response.json({ error: 'Unauthorized' }, { status: 401 })

/** allow: these canonical addresses only. refuse: nothing passes (the setting unset, blank, or holding a malformed entry). */
type RelayAddressPolicy = { kind: 'refuse' } | { kind: 'allow'; addresses: ReadonlySet<string> }

let memo: { value: string | undefined; policy: RelayAddressPolicy } | null = null

/**
 * BROWSER_RELAY_ALLOWED_ADDRESSES, read now: comma or space separated IP
 * addresses (the git gate's parser, src/lib/agent-run/git-gate-address.ts).
 * Unlike the git gate, unset or blank refuses every relay on the runtime
 * backend, and so does one entry that is not an IP address (one log line, never the value).
 */
export function relayAddressPolicy(env: Readonly<Record<string, string | undefined>> = process.env): RelayAddressPolicy {
  const value = env[BROWSER_RELAY_ALLOWED_ADDRESSES_ENV]
  if (memo && memo.value === value) return memo.policy
  const parsed = parseGitGateAddresses(value)
  const policy: RelayAddressPolicy = parsed.kind === 'allow' && parsed.addresses.size > 0 ? parsed : { kind: 'refuse' }
  if (parsed.kind === 'refuse') console.error(`[cloud-browser] ${BROWSER_RELAY_ALLOWED_ADDRESSES_ENV} holds an entry that is not an IP address: every relay is refused until it is fixed`)
  else if (policy.kind === 'refuse') console.error(`[cloud-browser] ${BROWSER_RELAY_ALLOWED_ADDRESSES_ENV} is not set: on the runtime backend every relay is refused`)
  memo = { value, policy }
  return policy
}

/**
 * The request's peer is one of the listed addresses. `x-real-ip` is set by our
 * edge to the connection's real peer on every request, overwriting whatever a
 * client sent (as the git gate reads it); never `x-forwarded-for`, which a
 * client can append to.
 */
export function relayRequestAddressAllowed(request: Request, policy: RelayAddressPolicy = relayAddressPolicy()): boolean {
  if (policy.kind !== 'allow') return false
  const peer = request.headers.get('x-real-ip')
  const canonical = peer ? canonicalAddress(peer) : null
  return canonical !== null && policy.addresses.has(canonical)
}

/**
 * The relay behind this request, or a 401.
 *
 * Hosted backend: the token and the relay's mark (relay-token.ts), nothing more.
 * The token never exists inside the VM there: the service's firewall adds it.
 *
 * Runtime backend: that service cannot add a header on the way out, so the
 * token sits in a file in the VM (backend-runtime.ts) and a copy of it could
 * be taken out. A token is therefore accepted only when, besides the token and
 * the mark, BOTH hold:
 *  - the request comes from one of BROWSER_RELAY_ALLOWED_ADDRESSES (our
 *    sandbox server's public addresses), checked before the token is read;
 *  - the browser the token names (its user and workspace) is `starting` or
 *    `running` in its row: a stopped browser's token is worth nothing, even
 *    before it expires.
 * What that proves: the request came from our sandbox server while that
 * person's browser was up. What it does NOT prove: that it came from THIS
 * sandbox (every sandbox there shares the server's addresses), so a token
 * copied into another sandbox on that server works for as long as the
 * browser runs. And a full escape from Chrome's process (to the relay's
 * user, which Chrome runs as too) could read the token, which the hosted
 * design made impossible: there the token never entered the VM.
 */
export async function requireAcceptedRelay(request: Request): Promise<BrowserRelayClaims | Response> {
  let runtime: boolean
  try {
    runtime = cloudBrowserBackendKind() === 'runtime'
  } catch (error) {
    // An unknown CLOUD_BROWSER_BACKEND: no relay is accepted (fail closed).
    console.error('[cloud-browser] relay refused:', error instanceof Error ? error.message : error)
    return unauthorized()
  }
  if (runtime && !relayRequestAddressAllowed(request)) return unauthorized()
  const claims = requireBrowserRelay(request)
  if (claims instanceof Response || !runtime) return claims
  const status = await store.readStatus({ userId: claims.userId, workspaceId: claims.workspaceId }).catch(() => null)
  return status === 'starting' || status === 'running' ? claims : unauthorized()
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
