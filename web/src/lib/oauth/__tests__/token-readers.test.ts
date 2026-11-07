/**
 * The GitHub token readers (github-token.ts): every coding path, the PR
 * lookups and the agent's GitHub tools read the integration token through
 * them. Each decrypts what it reads (token-crypto.ts), a legacy plaintext row
 * still reads as is, and a token that will not decrypt reads as not connected.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSupabaseMock } from '@/test/supabase-mock'

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

vi.mock('@/lib/mcp-client/index', () => ({ listTools: vi.fn() }))

const { encryptOAuthToken } = await import('../token-crypto')
const { storedGithubToken, storedGithubTokensByAccount } = await import('../github-token')
const { decryptCredential } = await import('@/lib/crypto/credentials')
const { _resetGitHubToolsForTests, loadGitHubIntegrationServer } = await import('@/lib/mcp-client/github-integration')

const db = (tables: Record<string, unknown[]>) =>
  createSupabaseMock({
    tables: Object.fromEntries(Object.entries(tables).map(([t, data]) => [t, { data, error: null }])),
  }) as never

/** A v1 ciphertext of another key: the right shape, does not decrypt here. */
function foreignCiphertext(): string {
  const parts = encryptOAuthToken('gho_elsewhere').split('.')
  const ct = Buffer.from(parts[3], 'base64')
  ct[0] ^= 0x01
  parts[3] = ct.toString('base64')
  return parts.join('.')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('storedGithubToken', () => {
  it('decrypts the stored token', async () => {
    const svc = db({ user_oauth_tokens: [{ access_token: encryptOAuthToken('gho_secret') }] })
    expect(await storedGithubToken(svc, 'u-1')).toBe('gho_secret')
  })

  it('reads a legacy plaintext token as is', async () => {
    const svc = db({ user_oauth_tokens: [{ access_token: 'gho_legacy' }] })
    expect(await storedGithubToken(svc, 'u-1')).toBe('gho_legacy')
  })

  it('reads an undecryptable token as not connected, logging the user and never the value', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored = foreignCiphertext()
    expect(await storedGithubToken(db({ user_oauth_tokens: [{ access_token: stored }] }), 'u-1')).toBeNull()
    const logged = err.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(logged).toContain('u-1')
    expect(logged).not.toContain(stored)
  })

  it('is null with no row', async () => {
    expect(await storedGithubToken(db({ user_oauth_tokens: [] }), 'u-1')).toBeNull()
  })
})

describe('storedGithubTokensByAccount', () => {
  it('pairs each account with its decrypted token, skipping one that will not decrypt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const svc = db({
      user_oauth_tokens: [
        { access_token: encryptOAuthToken('gho_a'), account_id: 'acc-a' },
        { access_token: foreignCiphertext(), account_id: 'acc-b' },
        { access_token: 'gho_legacy_c', account_id: 'acc-c' },
      ],
    })
    expect(await storedGithubTokensByAccount(svc, 'u-1')).toEqual([
      { accountId: 'acc-a', token: 'gho_a' },
      { accountId: 'acc-c', token: 'gho_legacy_c' },
    ])
  })
})

describe('loadGitHubIntegrationServer (the agent’s GitHub tools)', () => {
  it('dials with the decrypted token, re-encrypted the way a connected app’s is (never the stored ciphertext twice)', async () => {
    _resetGitHubToolsForTests()
    const svc = db({
      connected_account: [{ id: 'acc-gh', created_at: '2026-10-27T20:25:43Z', reauth_required_at: null }],
      user_oauth_tokens: [{ access_token: encryptOAuthToken('gho_secret'), account_id: 'acc-gh' }],
    })
    const listTools = vi.fn(async () => [{ name: 'list_commits', annotations: { readOnlyHint: true } }])
    const server = await loadGitHubIntegrationServer(svc, 'u-1', { listTools })
    expect(server).not.toBeNull()
    expect(decryptCredential(server!.access_token_encrypted!)).toBe('gho_secret')
  })
})
