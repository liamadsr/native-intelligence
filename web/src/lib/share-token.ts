import crypto from 'crypto'

/**
 * Generate a cryptographically random share token.
 * 22 characters of base62 = ~131 bits of entropy.
 * URL-safe, impossible to guess.
 */
export function generateShareToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.randomBytes(22)
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join('')
}
