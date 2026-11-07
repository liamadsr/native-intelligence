import { createCipheriv, randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'

/**
 * The one-off back-fill (token-backfill.ts), over a stateful fake database:
 * it encrypts only plaintext columns, fenced on what it read, leaves rotating
 * Jira/Linear rows to their next refresh, is idempotent, and writes NOTHING
 * until the key opens the app's own ciphertexts (and fails on none).
 */

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')

const { encryptOAuthToken, decryptOAuthToken, isEncryptedOAuthToken } = await import('../token-crypto')
const { TokenBackfillRefused, checkCredentialKey, encryptPlaintextOAuthTokens, migratesOnRefresh, plaintextTokenPatch } =
  await import('../token-backfill')

type Row = Record<string, unknown>

/** A v1 ciphertext under ANOTHER key: what DEV's key, or a typo, would have written. */
function otherKeyCiphertext(plaintext: string): string {
  const key = new Uint8Array(randomBytes(32))
  const iv = new Uint8Array(randomBytes(12))
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.from([...cipher.update(plaintext, 'utf8'), ...cipher.final()])
  return ['v1', Buffer.from(iv).toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.')
}

let tables: Record<string, Row[]>
/** Runs once, when the backfill reads connected_mcp_server: after it read the tokens, before it writes. */
let onServersRead: (() => void) | null

function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      let range: [number, number] | null = null
      const rows = () => (tables[table] ??= [])
      const run = async () => {
        if (patch) {
          const hit = rows().filter((r) => filters.every((f) => f(r)))
          for (const r of hit) Object.assign(r, patch)
          return { data: hit.map((r) => ({ id: r.id })), error: null }
        }
        if (table === 'connected_mcp_server' && onServersRead) {
          onServersRead()
          onServersRead = null
        }
        const all = rows().map((r) => ({ ...r }))
        return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null }
      }
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        range: (a: number, b: number) => ((range = [a, b]), chain),
        update: (p: Row) => ((patch = p), chain),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), chain),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), chain),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => run().then(ok, bad),
      }
      return chain
    },
  } as never
}

const token = (id: string, provider: string, access: string, refresh: string | null, expiresAt: string | null = null): Row => ({
  id,
  provider,
  expires_at: expiresAt,
  access_token: access,
  refresh_token: refresh,
})
const EXPIRES = '2026-11-01T00:00:00Z'
const stored = (id: string) => tables.user_oauth_tokens.find((r) => r.id === id)!

beforeEach(() => {
  onServersRead = null
  tables = {
    // The app's own writes: a connected app's tokens, under the app's key.
    connected_mcp_server: [{ id: 's-1', access_token_encrypted: encryptOAuthToken('mcp-a'), refresh_token_encrypted: null }],
    user_oauth_tokens: [
      token('t-github', 'github', 'gho_plain', null),
      token('t-google', 'google', 'ya29.plain', '1//refresh', EXPIRES),
      token('t-jira', 'jira', 'eyJ.jira', 'jira-refresh', EXPIRES),
      token('t-linear', 'linear', 'lin_oauth_x', 'lin-refresh', EXPIRES),
      token('t-done', 'hubspot', encryptOAuthToken('hs'), encryptOAuthToken('hs-r'), EXPIRES),
    ],
  }
})

