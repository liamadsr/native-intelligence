/**
 * The git gate's address check: with AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES set,
 * the gate (authorizeRun in git-push-proxy.ts, so reads and pushes alike)
 * accepts a request only from one of the listed IP addresses, before it even
 * looks at the token.
 *
 * Why: on the hosted sandbox the run's gate token is injected by the
 * service's firewall and never exists inside the sandbox. On our own sandbox
 * runtime there is no such broker, so the token sits in the sandbox's git
 * config, where the model can read it. With this setting holding the sandbox
 * server's public addresses, a token copied out of a sandbox is worth nothing
 * from anywhere else. The coding agent refuses to start a run on its own
 * runtime unless the spec says this check is on (`gitGateAddressBound`).
 *
 * Which address: the request's `x-real-ip` header. It is trustworthy here
 * because the edge proxy (deploy/edge/Caddyfile, the `proxy` snippet) sets it
 * to the connection's real peer on every request, overwriting whatever a
 * client sent, and the stack's own proxy passes it on unchanged. Never
 * `x-forwarded-for`, which a client can append to. What it proves: the request
 * came from our sandbox server. What it does not prove: that it came from
 * THIS run's sandbox (every sandbox on that server shares its address); the
 * token, checked next, is what names the run.
 *
 * Blank or unset: no address check at all (the hosted path's behaviour). An
 * entry that is not an IP address makes the check refuse everything (fail
 * closed), with one log line naming the setting, never its value.
 */
import { isIP } from 'node:net'

export const GIT_GATE_ALLOWED_ADDRESSES_ENV = 'AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES'

/** off: no check. allow: these canonical addresses only. refuse: nothing passes. */
export type GitGateAddressPolicy =
  | { kind: 'off' }
  | { kind: 'allow'; addresses: ReadonlySet<string> }
  | { kind: 'refuse' }

/**
 * One address in a canonical form, or null when it is not an IP address:
 * trimmed, lowercased, without brackets or a zone id; an IPv4-mapped IPv6
 * address as its IPv4; IPv6 in its one normal spelling (so `2001:db8::1` and
 * `2001:0db8:0:0:0:0:0:1` are the same).
 */
export function canonicalAddress(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  const family = isIP(value)
  if (family === 4) return value
  if (family !== 6) return null
  let normal: string
  try {
    // The URL parser writes an IPv6 address in its canonical form (RFC 5952).
    normal = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  } catch {
    return null
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal)
  if (mapped) {
    const hi = parseInt(mapped[1], 16)
    const lo = parseInt(mapped[2], 16)
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  return normal
}

/** The policy a value of the setting asks for. Pure (see gitGateAddressPolicy for the logged form). */
export function parseGitGateAddresses(value: string | undefined): GitGateAddressPolicy {
  const entries = (value ?? '').split(/[\s,]+/).filter((e) => e.length > 0)
  if (entries.length === 0) return { kind: 'off' }
  const addresses = new Set<string>()
  for (const entry of entries) {
    const canonical = canonicalAddress(entry)
    if (canonical === null) return { kind: 'refuse' }
    addresses.add(canonical)
  }
  return { kind: 'allow', addresses }
}

let memo: { value: string | undefined; policy: GitGateAddressPolicy } | null = null

/** The setting's policy, read now; one log line the first time a value fails to parse. */
export function gitGateAddressPolicy(env: Readonly<Record<string, string | undefined>> = process.env): GitGateAddressPolicy {
  const value = env[GIT_GATE_ALLOWED_ADDRESSES_ENV]
  if (memo && memo.value === value) return memo.policy
  const policy = parseGitGateAddresses(value)
  if (policy.kind === 'refuse') {
    console.error(`[git-gate] ${GIT_GATE_ALLOWED_ADDRESSES_ENV} holds an entry that is not an IP address: the git gate refuses every request until it is fixed`)
  }
  memo = { value, policy }
  return policy
}

/** True when the gate accepts gate tokens only from listed addresses (the spec's `gitGateAddressBound`). */
export function gitGateAddressBound(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const policy = gitGateAddressPolicy(env)
  return policy.kind === 'allow' && policy.addresses.size > 0
}

/** Whether a gate request may go on to its token check. */
export function gitGateRequestAddressAllowed(request: Request, policy: GitGateAddressPolicy = gitGateAddressPolicy()): boolean {
  if (policy.kind === 'off') return true
  if (policy.kind === 'refuse') return false
  const peer = request.headers.get('x-real-ip')
  if (!peer) return false
  const canonical = canonicalAddress(peer)
  return canonical !== null && policy.addresses.has(canonical)
}
