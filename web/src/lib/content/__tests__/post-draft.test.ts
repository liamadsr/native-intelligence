/**
 * Post drafts across the four post surfaces (content C0): each has its own
 * compose page, the text rides the `text` parameter, and nothing posts until
 * the person posts it there. A card's surface comes from its payload; the
 * character count is the platform's own (X: a link is 23).
 */
import { describe, expect, it } from 'vitest'
import { POST_INTENT_BASES, POST_SURFACES, POST_SURFACE_NAME, postCardCopy, postDraftFromPayload, postIntentUrl, postLength, postLimit, xIntentUrl } from '../post-draft'
import { writingSurface } from '@/lib/writing/surfaces'

describe('post links', () => {
  it('every post surface is a registered post surface with a limit and a compose page', () => {
    expect([...POST_SURFACES]).toEqual(['x', 'linkedin', 'threads', 'bluesky'])
    for (const s of POST_SURFACES) {
      expect(writingSurface(s)?.kind, s).toBe('post')
      expect(postLimit(s), s).toBeGreaterThan(0)
      expect(POST_INTENT_BASES[s], s).toMatch(/^https:\/\//)
      expect(POST_SURFACE_NAME[s], s).toBeTruthy()
    }
  })

  it('carries the text, encoded, on each platform’s own page', () => {
    const text = 'Shipped: voice notes & a 2× faster inbox #buildinpublic'
    expect(postIntentUrl('x', text)).toBe(`https://x.com/intent/post?text=${encodeURIComponent(text)}`)
    expect(xIntentUrl(text)).toBe(postIntentUrl('x', text))
    expect(postIntentUrl('linkedin', text)).toBe(`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}`)
    expect(postIntentUrl('threads', text)).toBe(`https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`)
    expect(postIntentUrl('bluesky', text)).toBe(`https://bsky.app/intent/compose?text=${encodeURIComponent(text)}`)
    for (const s of POST_SURFACES) expect(new URL(postIntentUrl(s, text)).searchParams.get('text'), s).toBe(text)
  })

  it('counts length the platform’s way', () => {
    expect(postLength('x', `hi https://example.com/${'a'.repeat(100)}`)).toBe(3 + 23)
    expect(postLength('bluesky', 'hi https://example.com/long')).toBe(3)
    expect(postLength('linkedin', 'hi https://e.co')).toBe('hi https://e.co'.length)
  })
})

describe('a post card', () => {
  it('reads its surface from the payload, X when missing or unknown', () => {
    expect(postDraftFromPayload({ post_draft: { text: 'Hello', surface: 'linkedin' } })?.surface).toBe('linkedin')
    expect(postDraftFromPayload({ post_draft: { text: 'Hello' } })?.surface).toBe('x')
    expect(postDraftFromPayload({ post_draft: { text: 'Hello', surface: 'myspace' } })?.surface).toBe('x')
  })

  it('names the platform it opens', () => {
    const copy = postCardCopy({ post_draft: { text: 'We shipped voice notes.', surface: 'bluesky', chars: 23, limit: 300 } })
    expect(copy?.sentence).toMatch(/^on Bluesky: /)
    expect(copy?.details.at(-1)).toMatch(/Post opens Bluesky in your browser/)
    expect(copy?.done).toBe('Opened Bluesky with your post')
  })
})
