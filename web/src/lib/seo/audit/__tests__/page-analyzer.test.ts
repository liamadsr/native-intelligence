/**
 * The streaming HTML analyzer (../page-analyzer.ts). Cases ported from
 * OpenSEO's page-analyzer tests (MIT); their DOM-parity reference (cheerio)
 * is not a dependency here, so the documents are asserted field by field.
 */
import { describe, expect, it } from 'vitest'
import { analyzeHtml } from '../page-analyzer'

const PAGE_URL = 'https://example.com/blog/post'
const analyze = (html: string) => analyzeHtml(html, PAGE_URL, 200, 0)

describe('analyzeHtml on a full document', () => {
  const doc = `<!DOCTYPE html>
    <html><head>
      <title> The  Title </title>
      <meta name="description" content="  A description.  ">
      <meta name="robots" content="index, follow">
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="OG Desc">
      <meta property="og:image" content="/og.png">
      <link rel="canonical" href="https://example.com/blog/post">
      <link rel="alternate" hreflang="en" href="/en">
      <link rel="alternate" hreflang="de" href="/de">
      <script type="application/ld+json">{"@type":"Article"}</script>
    </head><body>
      <h1>Main <em>Heading</em></h1>
      <h2>Sub</h2><h3>Deep</h3><h2>Sub 2</h2>
      <p>Some visible body text with <strong>bold words</strong> here.</p>
      <script>ignored();</script>
      <style>.x{}</style>
      <svg><title>icon</title><text>svg text</text></svg>
      <noscript><img src="/ns.png"><p>noscript text</p></noscript>
      <img src="/a.png" alt="A picture">
      <img src="/b.png" alt="">
      <img src="/c.png">
      <a href="/relative">Relative <span>link</span></a>
      <a href="https://example.com/relative">Duplicate target</a>
      <a href="https://example.org/x" rel="NoFollow sponsored">External</a>
      <a href="mailto:x@example.com">Mail</a>
      <a href="#frag">Fragment</a>
      <a href="javascript:void(0)">JS</a>
    </body></html>`
  const result = analyzeHtmlFor(doc)

  function analyzeHtmlFor(html: string) {
    return analyzeHtml(html, PAGE_URL, 301, 123, 'https://example.com/next')
  }

  it('passes the request facts through', () => {
    expect(result).toMatchObject({
      url: PAGE_URL,
      statusCode: 301,
      responseTimeMs: 123,
      redirectUrl: 'https://example.com/next',
    })
  })

  it('reads the head: title, description, robots, Open Graph, canonical, hreflang, structured data', () => {
    expect(result).toMatchObject({
      title: 'The  Title',
      metaDescription: 'A description.',
      robotsMeta: 'index, follow',
      ogTitle: 'OG Title',
      ogDescription: 'OG Desc',
      ogImage: '/og.png',
      canonical: 'https://example.com/blog/post',
      hreflangTags: ['en', 'de'],
      hasStructuredData: true,
    })
  })

  it('reads headings in document order, with the H1 text across inline markup', () => {
    expect(result.h1s).toEqual(['Main Heading'])
    expect(result.headingOrder).toEqual([1, 2, 3, 2])
  })

  it('keeps images outside <noscript>, telling an empty alt from a missing one', () => {
    expect(result.images).toEqual([
      { src: '/a.png', alt: 'A picture' },
      { src: '/b.png', alt: '' },
      { src: '/c.png', alt: null },
    ])
  })

  it('keeps links resolved, deduped by target, skipping mailto, fragments and javascript', () => {
    expect(result.links).toEqual([
      {
        targetUrl: 'https://example.com/relative',
        anchor: 'Relative link',
        isInternal: true,
        isNofollow: false,
      },
      {
        targetUrl: 'https://example.org/x',
        anchor: 'External',
        isInternal: false,
        isNofollow: true,
      },
    ])
  })

  it('reads visible text only: no script, style, svg or noscript content', () => {
    expect(result.bodyText).toContain('Main Heading')
    expect(result.bodyText).toContain(
      'Some visible body text with bold words here.',
    )
    for (const hidden of [
      'ignored',
      '.x{}',
      'svg text',
      'icon',
      'noscript text',
    ]) {
      expect(result.bodyText).not.toContain(hidden)
    }
    expect(result.wordCount).toBe(result.bodyText.split(' ').length)
    expect(result.javascriptShell).toBe(false)
  })
})

