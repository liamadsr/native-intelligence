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
