/**
 * Route-auth for the live-agent eve channel (internal-only).
 *   1. the shared secret is checked CONSTANT-TIME and must match exactly —
 *      LIVE_AGENT_INTERNAL_SECRET, falling back to RUN_SKILL_INTERNAL_SECRET;
 *   2. the per-turn headers are trusted ONLY after the secret verifies — a
 *      request without it is SKIPPED (null) so no principal is minted from
 *      attacker-controlled headers;
 *   3. there is no cookie path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sharedSecretAuth } from '../auth'

const SECRET = 'live-agent-secret-xyz'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost:3000/eve/live-agent/v1/session', { method: 'POST', headers })
}

describe('sharedSecretAuth', () => {
  const auth = sharedSecretAuth()

  beforeEach(() => {
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })
  afterEach(() => {
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('accepts the exact secret and stamps the run token + workspace onto attributes', async () => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
    const result = await auth(
      req({
        authorization: `Bearer ${SECRET}`,
        'x-live-agent-token': 'tok.sig',
        'x-live-agent-workspace': 'ws-1',
        'x-live-agent-user': 'user-1',
      }),
    )
    expect(result).toEqual({
      authenticator: 'live-agent-internal',
      principalId: 'user-1',
      principalType: 'user',
      attributes: { runToken: 'tok.sig', workspaceId: 'ws-1' },
    })
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET when the dedicated secret is unset', async () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
    const result = await auth(req({ authorization: `Bearer ${SECRET}` }))
    expect(result).not.toBeNull()
  })

  it('the dedicated secret wins over the fallback', async () => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root-secret'
    expect(await auth(req({ authorization: 'Bearer root-secret' }))).toBeNull()
  })

  it('skips (null) a wrong, missing, or non-Bearer secret — the headers are never trusted', async () => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
    expect(await auth(req({ authorization: `Bearer ${SECRET}x`, 'x-live-agent-token': 'evil' }))).toBeNull()
    expect(await auth(req({ 'x-live-agent-token': 'evil' }))).toBeNull()
    expect(await auth(req({ authorization: SECRET }))).toBeNull()
    expect(await auth(req({ cookie: 'sb-access-token=abc' }))).toBeNull()
  })

  it('skips everything when no secret is configured', async () => {
    expect(await auth(req({ authorization: 'Bearer ' }))).toBeNull()
    expect(await auth(req({ authorization: 'Bearer anything' }))).toBeNull()
  })
})
