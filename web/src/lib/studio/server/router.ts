// The Studio's HTTP surface, behind one catch-all route (src/app/api/account/studio/[...path]). A route is a method,
// a path pattern (`projects/:id/versions/:version/restore`) and a thin handler that reads the request and calls the
// plain functions of this folder. A handler answers a value (sent as JSON) or a Response. Errors become
// `{ error, code? }` with their status: the editor shows `error` as is, so it is always a sentence.
import { apiError } from '@/lib/api-errors'
import type { StudioContext } from './context'
import { asStudioError, StudioError } from './errors'

export type StudioRequest = {
  method: string
  params: Record<string, string>
  url: URL
  request: Request
  ctx: StudioContext
  /** The JSON body as an object ({} when empty); 400 when it is not JSON, 413 past 16 MB. */
  body: () => Promise<Record<string, unknown>>
}

export type StudioHandler = (req: StudioRequest) => Promise<unknown>
export type StudioRoute = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; pattern: string; handler: StudioHandler }

/** The largest JSON body accepted (a whole edit with its media records fits well under it). */
export const MAX_BODY_BYTES = 16 * 1024 * 1024

/** A route table entry. */
export const route = (method: StudioRoute['method'], pattern: string, handler: StudioHandler): StudioRoute => ({ method, pattern, handler })

/** Match path segments against a pattern; `:name` takes one segment, `*name` the rest (at least one). */
export function matchPattern(pattern: string, segments: string[]): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean)
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    if (part.startsWith('*')) {
      if (i >= segments.length) return null
      params[part.slice(1)] = segments.slice(i).join('/')
      return params
    }
    const segment = segments[i]
    if (segment === undefined) return null
    if (part.startsWith(':')) params[part.slice(1)] = segment
    else if (part !== segment) return null
  }
  return parts.length === segments.length ? params : null
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new StudioError('That request is too large.', 413, 'TOO_LARGE')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new StudioError('That request is too large.', 413, 'TOO_LARGE')
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new StudioError('The request body is not JSON.', 400, 'INVALID_JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new StudioError('The request body must be a JSON object.', 400, 'INVALID_JSON')
  return value as Record<string, unknown>
}

/** The JSON answer for a thrown error. */
export function errorResponse(error: unknown): Response {
  const e = asStudioError(error)
  // Not set up is said in the log once (errors.ts notSetUpError), not on every request.
  if (e.status >= 500 && e.code !== 'STUDIO_NOT_SET_UP') console.error('[studio]', e.message, error instanceof Error && error !== e ? error.stack?.split('\n').slice(0, 3).join(' | ') : '')
  return apiError(e.message, { status: e.status, ...(e.code ? { code: e.code } : {}) })
}

/** Answer a request from a route table. HEAD is answered by the GET route. */
export async function dispatch(routes: StudioRoute[], request: Request, segments: string[], ctx: StudioContext): Promise<Response> {
  const method = request.method === 'HEAD' ? 'GET' : request.method
  const decoded = segments.map((s) => {
    try {
      return decodeURIComponent(s)
    } catch {
      return s
    }
  })
  let pathMatched = false
  for (const r of routes) {
    const params = matchPattern(r.pattern, decoded)
    if (!params) continue
    pathMatched = true
    if (r.method !== method) continue
    let cached: Promise<Record<string, unknown>> | null = null
    const req: StudioRequest = { method, params, url: new URL(request.url), request, ctx, body: () => (cached ??= readJson(request)) }
    try {
      const out = await r.handler(req)
      if (out instanceof Response) return out
      return Response.json(out ?? { ok: true }, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return errorResponse(error)
    }
  }
  if (pathMatched) return apiError('That method is not allowed here.', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  return apiError('Not found', { status: 404, code: 'NOT_FOUND' })
}

/** A body field as a string, or undefined. */
export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
