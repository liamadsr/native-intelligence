/**
 * Turning a provider's AI answer into what we keep (../evidence.ts), with the
 * source project's cases ported onto made-up sites.
 */
import { describe, expect, it } from 'vitest'
import {
  markdownToText,
  parseDataforseoAnswer,
  parseLlmResponseAnswer,
} from '../evidence'

describe('queued answers', () => {
  it('keeps safe cited pages without tracking parameters and drops citation pills from prose', () => {
    const result = parseDataforseoAnswer(
      {
        datetime: '2026-09-30 18:41:09 +00:00',
        markdown:
          '- **Fernhill** is independent. [fernhillstudio.example](https://fernhillstudio.example/blog?utm_source=chatgpt.com) See [Oakline on its site](https://oakline.example/).',
        sources: [
          {
            url: 'https://fernhillstudio.example/blog?utm_source=chatgpt.com',
            title: 'Blog',
          },
          { url: 'javascript:alert(1)' },
        ],
        search_results: [{ url: 'https://example.com/retrieved' }],
      },
      'chatgpt',
    )
    expect(result).toMatchObject({
      answerText: 'Fernhill is independent.  See Oakline on its site.',
      citations: [
        {
          url: 'https://fernhillstudio.example/blog',
          domain: 'fernhillstudio.example',
          title: 'Blog',
          position: 1,
        },
      ],
      collectedAt: '2026-09-30T18:41:09.000Z',
    })
  })

  it('removes NUL characters, which Postgres text columns reject', () => {
    const result = parseDataforseoAnswer(
      {
        markdown: 'Fern\0hill',
        sources: [
          { url: 'https://fernhillstudio.example/', title: 'Fern\0hill' },
        ],
      },
      'chatgpt',
    )
    expect(result).toMatchObject({
      answerMarkdown: 'Fernhill',
      citations: [{ title: 'Fernhill' }],
    })
  })

  it('reads every Google AI Overview reference as a citation', () => {
    const result = parseDataforseoAnswer(
      {
        items: [
          {
            type: 'ai_overview',
            markdown: 'Use Oakline.[[1]](https://oakline.example/blog)',
            references: [{ url: 'https://oakline.example/blog' }],
            items: [
              {
                references: [{ url: 'https://birchway.example/' }],
                links: [{ url: 'https://elmrow.example/' }],
              },
            ],
          },
        ],
      },
      'google_ai_overview',
    )
    expect(result?.answerText).toBe('Use Oakline.')
    expect(result?.citations.map((c) => c.domain)).toEqual([
      'oakline.example',
      'birchway.example',
    ])
  })

  it('treats a results page without an AI Overview as no answer', () => {
    expect(
      parseDataforseoAnswer(
        {
          items: [{ type: 'organic', url: 'https://fernhillstudio.example/' }],
        },
        'google_ai_overview',
      ),
    ).toMatchObject({ answerMarkdown: null, citations: [] })
  })

  it('treats a null result as no answer and an unreadable one as unreadable', () => {
    expect(parseDataforseoAnswer(null, 'chatgpt')).toMatchObject({
      answerMarkdown: null,
      answerText: '',
    })
    expect(parseDataforseoAnswer({ markdown: 42 }, 'chatgpt')).toBeNull()
  })

  it('de-duplicates cited pages, keeping the first title found', () => {
    const result = parseDataforseoAnswer(
      {
        markdown: 'Text.',
        sources: [
          { url: 'https://oakline.example/a#x' },
          { url: 'https://oakline.example/a?gclid=1', title: 'A' },
          { url: 'https://user:pw@oakline.example/b' },
        ],
      },
      'gemini',
    )
    expect(result?.citations).toEqual([
      {
        url: 'https://oakline.example/a',
        domain: 'oakline.example',
        title: 'A',
        position: 1,
      },
    ])
  })
})

describe('live model answers', () => {
  it('joins the message sections and reads their annotations as citations', () => {
    const result = parseLlmResponseAnswer({
      items: [
        { type: 'reasoning', sections: [{ text: 'thinking' }] },
        {
          type: 'message',
          sections: [
            {
              text: 'Fernhill is good.',
              annotations: [
                { url: 'https://fernhillstudio.example/', title: 'Home' },
              ],
            },
            { text: 'So is Oakline.' },
          ],
        },
      ],
    })
    expect(result).toMatchObject({
      answerText: 'Fernhill is good.\n\nSo is Oakline.',
      citations: [{ domain: 'fernhillstudio.example', title: 'Home' }],
    })
  })

  it('an empty answer is no answer', () => {
    expect(parseLlmResponseAnswer({ items: [] })).toMatchObject({
      answerMarkdown: null,
      answerText: '',
    })
  })
})

describe('markdownToText', () => {
  it('drops images, numbered pills and emphasis, keeps link labels', () => {
    expect(
      markdownToText(
        '## Picks\n* **Oakline** ![logo](https://x.example/l.png) [1](https://oakline.example/) [their site](https://oakline.example/)',
      ),
    ).toBe('Picks\nOakline   their site')
  })
})
