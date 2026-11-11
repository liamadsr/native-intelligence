/**
 * Who a public booking page's request comes from, for its rate limits
 * (./public.ts): the client's address as the edge in front of the app set it
 * (X-Real-IP: our own edge overwrites it with the connection's address,
 * deploy/edge/Caddyfile, and Vercel sets it as well), never a header the
 * client picks (X-Forwarded-For's first entry is whatever it sent). Kept only
 * as a keyed hash: the address itself is never stored.
 *
 * Server only.
 */
import { createHmac } from 'node:crypto'
import { oauthStateSecret } from '@/lib/oauth/state'

const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/

/** The request's client as a keyed hash, or null when the edge said nothing usable (the per-client caps then don't apply). */
export function clientKeyOf(request: Request, secret?: string): string | null {
  const raw = request.headers.get('x-real-ip')?.trim() ?? ''
  if (!ADDRESS.test(raw)) return null
  return createHmac('sha256', secret ?? oauthStateSecret()).update(`booking-page-client:${raw.toLowerCase()}`).digest('base64url').slice(0, 32)
}
