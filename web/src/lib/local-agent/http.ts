/**
 * Route plumbing shared by /api/local-agent/**: the body reader and the one
 * place a library refusal becomes an api-errors response.
 */

import { requireUser, type AuthContext } from '@/lib/api-auth'
import { apiError, badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { isDeviceToken } from '@/lib/device-tokens'
import { LocalAgentError } from './store'

/**
 * requireUser, minus Native Intelligence capture-device tokens (`Bearer d8d_…`): those are
 * pinned to a workspace for a hardware recorder and must never drive a local
 * agent on someone's Mac. The model relay has its own token and does not use
 * this. Precedent: eve-session's teammate threads refuse them the same way.
 */
export async function requireLocalAgentUser(request: Request): Promise<AuthContext | Response> {
  const header = request.headers.get('authorization') ?? ''
  if (header.startsWith('Bearer ') && isDeviceToken(header.slice(7).trim())) {
    return apiError('Local agents need a signed-in session', { status: 403, code: 'DEVICE_TOKEN_REFUSED' })
  }
  return requireUser()
}

/** The JSON body as an object, or a 400. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Expected a JSON object')
    return body as Record<string, unknown>
  } catch {
    return badRequest('Invalid JSON')
  }
}

/** Map anything a handler threw to its response. */
export function errorResponse(err: unknown, where: string): Response {
  if (err instanceof Response) return err
  if (err instanceof LocalAgentError) {
    switch (err.code) {
      case 'bad_request':
        return badRequest(err.message, err.details)
      case 'not_found':
        return notFound(err.message)
      case 'forbidden':
        return forbidden(err.message)
      case 'conflict': {
        const code = (err.details as { code?: unknown } | undefined)?.code
        return conflict(err.message, err.details, typeof code === 'string' ? code : undefined)
      }
    }
  }
  console.error(`[local-agent] ${where} failed:`, err instanceof Error ? err.message : err)
  return serverError()
}
