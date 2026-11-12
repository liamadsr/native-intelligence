/**
 * How a Studio product job on the Mac reaches the app: the job's routes (src/app/api/local-agent/agent/studio), on the
 * app's origin, with the job's session token read from its file on every call (a refreshed token lands on the next
 * call), never a shared secret. The same origin and token every other Mac body call to the app uses
 * (agents/chat-agent/lib/mac-host.ts).
 */
import { macApiOrigin, macRouteUnavailable } from '../../chat-agent/lib/mac-host.js'
import { readModelToken } from '../lib/model.js'
import type { JobApp, MacJob } from './job.js'

/** An app answer's sentence when it refused, else the parsed body. */
async function answerOf<T>(res: Response, what: string): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ? `${what}: ${body.error}` : `${what} (${res.status})`)
  if (!body) throw new Error(`${what}: the app answered nothing`)
  return body
}

/** The client over a given origin and token reader (tests pass their own fetch). */
export function studioAppClient(opts: { origin: string; token: () => string; fetch?: typeof globalThis.fetch }): JobApp {
  const go = opts.fetch ?? globalThis.fetch
  const base = `${opts.origin}/api/local-agent/agent/studio`
  const auth = () => ({ authorization: `Bearer ${opts.token()}` })
  return {
    async getJob(id) {
      return answerOf<MacJob>(await go(`${base}?job=${encodeURIComponent(id)}`, { headers: auth(), redirect: 'error' }), 'The app did not hand over the job')
    },
    async report(body) {
      return answerOf(await go(base, { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error' }), 'The app did not take the report')
    },
    async upload(meta, bytes, contentType) {
      const header = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url')
      const res = await go(`${base}/capture`, { method: 'POST', headers: { ...auth(), 'content-type': contentType, 'x-studio-capture': header }, body: bytes as BodyInit, redirect: 'error' })
      return answerOf(res, 'The app did not take the capture')
    },
  }
}

/** The client for this launch, or why the app cannot be reached from it (one sentence). */
export function macStudioApp(env: Readonly<Record<string, string | undefined>> = process.env): JobApp | string {
  const unavailable = macRouteUnavailable(env)
  const origin = unavailable ? null : macApiOrigin(env)
  if (!origin) return `This Mac job cannot reach the app (${unavailable ?? 'no app origin'}), so Studio product jobs cannot run here. Start the job from the chat in the desktop app.`
  const file = env.LOCAL_AGENT_SESSION_TOKEN_FILE!
  return studioAppClient({ origin, token: () => readModelToken(file) })
}
