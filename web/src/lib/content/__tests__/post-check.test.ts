/**
 * checkPost (content C0): the deterministic check lint_post returns.
 *
 * Pinned:
 *   - a clean, cited post is ok and gets its platform's compose link;
 *   - lint findings come back quoted, per thread part, worst first;
 *   - the public-safe screen: an outside name or a source problem withholds
 *     the link; a price is a problem unless the post cites the person's own
 *     pricing (the product doc or a document a person wrote), then a
 *     note the person sees;
 *   - the evidence boundary: no sources and not marked an idea is not ok;
 *   - threads: each part against the limit, the link for the first part, the
 *     surface's part limit, and single posts only where there are no threads.
 */
import { describe, expect, it } from 'vitest'
import { checkPost } from '../post-check'
import { blockedPhrases } from '../public-safe'

const CLEAN = 'We shipped voice notes this week.\n\nSay what you did after a call and Native Intelligence files the actions for you. Three tries to get the timing right.'

describe('checkPost', () => {
  it('a clean, cited post is ok and links to the compose page', () => {
    const r = checkPost({ surface: 'x', parts: [CLEAN], sourceCount: 1 })
    expect(r.ok).toBe(true)
    expect(r.platform).toBe('X')
    expect(r.public_safe).toEqual({ ok: true })
    expect(r.post_link).toBe(`https://x.com/intent/post?text=${encodeURIComponent(CLEAN)}`)
    expect(r.parts).toEqual([{ chars: [...CLEAN].length, limit: 280, over: false }])
    expect(r.next).toMatch(/Nothing posts until they post it on X/)
  })

  it('quotes what to fix, worst first, and a hard limit fails it', () => {
    const r = checkPost({ surface: 'x', parts: [`${'Long. '.repeat(60)} Let that sink in.`], sourceCount: 1 })
    expect(r.ok).toBe(false)
    expect(r.lint[0]).toMatchObject({ rule: 'length', severity: 'high' })
    expect(r.lint.some((n) => n.rule === 'bait' && /let that sink in/i.test(n.quote))).toBe(true)
    expect(r.parts[0].over).toBe(true)
    // Lint never withholds the link: the person may still post what they choose.
    expect(r.post_link).not.toBeNull()
  })

  it('an outside name withholds the link; so does a problem a source carries', () => {
    const phrases = blockedPhrases({ people: [{ full: 'Dana Whitfield' }], companies: ['Acme Corp'] })
    const named = checkPost({ surface: 'x', parts: ['Great call with Acme today about onboarding.'], sourceCount: 1, blockedPhrases: phrases })
    expect(named.public_safe).toEqual({ ok: false, problems: [{ reason: expect.stringMatching(/names someone from outside/), quote: 'acme' }] })
    expect(named.post_link).toBeNull()
    expect(named.ok).toBe(false)
    expect(named.next).toMatch(/No post link until it passes/)

    const mail = checkPost({ surface: 'x', parts: [CLEAN], sourceCount: 1, sourceProblems: [{ reason: 'It rests on an email; mail never goes public.', quote: 'sam@acme.com' }] })
    expect(mail.post_link).toBeNull()
    expect(mail.public_safe.ok).toBe(false)
  })

  it('a price is a problem unless it rests on the person\'s own pricing (review S4): then a note they see', () => {
    const text = 'Native Intelligence Pro is now $20 a month.'
    // From a call, or from shipped work alone: it may be a customer's price or a deal.
    const bare = checkPost({ surface: 'x', parts: [text], sourceCount: 1 })
    expect(bare.public_safe.ok).toBe(false)
    expect(bare.post_link).toBeNull()
    const own = checkPost({ surface: 'x', parts: [text], sourceCount: 1, ownPricingSource: true })
    expect(own.public_safe).toEqual({ ok: true })
    expect(own.lint).toContainEqual(expect.objectContaining({ rule: 'public_safe', severity: 'low', quote: '$20' }))
    expect(own.ok).toBe(true)
  })

  it('a first name or a one-word company matches only as written (review S3)', () => {
    const named = checkPost({ surface: 'x', parts: ['Priya told us Linear runs on it now.'], sourceCount: 1, blockedWords: ['Priya'] })
    expect(named.public_safe).toMatchObject({ ok: false, problems: [{ quote: 'Priya' }] })
    const company = checkPost({ surface: 'x', parts: ['Linear runs every standup on it now.'], sourceCount: 1, blockedWords: ['Linear'] })
    expect(company.post_link).toBeNull()
    // Lower case, it's an ordinary word.
    expect(checkPost({ surface: 'x', parts: ['Progress has been linear this quarter.'], sourceCount: 1, blockedWords: ['Linear'] }).public_safe).toEqual({ ok: true })
  })

  it('the evidence boundary: no sources is not ok unless it is marked an idea', () => {
    const bare = checkPost({ surface: 'x', parts: [CLEAN], sourceCount: 0 })
    expect(bare.ok).toBe(false)
    // No link either (review S3): an unsourced post is not handed out to post.
    expect(bare.post_link).toBeNull()
    expect(bare.sources).toEqual({ count: 0, idea: false, unsourced: true })
    expect(bare.next).toMatch(/sources/)
    const idea = checkPost({ surface: 'x', parts: [CLEAN], sourceCount: 0, idea: true })
    expect(idea.ok).toBe(true)
    expect(idea.sources).toEqual({ count: 0, idea: true, unsourced: false })
  })

  it('a thread: each part against the limit, notes say which part, the link carries the first part', () => {
    const parts = ['We rebuilt our onboarding in a week.', 'Day one: we cut the form to one field. Follow me for more.']
    const r = checkPost({ surface: 'x', parts, sourceCount: 2 })
    expect(r.parts).toHaveLength(2)
    expect(r.lint).toContainEqual(expect.objectContaining({ rule: 'bait', part: 2 }))
    expect(r.post_link).toBe(`https://x.com/intent/post?text=${encodeURIComponent(parts[0])}`)
    expect(checkPost({ surface: 'x', parts: ['Clean first part.', 'Clean second part.'], sourceCount: 1 }).next).toMatch(/post the rest as replies on X/)
  })

  it('a thread too long, or a thread where there are none (LinkedIn), fails on length', () => {
    const many = Array.from({ length: 11 }, (_, i) => `Part ${i + 1} of the story.`)
    expect(checkPost({ surface: 'x', parts: many, sourceCount: 1 }).lint[0]).toMatchObject({ rule: 'length', severity: 'high', quote: '11 parts' })
    const li = checkPost({ surface: 'linkedin', parts: ['One.', 'Two.'], sourceCount: 1 })
    expect(li.ok).toBe(false)
    expect(li.lint[0].fix).toMatch(/single posts/)
  })

  it('an empty draft is not ok and has no link', () => {
    const r = checkPost({ surface: 'bluesky', parts: ['  '], sourceCount: 1 })
    expect(r.ok).toBe(false)
    expect(r.post_link).toBeNull()
    expect(r.next).toBe('The draft is empty.')
  })
})
