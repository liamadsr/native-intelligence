import { describe, it, expect } from 'vitest'
import {
  apiError,
  unauthorized,
  sessionExpired,
  forbidden,
  notFound,
  badRequest,
  noWorkspace,
  notMember,
  rateLimited,
  serverError,
} from '@/lib/api-errors'

async function readBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

describe('api-errors', () => {
  describe('apiError', () => {
    it('defaults to 500 with just an error message', async () => {
      const res = apiError('boom')
      expect(res.status).toBe(500)
      expect(await readBody(res)).toEqual({ error: 'boom' })
    })

    it('includes code and details when provided', async () => {
      const res = apiError('nope', {
        status: 418,
        code: 'TEAPOT',
        details: { hint: 'try coffee' },
      })
      expect(res.status).toBe(418)
      expect(await readBody(res)).toEqual({
        error: 'nope',
        code: 'TEAPOT',
        details: { hint: 'try coffee' },
      })
    })

    it('omits code when not provided', async () => {
      const res = apiError('plain', { status: 400 })
      const body = await readBody(res)
      expect('code' in body).toBe(false)
    })

    it('distinguishes undefined details from null details', async () => {
      // Null is a real value the caller might want to pass; undefined means "omit".
      const resNull = apiError('x', { status: 400, details: null })
      expect(await readBody(resNull)).toEqual({
        error: 'x',
        details: null,
      })
    })
  })

  describe('unauthorized', () => {
    it('returns 401 UNAUTHORIZED with default message', async () => {
      const res = unauthorized()
      expect(res.status).toBe(401)
      expect(await readBody(res)).toEqual({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED',
      })
    })

    it('allows custom message', async () => {
      const res = unauthorized('Token expired')
      const body = await readBody(res)
      expect(body.error).toBe('Token expired')
      expect(body.code).toBe('UNAUTHORIZED')
    })
  })

  describe('sessionExpired', () => {
    it('returns 401 SESSION_EXPIRED — a distinct 401 the client can refresh + retry', async () => {
      const res = sessionExpired()
      expect(res.status).toBe(401)
      expect(await readBody(res)).toEqual({
        error: 'Session expired',
        code: 'SESSION_EXPIRED',
      })
    })
  })

  describe('forbidden / notFound / badRequest', () => {
    it('forbidden returns 403 FORBIDDEN', async () => {
      const res = forbidden()
      expect(res.status).toBe(403)
      expect((await readBody(res)).code).toBe('FORBIDDEN')
    })

    it('notFound returns 404 NOT_FOUND', async () => {
      const res = notFound('Action not found')
      expect(res.status).toBe(404)
      const body = await readBody(res)
      expect(body.error).toBe('Action not found')
      expect(body.code).toBe('NOT_FOUND')
    })

    it('badRequest returns 400 with optional details payload', async () => {
      const res = badRequest('invalid', { field: 'title' })
      expect(res.status).toBe(400)
      const body = await readBody(res)
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.details).toEqual({ field: 'title' })
    })
  })

  describe('workspace-specific helpers', () => {
    it('noWorkspace is 400 NO_WORKSPACE (not a 404) so clients can distinguish', async () => {
      // It's deliberately 400, not 404 — the user is authenticated but has
      // no workspace context selected. UI typically prompts them to pick one.
      const res = noWorkspace()
      expect(res.status).toBe(400)
      expect((await readBody(res)).code).toBe('NO_WORKSPACE')
    })

    it('notMember is 403 NOT_MEMBER', async () => {
      const res = notMember()
      expect(res.status).toBe(403)
      expect((await readBody(res)).code).toBe('NOT_MEMBER')
    })
  })

  describe('rateLimited / serverError', () => {
    it('rateLimited returns 429 RATE_LIMITED', async () => {
      const res = rateLimited()
      expect(res.status).toBe(429)
      expect((await readBody(res)).code).toBe('RATE_LIMITED')
    })

    it('serverError returns 500 INTERNAL with details', async () => {
      const res = serverError('db down', { hint: 'retry' })
      expect(res.status).toBe(500)
      const body = await readBody(res)
      expect(body.error).toBe('db down')
      expect(body.code).toBe('INTERNAL')
      expect(body.details).toEqual({ hint: 'retry' })
    })
  })
})
