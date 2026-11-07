import { describe, expect, it } from 'vitest'
import { findUrls, splitByUrls } from '../linkify'

const urls = (text: string) => findUrls(text).map((m) => m.url)

describe('findUrls', () => {
  it('finds a bare URL in a sentence, with its position', () => {
    const text = 'Register: https://partiful.com/e/DRRSAxuu7tPWpRYixIgb'
    expect(findUrls(text)).toEqual([
      { start: 10, end: text.length, url: 'https://partiful.com/e/DRRSAxuu7tPWpRYixIgb' },
    ])
  })

  it('finds several, http and https, keeping paths, queries and fragments', () => {
    expect(urls('a http://x.com/a?b=1&c=2#d and https://y.org/p/q')).toEqual([
      'http://x.com/a?b=1&c=2#d',
      'https://y.org/p/q',
    ])
  })

  it('leaves sentence punctuation out of the link', () => {
    expect(urls('See https://x.com/a.')).toEqual(['https://x.com/a'])
    expect(urls('Go to https://x.com/a, then https://y.com/b!')).toEqual(['https://x.com/a', 'https://y.com/b'])
    expect(urls('Is it https://x.com/a?')).toEqual(['https://x.com/a'])
  })

  it('leaves a wrapping parenthesis out, but keeps a balanced one inside the URL', () => {
    expect(urls('(see https://x.com/a)')).toEqual(['https://x.com/a'])
    expect(urls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(urls('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
  })

  it('stops at quotes and angle brackets', () => {
    expect(urls('"https://x.com/a" and <https://y.com/b>')).toEqual(['https://x.com/a', 'https://y.com/b'])
  })

  it('reads the URL out of markdown link syntax', () => {
    expect(urls('[site](https://x.com/a)')).toEqual(['https://x.com/a'])
  })

  it('ignores text without a scheme, other schemes, and a scheme glued to a word', () => {
    expect(urls('partiful.com/e/abc www.x.com mailto:a@b.co ftp://x.com javascript:alert(1)')).toEqual([])
    expect(urls('xhttps://x.com')).toEqual([])
    expect(urls('https://')).toEqual([])
  })

  it('returns nothing for empty text', () => {
    expect(findUrls('')).toEqual([])
  })
})

describe('splitByUrls', () => {
  it('cuts text into plain runs and links, in order', () => {
    expect(splitByUrls('Register: https://x.com/e/1. Then go.')).toEqual([
      { text: 'Register: ' },
      { text: 'https://x.com/e/1', url: 'https://x.com/e/1' },
      { text: '. Then go.' },
    ])
  })

  it('returns the text whole when there is no link', () => {
    expect(splitByUrls('no links here')).toEqual([{ text: 'no links here' }])
  })

  it('handles a link at the very start and end', () => {
    expect(splitByUrls('https://a.com')).toEqual([{ text: 'https://a.com', url: 'https://a.com' }])
  })
})
