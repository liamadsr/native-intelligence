/**
 * Route-auth tests for the utility eve channel (twin of skill-runner's).
 *
 *   1. the shared secret is checked constant-time and must match exactly;
 *   2. the per-call headers are trusted ONLY after the secret verifies — no
 *      principal is ever minted from attacker-controlled headers;
 *   3. there is no cookie path;
 *   4. UTILITY_INTERNAL_SECRET falls back to RUN_SKILL_INTERNAL_SECRET, and the
 *      dedicated secret wins when both are set.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { sharedSecretAuth } from '../auth'

const SECRET = 'utility-secret-xyz'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/eve/utility/v1/session', { method: 'POST', headers })
}

afterEach(() => {
  delete process.env.UTILITY_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('utility sharedSecretAuth', () => {
  const auth = sharedSecretAuth()

  it('accepts the exact secret and stamps the token, workspace and kind', async () => {
    process.env.UTILITY_INTERNAL_SECRET = SECRET
    const result = await auth(
      req({
        authorization: `Bearer ${SECRET}`,
        'x-utility-run-token': 'tok-1',
        'x-utility-run-workspace': 'ws-1',
        'x-utility-run-user': 'user-1',
        'x-utility-run-kind': 'generate_title',
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.principalId).toBe('user-1')
    expect(result!.attributes).toEqual({ runToken: 'tok-1', workspaceId: 'ws-1', kind: 'generate_title' })
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET when the dedicated secret is unset', async () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    const result = await auth(req({ authorization: `Bearer ${SECRET}`, 'x-utility-run-token': 't' }))
    expect(result).not.toBeNull()
    expect(result!.principalId).toBe('utility')
  })

  it('the dedicated secret wins: the fallback secret is refused once it is set', async () => {
    process.env.UTILITY_INTERNAL_SECRET = SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'skill-secret'
    expect(await auth(req({ authorization: 'Bearer skill-secret' }))).toBeNull()
  })

  it('SKIPS a wrong secret — the headers are not trusted', async () => {
    process.env.UTILITY_INTERNAL_SECRET = SECRET
    const result = await auth(
      req({ authorization: 'Bearer nope', 'x-utility-run-token': 'attacker', 'x-utility-run-workspace': 'ws-x' }),
    )
    expect(result).toBeNull()
  })

  it('SKIPS a length-mismatched secret', async () => {
    process.env.UTILITY_INTERNAL_SECRET = SECRET
    expect(await auth(req({ authorization: `Bearer ${SECRET}EXTRA` }))).toBeNull()
  })

  it('does not authenticate a cookie-only request', async () => {
    process.env.UTILITY_INTERNAL_SECRET = SECRET
    expect(await auth(req({ cookie: 'sb-access-token=abc' }))).toBeNull()
  })

  it('fails closed when no secret is configured', async () => {
    expect(await auth(req({ authorization: 'Bearer ' }))).toBeNull()
    expect(await auth(req({ authorization: `Bearer ${SECRET}` }))).toBeNull()
  })
})
