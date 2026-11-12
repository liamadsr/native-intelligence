/**
 * What an issue row's details may hold (../clip.ts): site text cut to 300
 * characters, URLs to the URL limit, lists to 50 entries, at every depth,
 * and never a character cut in half.
 */
import { describe, expect, it } from 'vitest'
import { clipDetails, clipText, DETAIL_LIST_ITEMS, DETAIL_TEXT_CHARS } from '../clip'
import { MAX_URL_CHARS } from '../limits'

describe('clipText', () => {
  it('leaves a short string as it is', () => {
    expect(clipText('short', 10)).toBe('short')
  })

  it('counts and cuts by characters, so a surrogate pair is never split', () => {
    const emoji = '😀'.repeat(10)
    expect(clipText(emoji, 3)).toBe('😀😀😀')
    expect(clipText(`ab${emoji}`, 3)).toBe('ab😀')
    // Ten characters, twenty UTF-16 units: nothing to cut.
    expect(clipText(emoji, 10)).toBe(emoji)
  })
})

describe('clipDetails', () => {
  it('cuts site text to 300 characters and URLs to the URL limit', () => {
    const out = clipDetails({
      robotsMeta: `noindex, ${'x'.repeat(10_000)}`,
      canonicalUrl: `https://example.com/${'a'.repeat(10_000)}`,
      length: 88,
      flag: true,
      nothing: null,
    })
    expect(out.robotsMeta).toHaveLength(DETAIL_TEXT_CHARS)
    expect(out.canonicalUrl).toHaveLength(MAX_URL_CHARS)
    expect(out).toMatchObject({ length: 88, flag: true, nothing: null })
  })

  it('keeps 50 entries of a list, and clips nested lists and objects too', () => {
    const out = clipDetails({
      otherUrls: Array.from({ length: 500 }, (_, i) => `https://example.com/${i}`),
      nested: { deeper: { text: 'y'.repeat(1_000), list: Array.from({ length: 80 }, () => 'z'.repeat(400)) } },
    })
    expect(out.otherUrls as unknown[]).toHaveLength(DETAIL_LIST_ITEMS)
    const deeper = (out.nested as { deeper: { text: string; list: string[] } }).deeper
    expect(deeper.text).toHaveLength(DETAIL_TEXT_CHARS)
    expect(deeper.list).toHaveLength(DETAIL_LIST_ITEMS)
    expect(deeper.list.every((item) => item.length === DETAIL_TEXT_CHARS)).toBe(true)
  })

  it('stops at a depth no finding needs', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 50; i++) deep = { inner: deep }
    expect(JSON.stringify(clipDetails(deep)).length).toBeLessThan(200)
  })
})
