/**
 * Route-auth tests for the skill-runner eve channel.
 *
 * The invariants under test:
 *   1. the shared secret is validated CONSTANT-TIME and must match exactly;
 *   2. the per-run headers (run token, workspace, user) are trusted ONLY after
 *      the secret verifies — a request without a valid secret is SKIPPED (null),
 *      so the walk falls through to localDevOffVercel() and no principal is
 *      minted from attacker-controlled headers;
 *   3. there is NO cookie path — a cookie-only request is not authenticated here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sharedSecretAuth } from '../auth'

const SECRET = 'shared-secret-for-skill-runner-xyz'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/eve/skill-runner/v1/session', {
    method: 'POST',
    headers,
  })
}

describe('sharedSecretAuth', () => {
  const auth = sharedSecretAuth()

  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('accepts the exact secret and stamps the run token + workspace onto attributes', async () => {
    const result = await auth(
      req({
        authorization: `Bearer ${SECRET}`,
        'x-skill-run-token': 'tok-123',
        'x-skill-run-workspace': 'ws-9',
        'x-skill-run-user': 'user-9',
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.principalType).toBe('user')
    expect(result!.principalId).toBe('user-9')
    expect(result!.attributes.runToken).toBe('tok-123')
    expect(result!.attributes.workspaceId).toBe('ws-9')
  })

  it('SKIPS (null) when the secret is wrong — headers are NOT trusted', async () => {
    const result = await auth(
      req({
        authorization: 'Bearer wrong-secret',
        'x-skill-run-token': 'tok-attacker',
        'x-skill-run-workspace': 'ws-attacker',
      }),
    )
    // null = skip → the walk falls through; NO principal minted from headers.
    expect(result).toBeNull()
  })

  it('SKIPS when there is no Authorization header at all', async () => {
    const result = await auth(req({ 'x-skill-run-token': 'tok-x' }))
    expect(result).toBeNull()
  })

  it('SKIPS a length-mismatched secret (constant-time guard, no early-accept)', async () => {
    const result = await auth(req({ authorization: `Bearer ${SECRET}EXTRA` }))
    expect(result).toBeNull()
  })

  it('does NOT authenticate a COOKIE-only request (no cookie path)', async () => {
    const result = await auth(
      req({ cookie: 'sb-access-token=abc; workspace_id=ws-cookie' }),
    )
    expect(result).toBeNull()
  })

  it('SKIPS when the env secret is unset (fail closed)', async () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const result = await auth(req({ authorization: `Bearer ${SECRET}` }))
    expect(result).toBeNull()
  })
})
