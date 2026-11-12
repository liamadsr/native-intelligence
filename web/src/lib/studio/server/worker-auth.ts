// Who may speak for the Studio worker: a caller holding STUDIO_WORKER_SECRET, sent as
// `Authorization: Bearer <secret>` and compared in constant time. Without the setting the worker routes refuse
// everything (503) in production; in development the secret is `dev-studio-worker`, so a local worker needs no
// setup.
import { timingSafeEqual } from 'node:crypto'

export const STUDIO_WORKER_SECRET_ENV = 'STUDIO_WORKER_SECRET'
/** The secret a local worker uses when the setting is absent outside production. */
export const DEV_WORKER_SECRET = 'dev-studio-worker'

/** The worker secret in force, or null when the worker routes are off (production without the setting). */
export function studioWorkerSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const own = env[STUDIO_WORKER_SECRET_ENV]
  if (own && own.trim()) return own
  return env.NODE_ENV === 'production' ? null : DEV_WORKER_SECRET
}

function same(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** 'off': no secret set here (answer 503); 'refused': the request lacks it (401); 'ok'. */
export function checkWorkerAuth(request: Request, env: NodeJS.ProcessEnv = process.env): 'off' | 'refused' | 'ok' {
  const expected = studioWorkerSecret(env)
  if (!expected) return 'off'
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!presented || !same(presented, expected)) return 'refused'
  return 'ok'
}
