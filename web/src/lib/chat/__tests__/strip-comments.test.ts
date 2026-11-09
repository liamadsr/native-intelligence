import { describe, expect, it } from 'vitest'
import { stripHtmlComments } from '../strip-comments'

describe('stripHtmlComments', () => {
  it('drops a trailing comment, on its line or after the last word', () => {
    expect(stripHtmlComments('Moved it to Friday.\n\n<!-- card:4 -->')).toBe('Moved it to Friday.\n\n')
    expect(stripHtmlComments('Moved it to Friday. <!-- card:4 -->')).toBe('Moved it to Friday.')
  })

  it('keeps the line break after a comment that ends a line', () => {
    expect(stripHtmlComments('Moved it to Friday. <!-- card:4 -->\nWant me to text Sam?')).toBe('Moved it to Friday.\nWant me to text Sam?')
    expect(stripHtmlComments('Booked. <!-- card:4 -->\n\nAnything else?')).toBe('Booked.\n\nAnything else?')
    expect(stripHtmlComments('Your options:\n- Tuesday 9am <!-- card:1 -->\n- Wednesday 2pm <!-- card:2 -->\n- Friday 10am')).toBe(
      'Your options:\n- Tuesday 9am\n- Wednesday 2pm\n- Friday 10am',
    )
    expect(stripHtmlComments('| Day | Time | <!-- card:1 -->\n|---|---|')).toBe('| Day | Time |\n|---|---|')
  })

  it('drops a line of nothing but comments, with its line break', () => {
    expect(stripHtmlComments('Done.\n<!-- card:2 --> <!-- card:3 -->\nNext.')).toBe('Done.\nNext.')
  })

  it('keeps one space where a comment sat between two words', () => {
    expect(stripHtmlComments('Your board <!-- card:1 --> is ready.')).toBe('Your board is ready.')
    expect(stripHtmlComments('Your board<!-- card:1 -->is ready.')).toBe('Your board is ready.')
  })

  it('leaves no space before punctuation', () => {
    expect(stripHtmlComments('See the card <!-- card:4 -->, then reply.')).toBe('See the card, then reply.')
    expect(stripHtmlComments('Moved it to Friday<!-- card:4 -->.')).toBe('Moved it to Friday.')
  })

  it('leaves one space for a run of comments between two words', () => {
    expect(stripHtmlComments('a <!-- x --><!-- y --> b')).toBe('a b')
    expect(stripHtmlComments('a <!-- x --> <!-- y --> b')).toBe('a b')
  })

  it('stays linear on long runs of spaces, comments and unclosed openers (80 KB each)', () => {
    const t0 = performance.now()
    stripHtmlComments('<!-- a -->\nx' + ' '.repeat(80_000) + 'y')
    stripHtmlComments('word ' + '<!-- a --> '.repeat(8_000) + '\n')
    stripHtmlComments('word ' + '<!-- '.repeat(16_000))
    stripHtmlComments(('\t'.repeat(50) + '<!-- ').repeat(1_500))
    expect(performance.now() - t0).toBeLessThan(200)
  })

  it('leaves a NUL slot that was in the text as it was', () => {
    expect(stripHtmlComments('\u00009\u0000 kept <!-- card:1 -->')).toBe('\u00009\u0000 kept')
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
