/**
 * Route plumbing shared by /api/account/environments/**: the auth gate, the
 * body reader, and the one place a library refusal becomes an api-errors
 * response.
 */

import { requireWorkspace, type WorkspaceAuthContext } from '@/lib/api-auth'
import { apiError, badRequest, conflict, forbidden, notFound, serverError } from '@/lib/api-errors'
import { isDeviceToken } from '@/lib/device-tokens'
import { EnvironmentError } from './types'

/**
 * requireWorkspace, minus Native Intelligence capture-device tokens (`Bearer d8d_…`): a
 * hardware recorder pinned to a workspace has no business renaming or
 * removing someone's Mac (the local-agent routes refuse them the same way).
 */
export async function requireEnvironmentsWorkspace(request: Request): Promise<WorkspaceAuthContext | Response> {
  const header = request.headers.get('authorization') ?? ''
  if (header.startsWith('Bearer ') && isDeviceToken(header.slice(7).trim())) {
    return apiError('Environments need a signed-in session', { status: 403, code: 'DEVICE_TOKEN_REFUSED' })
  }
  return requireWorkspace()
}

/** The JSON body as an object, or a 400. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Expected a JSON object')
    return body as Record<string, unknown>
  } catch {
    return badRequest('Invalid JSON')
  }
}

/** Map anything a handler threw to its response. */
export function environmentErrorResponse(err: unknown, where: string): Response {
  if (err instanceof Response) return err
  if (err instanceof EnvironmentError) {
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
  console.error(`[environments] ${where} failed:`, err instanceof Error ? err.message : err)
  return serverError()
}
