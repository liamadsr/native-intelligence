/**
 * The cloud browser's approval grant (src/lib/browser-agent/approval-grant.ts):
 * a card names one step by origin, target and context; the replay's grant lets
 * through only that step, and anything that isn't a well-formed grant is none.
 */
import { describe, expect, it } from 'vitest'
import { browserApprovalStep, grantCovers, readApprovalGrant } from '../approval-grant'

const summary = 'Place order\nTotal $42.10 · 2 items\nhttps://shop.example.com'

describe('approval grants', () => {
  it('reads the executor’s step summary', () => {
    expect(browserApprovalStep(summary)).toEqual({ origin: 'https://shop.example.com', target: 'Place order', context_hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(browserApprovalStep('Press Enter in Message\n\nhttps://mail.example.com')).toMatchObject({ target: 'Press Enter in Message' })
    for (const bad of ['Place order', 'Place order\nhttps://shop.example.com', 'x\ny\nnot a url', 'x\ny\nftp://shop.example.com', 'x\ny\nhttps://shop.example.com/path', '\ny\nhttps://shop.example.com'])
      expect(browserApprovalStep(bad)).toBeNull()
  })

  it('covers only the exact step the person approved', () => {
    const grant = { approval_id: 'a1', ...browserApprovalStep(summary)! }
    expect(grantCovers(grant, summary)).toBe(true)
    expect(grantCovers(grant, 'Place order\nTotal $42.10 · 2 items\nhttps://evil.example.com')).toBe(false)
    expect(grantCovers(grant, 'Delete account\nTotal $42.10 · 2 items\nhttps://shop.example.com')).toBe(false)
    expect(grantCovers(grant, 'Place order\nTotal $942.10 · 20 items\nhttps://shop.example.com')).toBe(false)
    expect(grantCovers(null, summary)).toBe(false)
  })

  it('takes nothing else as a grant', () => {
    expect(readApprovalGrant({ approval_id: 'a1', origin: 'https://x.com', target: 'Send', context_hash: 'h' })).not.toBeNull()
    for (const bad of [null, 'grant', [], { origin: 'https://x.com', target: 'Send', context_hash: 'h' }, { approval_id: 'a1', origin: '', target: 'Send', context_hash: 'h' }])
      expect(readApprovalGrant(bad)).toBeNull()
  })
})
