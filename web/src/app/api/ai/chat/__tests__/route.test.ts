/**
 * /api/ai/chat is removed. Every method answers 410 with the shared
 * `{ error, code }` error shape, so the one out-of-repo client that still
 * POSTs here (the iOS app's AIBackendService) gets a parseable JSON error
 * instead of Next's 404 HTML page. The route must run nothing, so the test
 * also pins that the module imports no model, auth or database code.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as route from '../route'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

describe('/api/ai/chat (removed)', () => {
  it.each(METHODS)('%s → 410 { error, code: CHAT_ROUTE_REMOVED } as JSON', async (method) => {
    const handler = route[method]
    const res = handler()
    expect(res.status).toBe(410)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = await res.json()
    expect(body.code).toBe('CHAT_ROUTE_REMOVED')
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
    expect(Object.keys(body).sort()).toEqual(['code', 'error'])
  })

  it('imports nothing but the error helper (no model call, no auth, no data access)', () => {
    const src = readFileSync(join(__dirname, '../route.ts'), 'utf8')
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    expect(imports).toEqual(['@/lib/api-errors'])
  })
})
