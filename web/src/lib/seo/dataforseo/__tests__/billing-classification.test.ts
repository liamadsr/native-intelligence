/**
 * Balance / billing failure classification.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { createDataforseoBillingClassifier } from '@/lib/seo/dataforseo/billing-classification'
import { describe, expect, it } from 'vitest'

const classify = createDataforseoBillingClassifier({
  pathPrefix: '/backlinks/',
  billingIssueCode: 'INSUFFICIENT_PROVIDER_BALANCE',
  billingIssueMessage: 'billing issue',
})

describe('createDataforseoBillingClassifier', () => {
  it.each([
    [
      'the path is outside the configured prefix',
      402,
      'payment required',
      '/v3/serp/google/live',
    ],
    [
      'neither status nor text matches',
      500,
      'boom',
      '/v3/backlinks/summary/live',
    ],
  ])('returns null when %s', (_label, status, message, path) => {
    expect(classify(status, message, path)).toBe(null)
  })

  it.each([40200, 40210, 402])(
    'translates billing status %s into the configured billing error code',
    (status) => {
      const err = classify(status, '', '/v3/backlinks/summary/live')
      expect(err?.code).toBe('INSUFFICIENT_PROVIDER_BALANCE')
    },
  )

  it('translates billing signals in the message case-insensitively', () => {
    const err = classify(
      undefined,
      'INSUFFICIENT funds',
      '/v3/backlinks/summary/live',
    )
    expect(err?.code).toBe('INSUFFICIENT_PROVIDER_BALANCE')
  })
})
