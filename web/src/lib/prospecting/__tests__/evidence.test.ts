/**
 * THE CITATION BEHIND A CANDIDATE, pinned once.
 *
 * This logic used to live inside the row component and was about to be copied
 * into the entry panel, which is how two surfaces start citing two different
 * URLs for the same candidate. It is one function now and this suite is the
 * contract both readers share.
 */
import { describe, it, expect } from 'vitest'
import { entryEvidenceUrl, hostOf } from '@/lib/prospecting/evidence'

describe('entryEvidenceUrl', () => {
  it('prefers the profile’s why_fit citation over discovery’s why_match', () => {
    expect(
      entryEvidenceUrl({
        research: {
          why_match: { value: 'Discovery said', source_url: 'https://search.example/hit' },
          why_fit: { value: 'The profile said', source_url: 'https://querylane.io/customers' },
        },
      }),
    ).toBe('https://querylane.io/customers')
  })

  it('falls back to why_match.source_url, in both research blob shapes', () => {
    expect(
      entryEvidenceUrl({
        research: { fields: { why_match: { value: 'Because', source_url: 'https://a.example/1' } } },
      }),
    ).toBe('https://a.example/1')

    // The bare bag (no `fields` wrapper) is written by older research passes.
    expect(
      entryEvidenceUrl({ research: { why_match: { source_url: 'https://b.example/2' } } }),
    ).toBe('https://b.example/2')
  })

  it('skips a why_fit with no citation rather than stopping there', () => {
    expect(
      entryEvidenceUrl({
        research: {
          why_fit: { value: 'Ungrounded', source_url: null },
          why_match: { value: 'Grounded', source_url: 'https://c.example/3' },
        },
      }),
    ).toBe('https://c.example/3')
  })

  it('returns null when there is nothing to cite', () => {
    expect(entryEvidenceUrl({})).toBeNull()
    expect(entryEvidenceUrl({ research: null })).toBeNull()
    expect(entryEvidenceUrl({ research: 'not an object' })).toBeNull()
    expect(entryEvidenceUrl({ research: { why_match: { source_url: '   ' } } })).toBeNull()
  })

  it('survives junk inside the blob', () => {
    expect(
      entryEvidenceUrl({
        research: { why_fit: 'nope', why_match: [1, 2], products: { value: 'x' } },
      }),
    ).toBeNull()
  })
})

describe('hostOf', () => {
  it('strips www. and returns the bare host', () => {
    expect(hostOf('https://www.techcrunch.com/2026/01/x')).toBe('techcrunch.com')
    expect(hostOf('https://querylane.io/customers')).toBe('querylane.io')
  })

  it('returns null rather than a broken favicon domain', () => {
    // A null must suppress the whole affordance — an empty domain in the
    // favicon URL renders a broken image beside the row.
    expect(hostOf('not a url')).toBeNull()
    expect(hostOf('')).toBeNull()
  })
})
