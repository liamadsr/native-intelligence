/**
 * Brand mentions and citations in AI answers (../matching.ts), with the
 * source project's cases ported onto made-up brands.
 */
import { describe, expect, it } from 'vitest'
import {
  aiMentionSpans,
  aiPromptIsBranded,
  matchAiBrand,
  matchAiBrands,
  ownedAiDomain,
  type ParsedAiAnswer,
} from '../matching'

const brand = { name: 'Fernhill', domain: 'fernhillstudio.example', own: true }

function answer(text: string, citedHosts: string[] = []): ParsedAiAnswer {
  return {
    answerMarkdown: text,
    answerText: text,
    citations: citedHosts.map((domain, index) => ({
      url: `https://${domain}/guide`,
      domain,
      title: null,
      position: index + 1,
    })),
    collectedAt: null,
  }
}

describe('brand mentions', () => {
  it.each([
    ['Fernhill is an independent design studio.', 0],
    ['Fernhill’s identity work is well known.', 0],
    ['Try fernhillstudio.example for brand work.', 4],
    ['Fernhillsomething and MyFernhill are different names.', null],
    [
      'Links: https://fernhillstudio.example/Fernhill and www.fernhillstudio.example/Fernhill',
      null,
    ],
    ['Email Fernhill@example.com or hello@fernhillstudio.example.', null],
    ['An unrelated studio has similar services.', null],
  ])('%s', (text, firstMention) => {
    expect(matchAiBrand(answer(text), brand)).toMatchObject({
      mentioned: firstMention !== null,
      firstMention,
    })
  })

  it.each([
    ['acmeride.example', true],
    ['shop.acmeride.example', false],
  ])('a bare name mentions a brand named %s: %s', (domain, mentioned) => {
    const text =
      '- [Acmeride](https://www.acmeride.example/): Connects directly.'
    expect(matchAiBrand(answer(text), { name: domain, domain }).mentioned).toBe(
      mentioned,
    )
  })

  it('matches the brand’s other names', () => {
    expect(
      matchAiBrand(answer('Ask Fernhill & Co about it.'), {
        name: 'Fernhill Studio',
        domain: 'fernhillstudio.example',
        aliases: ['Fernhill & Co'],
      }),
    ).toMatchObject({ mentioned: true, firstMention: 4 })
  })

  it('returns original UTF-16 offsets through emoji and both Unicode accent forms', () => {
    const text = '🔎 Café and Café are the same spelling.'
    const spans = aiMentionSpans(text, ['Café'])
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      'Café',
      'Café',
    ])
    expect(spans[0]).toEqual({ start: 3, end: 7 })
  })

  it('escapes regex syntax and keeps the longest overlapping name', () => {
    const text = 'C++ Tools and Open Studio Tools'
    expect(
      aiMentionSpans(text, [
        'C++ Tools',
        'Open Studio',
        'Open Studio Tools',
      ]).map((s) => text.slice(s.start, s.end)),
    ).toEqual(['C++ Tools', 'Open Studio Tools'])
  })
})

describe('brand citations', () => {
  it.each([
    'fernhillstudio.example',
    'www.fernhillstudio.example',
    'blog.fernhillstudio.example',
  ])('counts a cited page on %s', (host) => {
    expect(matchAiBrand(answer('Other studios.', [host]), brand)).toMatchObject(
      { mentioned: false, cited: true },
    )
  })
  it.each([
    'fernhillstudio.example.evil.test',
    'notfernhillstudio.example',
    'fernhillstudio.test',
  ])('does not count %s', (host) => {
    expect(ownedAiDomain(host, brand.domain)).toBe(false)
    expect(matchAiBrand(answer('Other studios.', [host]), brand).cited).toBe(
      false,
    )
  })
})

describe('positions', () => {
  it('orders the brands an answer names by first mention, 1 first', () => {
    const results = matchAiBrands(
      answer('Oakline leads; Fernhill follows. Birchway is not named first.'),
      [
        { ...brand, aliases: [] },
        { name: 'Oakline', domain: 'oakline.example', own: false, aliases: [] },
        {
          name: 'Birchway',
          domain: 'birchway.example',
          own: false,
          aliases: [],
        },
        { name: 'Elmrow', domain: 'elmrow.example', own: false, aliases: [] },
      ],
    )
    expect(results.map((r) => [r.name, r.position])).toEqual([
      ['Fernhill', 2],
      ['Oakline', 1],
      ['Birchway', 3],
      ['Elmrow', null],
    ])
  })
})

describe('branded prompt cohort', () => {
  it.each([
    'What is Fernhill?',
    'Review https://fernhillstudio.example',
    'What does www.fernhillstudio.example offer?',
    'Review blog.fernhillstudio.example/work',
  ])('includes %s', (prompt) => {
    expect(aiPromptIsBranded(prompt, brand)).toBe(true)
  })
  it.each([
    'Best independent design studios?',
    'Review https://fernhillstudio.example.evil.test',
    'Review https://notfernhillstudio.example',
  ])('excludes %s', (prompt) => {
    expect(aiPromptIsBranded(prompt, brand)).toBe(false)
  })
  it('counts the brand’s other names', () => {
    expect(
      aiPromptIsBranded('Is Fernhill & Co any good?', {
        name: 'Fernhill Studio',
        domain: 'fernhillstudio.example',
        aliases: ['Fernhill & Co'],
      }),
    ).toBe(true)
  })
})
