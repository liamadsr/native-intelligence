import { BlockList, isIP } from 'node:net'

/**
 * Whether an address is the public internet (docs/plans/cloud-browser.md, C4):
 * the hub's own check before a direct connection in `cloud` mode, the twin of
 * the Mac's policy (desktop/crates/browser-exit/src/policy.rs). The
 * session's network policy refuses private ranges too; this keeps the hub
 * from even trying.
 *
 * IPv4 inside IPv6 (`::ffff:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`) is judged by
 * its IPv4 address: Node's BlockList matches all of IPv4 against a
 * `::ffff:0:0/96` rule, so the two families are kept in separate lists.
 */

const v4 = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4.addSubnet(net, prefix, 'ipv4')

const v6 = new BlockList()
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) v6.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address an IPv6 one carries (mapped, compatible or NAT64), as dotted text. */
function embeddedV4(address: string): string | null {
  const lower = address.toLowerCase()
  const dotted = /^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (dotted) return dotted[1]
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (!hex) return null
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)]
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !v4.check(address, 'ipv4')
  if (family !== 6) return false
  const inner = embeddedV4(address)
  if (inner) return !v4.check(inner, 'ipv4')
  return !v6.check(address, 'ipv6')
}

/** The only ports the agent's browser reaches, through the Mac or not. */
export const EXIT_PORTS = [80, 443]
