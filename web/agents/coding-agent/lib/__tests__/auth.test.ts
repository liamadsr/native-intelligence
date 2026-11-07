/**
 * Route-auth tests for the coding-agent eve channel (twin of the skill-runner's).
 *
 * The invariants under test:
 *   1. the shared secret is validated CONSTANT-TIME and must match exactly;
 *   2. the per-run headers (run token, workspace, user) are trusted ONLY after
 *      the secret verifies — a request without a valid secret is SKIPPED (null),
 *      so the walk falls through to localDevOffVercel() and no principal is
 *      minted from attacker-controlled headers;
 *   3. AGENT_RUN_INTERNAL_SECRET is preferred, but RUN_SKILL_INTERNAL_SECRET is
 *      accepted as a fallback (one secret can bootstrap dev);
 *   4. there is NO cookie path — a cookie-only request is not authenticated here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sharedSecretAuth } from '../auth'

const SECRET = 'shared-secret-for-coding-agent-xyz'
const FALLBACK = 'run-skill-fallback-secret-abc'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/eve/coding-agent/v1/session', {
    method: 'POST',
    headers,
  })
}

describe('sharedSecretAuth', () => {
  const auth = sharedSecretAuth()

  beforeEach(() => {
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })
  afterEach(() => {
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('accepts the exact secret and stamps the run token + workspace onto attributes', async () => {
    const result = await auth(
      req({
        authorization: `Bearer ${SECRET}`,
        'x-agent-run-token': 'tok-123',
        'x-agent-run-workspace': 'ws-9',
        'x-agent-run-user': 'user-9',
      }),
    )
    expect(result).not.toBeNull()
    expect(result!.principalType).toBe('user')
    expect(result!.principalId).toBe('user-9')
    expect(result!.attributes.runToken).toBe('tok-123')
    expect(result!.attributes.workspaceId).toBe('ws-9')
  })

  it('falls back to a default principalId when the user header is absent', async () => {
    const result = await auth(req({ authorization: `Bearer ${SECRET}`, 'x-agent-run-token': 't' }))
    expect(result).not.toBeNull()
    expect(result!.principalId).toBe('coding-agent')
    expect(result!.attributes.runToken).toBe('t')
    expect(result!.attributes.workspaceId).toBe('')
  })

  it('accepts RUN_SKILL_INTERNAL_SECRET as a fallback when AGENT_RUN_INTERNAL_SECRET is unset', async () => {
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = FALLBACK
    const result = await auth(req({ authorization: `Bearer ${FALLBACK}`, 'x-agent-run-token': 't' }))
    expect(result).not.toBeNull()
    expect(result!.attributes.runToken).toBe('t')
  })

  it('prefers AGENT_RUN_INTERNAL_SECRET over the fallback when both are set', async () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = FALLBACK
    // The dedicated secret is set, so the fallback must NOT admit a caller.
    const withFallback = await auth(req({ authorization: `Bearer ${FALLBACK}` }))
    expect(withFallback).toBeNull()
    const withDedicated = await auth(req({ authorization: `Bearer ${SECRET}` }))
    expect(withDedicated).not.toBeNull()
  })

  it('SKIPS (null) when the secret is wrong — headers are NOT trusted', async () => {
    const result = await auth(
      req({
        authorization: 'Bearer wrong-secret',
        'x-agent-run-token': 'tok-attacker',
        'x-agent-run-workspace': 'ws-attacker',
      }),
    )
    expect(result).toBeNull()
  })

  it('SKIPS when there is no Authorization header at all', async () => {
    const result = await auth(req({ 'x-agent-run-token': 'tok-x' }))
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

  it('SKIPS when BOTH env secrets are unset (fail closed)', async () => {
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const result = await auth(req({ authorization: `Bearer ${SECRET}` }))
    expect(result).toBeNull()
  })
})
