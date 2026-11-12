/**
 * Row ids derived from what the row is about, so a crawl step that runs
 * twice (a retry after a crash) writes the same rows again instead of
 * duplicates: a page is (audit, url); an issue is (audit, type, page url,
 * key).
 */
import { createHash } from 'node:crypto'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** A UUID-shaped id from a hash (version 8, "custom", RFC 9562), stable for the same parts. */
function derivedUuid(parts: readonly string[]): string {
  // A unit separator between parts: ("a", "bc") and ("ab", "c") must differ.
  const hex = sha256Hex(parts.join('\u001f'))
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function pageRowId(auditId: string, url: string): string {
  return derivedUuid(['seo-audit-page', auditId, url])
}

export function issueRowId(
  auditId: string,
  issueType: string,
  pageUrl: string,
  dedupeKey = '',
): string {
  return derivedUuid([
    'seo-audit-issue',
    auditId,
    issueType,
    pageUrl,
    dedupeKey,
  ])
}