describe('encryptPlaintextOAuthTokens', () => {
  it('a dry run counts and writes nothing', async () => {
    const before = JSON.stringify(tables)
    const c = await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: false })
    expect(c).toMatchObject({
      rows: 5,
      accessPlaintext: 4,
      accessEncrypted: 1,
      refreshPlaintext: 3,
      refreshEncrypted: 1,
      refreshNull: 1,
      rotatingLeft: 2,
      toEncrypt: 2,
      // The connected app's token and the encrypted hubspot row's two columns.
      keyOpened: 3,
      keyFailed: 0,
    })
    expect(JSON.stringify(tables)).toBe(before)
  })

  it('encrypts the plaintext columns, leaves rotating Jira/Linear rows alone, and a second run finds nothing', async () => {
    const c = await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })
    expect(c).toMatchObject({ toEncrypt: 2, encrypted: 2, changedSinceRead: 0, failed: 0, rotatingLeft: 2 })

    expect(decryptOAuthToken(stored('t-github').access_token as string)).toBe('gho_plain')
    expect(isEncryptedOAuthToken(stored('t-github').access_token as string)).toBe(true)
    expect(stored('t-github').refresh_token).toBeNull()
    expect(decryptOAuthToken(stored('t-google').refresh_token as string)).toBe('1//refresh')
    expect(isEncryptedOAuthToken(stored('t-google').refresh_token as string)).toBe(true)
    // Rotating rows untouched: they migrate at their own next refresh.
    expect(stored('t-jira')).toMatchObject({ access_token: 'eyJ.jira', refresh_token: 'jira-refresh' })
    expect(stored('t-linear')).toMatchObject({ access_token: 'lin_oauth_x', refresh_token: 'lin-refresh' })

    const again = await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })
    expect(again).toMatchObject({ toEncrypt: 0, encrypted: 0 })
  })

  it('encrypts a Jira/Linear row with no expiry (nothing will refresh it)', async () => {
    tables.user_oauth_tokens = [token('t-jira', 'jira', 'eyJ.jira', 'jira-refresh', null)]
    expect(await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })).toMatchObject({ encrypted: 1, rotatingLeft: 0 })
    expect(isEncryptedOAuthToken(stored('t-jira').refresh_token as string)).toBe(true)
  })

  it('skips a row rewritten between its read and its write', async () => {
    onServersRead = () => {
      stored('t-github').access_token = encryptOAuthToken('gho_reconnected')
    }
    const c = await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })
    expect(c).toMatchObject({ encrypted: 1, changedSinceRead: 1 })
    expect(decryptOAuthToken(stored('t-github').access_token as string)).toBe('gho_reconnected')
  })

  describe('the key is proven before anything is written', () => {
    function expectNothingWritten(before: string) {
      expect(JSON.stringify(tables)).toBe(before)
    }

    it('refuses when no ciphertext the app wrote exists to prove it (every token row still plaintext)', async () => {
      tables.connected_mcp_server = []
      tables.user_oauth_tokens = tables.user_oauth_tokens.filter((r) => r.id !== 't-done')
      const before = JSON.stringify(tables)
      await expect(encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })).rejects.toBeInstanceOf(TokenBackfillRefused)
      expectNothingWritten(before)
    })

    it('refuses a key that does not open the app’s ciphertexts (the wrong environment’s key)', async () => {
      tables.connected_mcp_server = [{ id: 's-1', access_token_encrypted: otherKeyCiphertext('mcp-a'), refresh_token_encrypted: null }]
      tables.user_oauth_tokens = tables.user_oauth_tokens.filter((r) => r.id !== 't-done')
      const before = JSON.stringify(tables)
      await expect(encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })).rejects.toThrow(/cannot be proven/)
      expectNothingWritten(before)
    })

    it('refuses mixed keys: one opens, one does not', async () => {
      tables.connected_mcp_server.push({ id: 's-2', access_token_encrypted: otherKeyCiphertext('mcp-b'), refresh_token_encrypted: null })
      const before = JSON.stringify(tables)
      await expect(encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })).rejects.toThrow(/do not open/)
      expectNothingWritten(before)
    })

    it('refuses with no key at all', async () => {
      const key = process.env.CREDENTIAL_ENCRYPTION_KEY
      delete process.env.CREDENTIAL_ENCRYPTION_KEY
      try {
        const before = JSON.stringify(tables)
        await expect(encryptPlaintextOAuthTokens(fakeSupabase(), { execute: true })).rejects.toBeInstanceOf(TokenBackfillRefused)
        expectNothingWritten(before)
        // A dry run still counts, and says it skipped the key check.
        expect(await encryptPlaintextOAuthTokens(fakeSupabase(), { execute: false })).toMatchObject({ toEncrypt: 2, keyOpened: null })
      } finally {
        process.env.CREDENTIAL_ENCRYPTION_KEY = key
      }
    })
  })
})

describe('the pieces', () => {
  it('checkCredentialKey: proven only when one opens and none fails', () => {
    expect(checkCredentialKey([])).toEqual({ opened: 0, failed: 0, proven: false })
    expect(checkCredentialKey([encryptOAuthToken('a')])).toEqual({ opened: 1, failed: 0, proven: true })
    expect(checkCredentialKey([otherKeyCiphertext('a')])).toEqual({ opened: 0, failed: 1, proven: false })
    expect(checkCredentialKey([encryptOAuthToken('a'), otherKeyCiphertext('b')])).toMatchObject({ proven: false })
  })

  it('migratesOnRefresh: Jira and Linear with an expiry only', () => {
    expect(migratesOnRefresh({ provider: 'jira', expires_at: EXPIRES })).toBe(true)
    expect(migratesOnRefresh({ provider: 'linear', expires_at: EXPIRES })).toBe(true)
    expect(migratesOnRefresh({ provider: 'jira', expires_at: null })).toBe(false)
    expect(migratesOnRefresh({ provider: 'google', expires_at: EXPIRES })).toBe(false)
  })

  it('plaintextTokenPatch: only plaintext columns, a null refresh token stays null, idempotent', () => {
    const legacy = { access_token: 'ya29.x', refresh_token: '1//r' as string | null }
    const patch = plaintextTokenPatch(legacy)!
    expect(decryptOAuthToken(patch.access_token!)).toBe('ya29.x')
    expect(decryptOAuthToken(patch.refresh_token!)).toBe('1//r')
    expect(plaintextTokenPatch({ ...legacy, ...patch })).toBeNull()
    expect(Object.keys(plaintextTokenPatch({ access_token: encryptOAuthToken('a'), refresh_token: 'r' })!)).toEqual(['refresh_token'])
    expect(Object.keys(plaintextTokenPatch({ access_token: 'gho_x', refresh_token: null })!)).toEqual(['access_token'])
  })
})
