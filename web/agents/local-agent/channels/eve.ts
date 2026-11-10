/**
 * The Mac body's eve channel (contract C2, docs/plans/teammate-agent.md): the
 * Mac host's slot the Mac build puts in place of the cloud's channels/eve.ts
 * (scripts/local-agent/mac-body.sh).
 *
 * The server listens on 127.0.0.1 only, behind a random 32-byte secret the
 * launcher generates per launch (LOCAL_AGENT_SECRET) and presents as a bearer
 * token (invariant 4: a web page or another app cannot drive it, DNS
 * rebinding included, because none of them has the secret). Bearer auth is
 * the ONLY verifier: no localDev() (which admits every caller whenever an eve
 * dev flag is set, whoever it is) and no vercelOidc(). `GET /eve/v1/health`
 * stays public, as eve always keeps it. The launcher checks that a session
 * request without the secret gets 401 before it reports `ready`.
 *
 * A swap, not a switch inside the cloud's channel: that one is the person's
 * Supabase session, the session-ownership ACL and the device and server
 * entries (agents/chat-agent/lib/auth.ts), none of which may ship to a Mac.
 * The principal carries the stand-in run token and the other attributes the
 * chat agent's resolvers read (agents/chat-agent/lib/mac-host.ts). It refuses
 * to load in a build that isn't the Mac body.
 */
import { eveChannel } from 'eve/channels/eve'
import type { AuthFn } from 'eve/channels/auth'
import { isMacHost } from '../../chat-agent/lib/host.js'
import { macPrincipalAttributes } from '../../chat-agent/lib/mac-host.js'
import { localAgentSecretAuth } from '../lib/auth.js'

if (!isMacHost()) throw new Error('[local-agent] the Mac channel loaded outside the Mac body (NI_AGENT_HOST is not mac)')

/** The launcher's per-launch secret (../lib/auth.ts), with the Mac principal's attributes. */
export function macChannelAuth(): AuthFn<Request> {
  const secret = localAgentSecretAuth()
  return async (request) => {
    const principal = await secret(request)
    if (!principal) return null
    return { ...principal, attributes: { ...principal.attributes, ...macPrincipalAttributes() } }
  }
}

export default eveChannel({
  auth: [macChannelAuth()],
})
