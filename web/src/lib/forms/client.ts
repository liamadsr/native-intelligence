/**
 * Who a form's submission comes from, for its caps (./submit.ts): the
 * sender's address as the edge in front of the app set it (X-Real-IP: our
 * own edge overwrites it with the connection's address, deploy/edge/Caddyfile),
 * never a header the sender picks. An IPv6 address counts as its /64: one
 * home or one server holds a whole /64, so its addresses are one sender.
 * Kept only as a keyed hash: the address itself is never stored.
 *
 * Server only.
 */
import { createHmac } from 'node:crypto'
import { oauthStateSecret } from '@/lib/oauth/state'

const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/

/** The address the caps count by: an IPv4 address whole, an IPv6 one as its first four groups. Pure. */
export function senderNetwork(address: string): string {
  const a = address.toLowerCase()
  if (!a.includes(':')) return a
  // An IPv4 address carried in IPv6 (::ffff:203.0.113.7) is that IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return mapped[1]
  const [head, tail = ''] = a.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** The request's sender as a keyed hash, or null when the edge said nothing usable (the per-sender cap then doesn't apply). */
export function formClientKey(request: Request, secret?: string): string | null {
  const raw = request.headers.get('x-real-ip')?.trim() ?? ''
  if (!ADDRESS.test(raw)) return null
  return createHmac('sha256', secret ?? oauthStateSecret()).update(`form-sender:${senderNetwork(raw)}`).digest('base64url').slice(0, 32)
}
