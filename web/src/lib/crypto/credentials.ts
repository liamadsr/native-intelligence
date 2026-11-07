/**
 * Symmetric encryption for storing third-party credentials at rest.
 *
 * Used by the connected MCP server registry (and any future feature that
 * needs to stash a bearer token / OAuth token belonging to an external
 * service that the application later needs to *send* somewhere).
 *
 * Why not pgcrypto: keeping the key out of the database means a Postgres
 * dump alone is not enough to compromise tokens.
 *
 * Format of the returned ciphertext string:
 *
 *   v1.<iv-base64>.<auth-tag-base64>.<ciphertext-base64>
 *
 * The "v1" prefix lets us evolve the algorithm later without ambiguity.
 *
 * Required env: CREDENTIAL_ENCRYPTION_KEY — base64-encoded 32 bytes.
 *   openssl rand -base64 32
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const VERSION = 'v1'
const IV_BYTES = 12
const KEY_BYTES = 32

let cachedKey: Uint8Array | null = null

function toU8(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function getKey(): Uint8Array {
  if (cachedKey) return cachedKey
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    )
  }
  const key = toU8(Buffer.from(raw, 'base64'))
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    )
  }
  cachedKey = key
  return key
}

export function encryptCredential(plaintext: string): string {
  const key = getKey()
  const iv = toU8(randomBytes(IV_BYTES))
  const cipher = createCipheriv(ALGO, key, iv)
  const ct1 = cipher.update(plaintext, 'utf8')
  const ct2 = cipher.final()
  const ciphertext = new Uint8Array(ct1.length + ct2.length)
  ciphertext.set(ct1, 0)
  ciphertext.set(ct2, ct1.length)
  const authTag = toU8(cipher.getAuthTag())
  return [
    VERSION,
    Buffer.from(iv).toString('base64'),
    Buffer.from(authTag).toString('base64'),
    Buffer.from(ciphertext).toString('base64'),
  ].join('.')
}

export function decryptCredential(payload: string): string {
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Malformed encrypted credential payload')
  }
  const [, ivB64, tagB64, ctB64] = parts
  const key = getKey()
  const iv = toU8(Buffer.from(ivB64, 'base64'))
  const authTag = toU8(Buffer.from(tagB64, 'base64'))
  const ciphertext = toU8(Buffer.from(ctB64, 'base64'))
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(authTag)
  const pt1 = decipher.update(ciphertext)
  const pt2 = decipher.final()
  const plaintext = new Uint8Array(pt1.length + pt2.length)
  plaintext.set(pt1, 0)
  plaintext.set(pt2, pt1.length)
  return Buffer.from(plaintext).toString('utf8')
}

/** Convenience: encrypts only if input is non-empty, returns null otherwise. */
export function encryptCredentialOrNull(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null
  return encryptCredential(plaintext)
}

/** Convenience: decrypts only if input is non-empty, returns null otherwise. */
export function decryptCredentialOrNull(payload: string | null | undefined): string | null {
  if (!payload) return null
  return decryptCredential(payload)
}
