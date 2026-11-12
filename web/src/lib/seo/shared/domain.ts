/**
 * Domain input normalization and the DataForSEO filter-condition budget.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { isValidDomainHost } from '@/lib/seo/shared/researchScope'
import { z } from 'zod'

/**
 * Extract and validate a bare hostname from user input that may be a full URL.
 * Strips protocol, www prefix, path, query-string, and hash.
 */
export function normalizeDomain(input: string): string {
  let d = input.trim().toLowerCase()
  // Ensure URL() can parse the input by adding a protocol if missing
  if (!/^[a-z]+:\/\//.test(d)) d = `https://${d}`
  const { hostname } = new URL(d) // throws on truly invalid input
  return hostname.replace(/^www\./, '')
}

/** Zod field: accepts a bare domain or full URL, outputs a clean hostname. */
export const domainField = z
  .string()
  .min(1)
  .max(253)
  .transform((val, ctx) => {
    try {
      const hostname = normalizeDomain(val)
      if (!hostname.includes('.') || !isValidDomainHost(hostname)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter a valid domain like example.com',
        })
        return z.NEVER
      }
      return hostname
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a valid domain like example.com',
      })
      return z.NEVER
    }
  })

/** DataForSEO accepts at most this many filter conditions per request. */
export const MAX_DATAFORSEO_FILTER_CONDITIONS = 8
