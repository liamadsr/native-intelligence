import { describe, expect, it } from 'vitest'
import { SLACK_REPLY_MAX_CHARS, markdownToSlack } from '../format'

describe('markdownToSlack', () => {
  it('turns markdown emphasis, links, headings and bullets into Slack’s own', () => {
    expect(markdownToSlack('**Bold** and *italic* and ~~gone~~')).toBe('*Bold* and _italic_ and ~gone~')
    expect(markdownToSlack('See [the doc](https://dial8.ai/docs) now')).toBe('See <https://dial8.ai/docs|the doc> now')
    expect(markdownToSlack('## Today\n- standup at 9\n- review at 2')).toBe('*Today*\n• standup at 9\n• review at 2')
  })

  it('escapes Slack’s three characters outside code, and leaves code alone', () => {
    expect(markdownToSlack('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(markdownToSlack('run `**x**` then\n```\n**y**\n```')).toBe('run `**x**` then\n```\n**y**\n```')
  })

  it('never lets link text open a second link', () => {
    expect(markdownToSlack('[a|b](https://x.y)')).toBe('<https://x.y|a/b>')
  })

  it('cuts a long reply at a line, pointing to the rest in Dial8', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} with some words`).join('\n')
    const out = markdownToSlack(long, { moreLink: 'https://dial8.ai/account' })
    expect(out.length).toBeLessThanOrEqual(SLACK_REPLY_MAX_CHARS)
    expect(out.endsWith('_The rest is in Dial8: <https://dial8.ai/account|open it>._')).toBe(true)
  })
})

describe('markdownToSlack: HTML comments', () => {
  it('drops a trailing comment', () => {
    expect(markdownToSlack('Moved it to Friday.\n\n<!-- card:4 -->')).toBe('Moved it to Friday.')
    expect(markdownToSlack('Moved it to Friday. <!-- card:4 -->')).toBe('Moved it to Friday.')
  })

  it('keeps one space where a comment sat between two words', () => {
    expect(markdownToSlack('Your board <!-- card:1 --> is ready.')).toBe('Your board is ready.')
    expect(markdownToSlack('Run <!-- card:2 --> `npm test` now.')).toBe('Run `npm test` now.')
  })

  it('keeps the line break after a comment that ends a line or a list item', () => {
    expect(markdownToSlack('Moved it to Friday. <!-- card:4 -->\nWant me to text Sam?')).toBe('Moved it to Friday.\nWant me to text Sam?')
    expect(markdownToSlack('Your options:\n- Tuesday 9am <!-- card:1 -->\n- Friday 10am <!-- card:2 -->')).toBe(
      'Your options:\n• Tuesday 9am\n• Friday 10am',
    )
  })

  it('drops a proposal marker', () => {
    expect(markdownToSlack('Close it?\n<!-- proposal:3f2a-91 -->\nSay yes.')).toBe('Close it?\nSay yes.')
  })

  it('is empty when the reply was only a comment', () => {
    expect(markdownToSlack('<!-- card:4 -->')).toBe('')
  })

  it('keeps a comment inside code, escaped like the rest of it', () => {
    expect(markdownToSlack('Add `<!-- x -->` here:\n```\n<!-- header -->\n```')).toBe(
      'Add `&lt;!-- x --&gt;` here:\n```\n&lt;!-- header --&gt;\n```',
    )
  })
})
