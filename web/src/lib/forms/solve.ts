/**
 * The bot check's work, in the browser (forms phase 3): an answer whose
 * sha256(token + ":" + answer) starts with `difficulty` zero bits, the same
 * test the server makes (./challenge.ts). Digests run in batches through
 * crypto.subtle, which is asynchronous per call: a batch keeps it busy
 * instead of waiting on each one. public/f/embed.js carries its own copy
 * (it has no build step).
 *
 * Client-safe: Web Crypto only.
 */

const BATCH = 256
/** Far past any answer a fair challenge needs (2^difficulty on average): a stop, never reached in practice. */
const MAX_TRIES = 1 << 26

/** Zero bits at the start of `bytes`. Pure. */
export function zeroBits(bytes: Uint8Array): number {
  let bits = 0
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8
      continue
    }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

/** Find an answer to `token`. */
export async function solveFormChallenge(token: string, difficulty: number, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const encoder = new TextEncoder()
  for (let start = 0; start < MAX_TRIES; start += BATCH) {
    const digests = await Promise.all(Array.from({ length: BATCH }, (_, i) => subtle.digest('SHA-256', encoder.encode(`${token}:${start + i}`))))
    for (let i = 0; i < BATCH; i++) if (zeroBits(new Uint8Array(digests[i])) >= difficulty) return String(start + i)
  }
  throw new Error('no answer found')
}
