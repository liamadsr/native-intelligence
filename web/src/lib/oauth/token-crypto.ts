/**
 * Provider OAuth tokens at rest: user_oauth_tokens.access_token and
 * .refresh_token (Google, Microsoft, GitHub, HubSpot, Asana, Jira, Linear).
 *
 * Every write goes through encryptOAuthToken and every read through
 * decryptOAuthToken: the same AES-256-GCM `v1` format and
 * CREDENTIAL_ENCRYPTION_KEY the MCP and ChatGPT credentials use
 * (src/lib/crypto/credentials.ts). RLS keeps other users out; this makes what
 * script running in a user's own session can read (the anon-key API returns
 * the row to its owner), and a database dump, useless without the key.
 *
 * Rows written before this (security review 2026-10-31) hold plaintext. A read
 * tells the two apart by encryptCredential's exact shape, `v1.` + a 12-byte IV
 * (16 base64 characters) + a 16-byte tag (22 + `==`) + the ciphertext, which no
 * provider's token has (Google's start `ya29.`, GitHub's `gho_`, Linear's
 * `lin_oauth_`, JWTs `eyJ`), and passes plaintext through. Any write stores
 * the row encrypted, so rows migrate as they refresh or reconnect;
 * token-backfill.ts (scripts/encrypt-oauth-tokens.ts) encrypts the rest.
 */
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'

const ENCRYPTED_SHAPE = /^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]*={0,2}$/

/** Whether a stored token is a `v1` ciphertext rather than a legacy plaintext one. */
export function isEncryptedOAuthToken(stored: string): boolean {
  return ENCRYPTED_SHAPE.test(stored)
}

/** The value to write for a token. Throws when CREDENTIAL_ENCRYPTION_KEY is unset. */
export function encryptOAuthToken(plaintext: string): string {
  return encryptCredential(plaintext)
}

export function encryptOAuthTokenOrNull(plaintext: string | null | undefined): string | null {
  return plaintext ? encryptOAuthToken(plaintext) : null
}

/**
 * The token a stored value holds: decrypted, or a legacy plaintext one as is.
 * A ciphertext that does not decrypt (another key, or tampered) throws rather
 * than going out as a bearer token.
 */
export function decryptOAuthToken(stored: string): string {
  return isEncryptedOAuthToken(stored) ? decryptCredential(stored) : stored
}

export function decryptOAuthTokenOrNull(stored: string | null | undefined): string | null {
  return stored ? decryptOAuthToken(stored) : null
}
