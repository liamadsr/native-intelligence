/**
 * Tests for POST /api/early-access.
 *
 * Worked example of an integration-style route test:
 *   - Mocks Supabase service client + PostHog at module level
 *   - Builds real fetch-style Requests via the integration helper
 *   - Locks in every documented branch (rate limit, honeypot, validation,
 *     duplicate, success, server error)
 *
 * Use this as the template when adding tests for a new route. Copy the file,
 * change the imports, write the cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  insert: vi.fn(),
  posthogCapture: vi.fn(),
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => ({
      insert: hoisted.insert,
    }),
  }),
}))

vi.mock('@/lib/posthog', () => ({
  getPostHogServerClient: () => ({ capture: hoisted.posthogCapture }),
  serverDefaultProperties: { source_type: 'server' },
}))

const { POST } = await import('@/app/api/early-access/route')

function emailReq(body: unknown, ip?: string) {
  return buildRequest({
    url: 'https://dial8.ai/api/early-access',
    body,
    headers: ip ? { 'x-forwarded-for': ip } : {},
  })
}

beforeEach(() => {
  hoisted.insert.mockReset()
  hoisted.posthogCapture.mockReset()
  // Default: insert succeeds.
  hoisted.insert.mockResolvedValue({ error: null })
})

describe('POST /api/early-access', () => {
  it('returns 200 + tracks event on a valid new email', async () => {
    const res = await POST(
      emailReq({ email: 'new@dial8.test', source: 'docs' }, '10.0.0.1'),
    )
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ success: true })

    expect(hoisted.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new@dial8.test',
        source: 'docs',
      }),
    )
    expect(hoisted.posthogCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'waitlist_signup',
        distinctId: 'new@dial8.test',
        properties: expect.objectContaining({
          $set: { email: 'new@dial8.test' },
          $set_once: { signup_source: 'docs' },
        }),
      }),
    )
  })

  it('lowercases emails before persisting', async () => {
    // Note: the route validates with a regex BEFORE trimming, so emails with
    // leading/trailing whitespace get rejected as 400. We only test the
    // lowercasing path here, which is what actually runs in practice.
    await POST(emailReq({ email: 'MiXed@Dial8.Test' }, '10.0.0.2'))
    expect(hoisted.insert).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'mixed@dial8.test' }),
    )
  })

  it('returns 400 when email is missing', async () => {
    const res = await POST(emailReq({}, '10.0.0.3'))
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toEqual({
      error: 'Email is required',
    })
    expect(hoisted.insert).not.toHaveBeenCalled()
  })

  it('returns 400 on malformed email', async () => {
    const res = await POST(emailReq({ email: 'not-an-email' }, '10.0.0.4'))
    expect(res.status).toBe(400)
    expect(hoisted.insert).not.toHaveBeenCalled()
  })

  it('returns 400 on overlong email (>254 chars)', async () => {
    const long = 'a'.repeat(250) + '@dial8.test' // 261 chars
    const res = await POST(emailReq({ email: long }, '10.0.0.5'))
    expect(res.status).toBe(400)
    expect(hoisted.insert).not.toHaveBeenCalled()
  })

  it('silently succeeds when honeypot is filled (does not insert, does not leak)', async () => {
    const res = await POST(
      emailReq(
        { email: 'bot@dial8.test', honeypot: 'i-am-a-bot' },
        '10.0.0.6',
      ),
    )
    // Returns 200 to not tip off bots, but never writes to DB.
    expect(res.status).toBe(200)
    expect(await readJson(res)).toMatchObject({ success: true })
    expect(hoisted.insert).not.toHaveBeenCalled()
    expect(hoisted.posthogCapture).not.toHaveBeenCalled()
  })

  it('maps Postgres 23505 (duplicate) to 409', async () => {
    hoisted.insert.mockResolvedValueOnce({
      error: { code: '23505', message: 'duplicate key' },
    })
    const res = await POST(
      emailReq({ email: 'dup@dial8.test' }, '10.0.0.7'),
    )
    expect(res.status).toBe(409)
    expect(await readJson<{ error: string }>(res)).toEqual({
      error: 'This email is already on the waitlist',
    })
  })

  it('returns 500 on unknown DB error', async () => {
    hoisted.insert.mockResolvedValueOnce({
      error: { code: '08006', message: 'db unreachable' },
    })
    const res = await POST(
      emailReq({ email: 'err@dial8.test' }, '10.0.0.8'),
    )
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('Failed to join waitlist')
    // Raw DB message must not leak.
    expect(body.error).not.toContain('db unreachable')
  })

  it('caps source at 50 chars to prevent overflow', async () => {
    const longSource = 'x'.repeat(200)
    await POST(
      emailReq({ email: 'src@dial8.test', source: longSource }, '10.0.0.9'),
    )
    expect(hoisted.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.stringMatching(/^x{50}$/),
      }),
    )
  })

  it('rate-limits after 5 requests from the same IP within a minute', async () => {
    const ip = '10.0.0.100'
    // First 5 succeed.
    for (let i = 0; i < 5; i++) {
      const res = await POST(
        emailReq({ email: `rate-${i}@dial8.test` }, ip),
      )
      expect(res.status).toBe(200)
    }
    // 6th is rate-limited.
    const res = await POST(emailReq({ email: 'over@dial8.test' }, ip))
    expect(res.status).toBe(429)
    expect(await readJson<{ error: string }>(res)).toMatchObject({
      error: expect.stringContaining('Too many requests'),
    })
  })

  it('does not leak internal errors on malformed JSON body', async () => {
    const req = buildRequest({
      url: 'https://dial8.ai/api/early-access',
      body: 'not-json',
      raw: true,
      headers: { 'x-forwarded-for': '10.0.0.50' },
    })
    const res = await POST(req)
    // Either 400 or 500 is acceptable, but the body must not contain a stack trace.
    expect([400, 500]).toContain(res.status)
    const text = await res.text()
    expect(text).not.toContain('SyntaxError')
    expect(text).not.toContain('at ')
  })
})
