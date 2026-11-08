import { describe, expect, it } from 'vitest'
import { stripHtmlComments } from '../strip-comments'

describe('stripHtmlComments', () => {
  it('drops a trailing comment, on its line or after the last word', () => {
    expect(stripHtmlComments('Moved it to Friday.\n\n<!-- card:4 -->')).toBe('Moved it to Friday.\n\n')
    expect(stripHtmlComments('Moved it to Friday. <!-- card:4 -->')).toBe('Moved it to Friday.')
  })

  it('keeps one space where a comment sat between two words', () => {
    expect(stripHtmlComments('Your board <!-- card:1 --> is ready.')).toBe('Your board is ready.')
    expect(stripHtmlComments('Your board<!-- card:1 -->is ready.')).toBe('Your board is ready.')
  })

  it('leaves one space for a run of comments between two words', () => {
    expect(stripHtmlComments('a <!-- x --><!-- y --> b')).toBe('a b')
    expect(stripHtmlComments('a <!-- x --> <!-- y --> b')).toBe('a b')
  })

  it('stays fast on long runs of comments and of unclosed openers', () => {
    const t0 = performance.now()
    stripHtmlComments('word ' + '<!-- a --> '.repeat(500) + '\n')
    stripHtmlComments('word ' + '<!-- '.repeat(500))
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('drops proposal markers, even one that wraps', () => {
    expect(stripHtmlComments('Close it?\n<!-- proposal:3f2a-91 -->\nSay yes.')).toBe('Close it?\nSay yes.')
    expect(stripHtmlComments('Close it?\n<!--\nproposal:3f2a-91\n-->\nSay yes.')).toBe('Close it?\nSay yes.')
  })

  it('keeps comments inside code, fenced or inline, and in a fence still streaming', () => {
    const md = 'See:\n```html\n<!-- header -->\n<p>hi</p>\n```\nand `<!-- x -->`.'
    expect(stripHtmlComments(md)).toBe(md)
    expect(stripHtmlComments('Half:\n```html\n<!-- header -->')).toBe('Half:\n```html\n<!-- header -->')
  })

  it('leaves a space between a word and the code span after a dropped comment', () => {
    expect(stripHtmlComments('Run <!-- card:2 --> `npm test` now.')).toBe('Run `npm test` now.')
  })

  it('drops a comment that holds a code span', () => {
    expect(stripHtmlComments('Done. <!-- see `x` -->')).toBe('Done.')
  })

  it('never eats prose after a literal <!--', () => {
    const md = 'Type <!-- to start a comment.\nThe arrow --> closes it.'
    expect(stripHtmlComments(md)).toBe(md)
  })

  it('returns text with no comment as it is', () => {
    const md = 'Plain `code` and ```\nfence\n```'
    expect(stripHtmlComments(md)).toBe(md)
  })
})
