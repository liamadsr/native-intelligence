// A video's digest: the hash of its document written with keys in a fixed order, so the same edit always has the
// same digest whatever order Postgres (jsonb) or the editor wrote its keys in. Every writer names the digest it
// read, and a write against a digest that is no longer current is refused (videos.ts).
import { createHash } from 'node:crypto'

/** JSON with object keys sorted at every level. Keys whose value is undefined are left out, as JSON.stringify does. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && typeof item !== 'function')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

/** Hex sha256 of a string or bytes. */
export const sha256Hex = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** The digest of a document (a video's edit): sha256 of its stable JSON. */
export const docDigest = (doc: unknown) => sha256Hex(stableStringify(doc))

/** True when two values are the same JSON, key order aside. */
export const sameJson = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b)

/** A value as it will read back from the database: JSON round-tripped (undefined keys gone). */
export const asStored = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
