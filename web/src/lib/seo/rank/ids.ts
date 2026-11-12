/**
 * Row ids derived from what the row is about, so a step that runs twice (a
 * retry after a crash) writes the same rows again instead of duplicates: a
 * snapshot is (check, keyword, device). Same scheme as the site audit's
 * (../audit/ids.ts): a UUID-shaped SHA-256, version 8 ("custom", RFC 9562).
 */
import { createHash } from 'node:crypto'

function derivedUuid(parts: readonly string[]): string {
  // A unit separator between parts: ("a", "bc") and ("ab", "c") must differ.
  const hex = createHash('sha256').update(parts.join('\u001f')).digest('hex')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function snapshotRowId(
  runId: string,
  keywordId: string,
  device: string,
): string {
  return derivedUuid(['seo-rank-snapshot', runId, keywordId, device])
}

/** The key of one paid batch of a check: read round and batch number. */
export function postKey(read: number, batch: number): string {
  return `read-${read}-batch-${batch}`
}