describe('analyzeHtml on odd documents', () => {
  it('reads a fragment with no head, body or title', () => {
    const result = analyze(
      '<h1>Bare fragment</h1><p>Just text and a <a href="/x">link</a>.</p>',
    )
    expect(result.title).toBe('')
    expect(result.h1s).toEqual(['Bare fragment'])
    expect(result.bodyText).toBe('Bare fragment Just text and a link.')
    expect(result.links.map((l) => l.targetUrl)).toEqual([
      'https://example.com/x',
    ])
  })

  it('reads an empty document as empty', () => {
    expect(analyze('')).toMatchObject({
      title: '',
      metaDescription: '',
      canonical: null,
      h1s: [],
      headingOrder: [],
      wordCount: 0,
      bodyText: '',
      images: [],
      links: [],
      hasStructuredData: false,
      javascriptShell: false,
    })
  })

  it('does not count head text as body text', () => {
    const result = analyze(
      '<html><head><title>Head only</title><meta name="description" content="d"></head></html>',
    )
    expect(result.title).toBe('Head only')
    expect(result.metaDescription).toBe('d')
    expect(result.wordCount).toBe(0)
  })

  it('keeps the first title, description and canonical when there are several', () => {
    const result = analyze(`<html><head>
      <title>First</title><title>Second</title>
      <meta name="description" content="first desc">
      <meta name="description" content="second desc">
      <link rel="canonical" href="/first"><link rel="canonical" href="/second">
      </head><body><p>text</p></body></html>`)
    expect(result.title).toBe('First')
    expect(result.metaDescription).toBe('first desc')
    expect(result.canonical).toBe('/first')
  })

  it('ignores a <title> inside an inline SVG', () => {
    expect(
      analyze('<body><svg><title>Logo</title></svg><p>x</p></body>').title,
    ).toBe('')
  })

  it('closes an open link when another one opens, as a browser does', () => {
    const result = analyze(
      '<body><a href="/one">first <a href="/two">second</a></body>',
    )
    expect(result.links.map((l) => [l.targetUrl, l.anchor])).toEqual([
      ['https://example.com/one', 'first'],
      ['https://example.com/two', 'second'],
    ])
  })

  it('decodes entities in text and in link targets', () => {
    const result =
      analyze(`<html><head><title>A &amp; B &lt;C&gt;</title></head>
      <body><h1>Caf&eacute; &quot;menu&quot;</h1>
      <a href="/x?b=2&amp;a=1">Query &amp; anchor</a></body></html>`)
    expect(result.title).toBe('A & B <C>')
    expect(result.h1s).toEqual(['Café "menu"'])
    expect(result.links[0]).toMatchObject({
      targetUrl: 'https://example.com/x?a=1&b=2',
      anchor: 'Query & anchor',
    })
  })

  it('treats www and the bare domain as internal, other hosts as external', () => {
    const result = analyze(
      '<body><a href="https://www.example.com/a">a</a><a href="https://shop.example.com/b">b</a></body>',
    )
    expect(result.links.map((l) => l.isInternal)).toEqual([true, false])
  })
})

describe('analyzeHtml word count', () => {
  const analyzeBody = (body: string) => analyze(`<body>${body}</body>`)

  it.each([
    ['paragraphs', '<p>one</p><p>two</p>'],
    ['table cells', '<table><tr><td>one</td><td>two</td></tr></table>'],
    ['line breaks', 'one<br>two'],
    ['list items', '<ul><li>one</li><li>two</li></ul>'],
  ])('keeps word boundaries between %s in minified HTML', (_label, body) => {
    expect(analyzeBody(body).bodyText).toBe('one two')
  })

  it('does not split a word across inline markup', () => {
    expect(analyzeBody('<p>Open<strong>SEO</strong></p>').wordCount).toBe(1)
  })

  it('counts whitespace-heavy markup by words', () => {
    expect(
      analyzeBody(`<p>
        one
        two    three
      </p>`).wordCount,
    ).toBe(3)
  })

  it('counts words in scripts written without spaces', () => {
    expect(
      analyzeBody('<p>吉隆坡市中心永久地契公寓投资指南</p>').wordCount,
    ).toBe(8)
    expect(analyzeBody('<p>東京の不動産投資ガイド</p>').wordCount).toBe(5)
    expect(analyzeBody('<p>KLCC 公寓指南 2026</p>').wordCount).toBe(4)
  })
})

describe('analyzeHtml meta names are case-insensitive', () => {
  const analyzeHead = (head: string) => analyze(`<head>${head}</head>`)

  it('reads the first description whatever the case of its name', () => {
    expect(
      analyzeHead(
        '<meta name="Description" content="first"><meta name="description" content="second">',
      ).metaDescription,
    ).toBe('first')
  })

  it('reads robots for name=ROBOTS', () => {
    expect(
      analyzeHead('<meta name="ROBOTS" content="noindex">').robotsMeta,
    ).toBe('noindex')
  })
})

describe('analyzeHtml extraction caps', () => {
  it('keeps at most 1,000 links and 1,000 images per page', () => {
    const links = Array.from(
      { length: 1_100 },
      (_, i) => `<a href="/p/${i}">link ${i}</a>`,
    ).join('')
    const images = Array.from(
      { length: 1_100 },
      (_, i) => `<img src="/i/${i}.png">`,
    ).join('')
    const result = analyzeHtml(
      `<body>${links}${images}</body>`,
      'https://example.com/',
      200,
      100,
    )
    expect(result.links).toHaveLength(1_000)
    expect(result.images).toHaveLength(1_000)
  })

  it('cuts a long anchor text to 200 characters', () => {
    const result = analyze(
      `<body><a href="/x">${'word '.repeat(100)}</a></body>`,
    )
    expect(result.links[0].anchor).toHaveLength(200)
  })
})

describe('JavaScript app-shell detection', () => {
  it.each(['root', 'app', '__next', '__nuxt'])(
    'recognizes an empty %s app shell',
    (id) => {
      expect(
        analyze(
          `<body><div id="${id}">Loading...</div><script src="/app.js"></script></body>`,
        ).javascriptShell,
      ).toBe(true)
    },
  )

  it("recognizes Angular's app element", () => {
    expect(
      analyze(
        '<app-root></app-root><script type="module" src="/main.js"></script>',
      ).javascriptShell,
    ).toBe(true)
  })

  it.each([
    '<div id="root"><h2>A server-rendered heading</h2></div><script src="/app.js"></script>',
    '<div id="root"><a href="/about">About</a></div><script src="/app.js"></script>',
    '<div id="app"><img src="/photo.png"></div><script src="/app.js"></script>',
    '<div id="root"></div><script type="application/ld+json">{}</script>',
    '<p>Short but valid content</p><script src="/analytics.js"></script>',
    '<div id="root"></div>',
    `<div id="root">${'Readable server-rendered content '.repeat(10)}</div><script src="/app.js"></script>`,
  ])(
    'does not mistake ordinary HTML, hydrated content or structured data for a shell: %s',
    (html) => {
      expect(analyze(html).javascriptShell).toBe(false)
    },
  )
})
