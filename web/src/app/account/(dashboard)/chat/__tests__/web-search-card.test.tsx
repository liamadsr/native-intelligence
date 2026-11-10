// @vitest-environment jsdom
/**
 * The "Searched the web" card for the provider-executed `web_search` tool.
 *
 * Two layers are covered:
 *  - the PURE normalizers (parseWebSearchOutput / readWebSearchQuery /
 *    webSearchHeadline), which absorb every branch of eve's Exa output schema
 *    plus the defensive shapes the transport can produce; and
 *  - a jsdom mount: ONE collapsed line by default (shimmering while it runs),
 *    the sources behind the disclosure, safe external links, and untrusted
 *    titles as text nodes, never markup.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import {
  WebSearchCard,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_VISIBLE_RESULTS,
  parseWebSearchOutput,
  readWebSearchQuery,
  webSearchHeadline,
  hostLabel,
} from '../web-search-card'

/** A minimal Exa success bag, shaped like WEB_SEARCH_EXA_OUTPUT_SCHEMA. */
function exaOutput(n: number) {
  return {
    requestId: 'req_1',
    results: Array.from({ length: n }, (_, i) => ({
      id: `r${i}`,
      url: `https://example${i}.com/page`,
      title: `Result ${i}`,
      highlights: [`Highlight for result ${i}`],
      publishedDate: '2026-01-01',
      score: 0.9,
    })),
    costDollars: { total: 0.005 },
  }
}

describe('WEB_SEARCH_TOOL_NAME', () => {
  it("matches eve's built-in framework tool name", () => {
    // eve/dist/src/harness/provider-tool-schemas.js exports the same literal;
    // a drift here would silently fall back to the generic Tool chip.
    expect(WEB_SEARCH_TOOL_NAME).toBe('web_search')
  })
})

describe('parseWebSearchOutput', () => {
  it('normalizes an Exa success bag into url/title/snippet', () => {
    const outcome = parseWebSearchOutput(exaOutput(2))
    expect(outcome.status).toBe('success')
    if (outcome.status !== 'success') return
    expect(outcome.results).toHaveLength(2)
    expect(outcome.results[0]).toEqual({
      url: 'https://example0.com/page',
      title: 'Result 0',
      snippet: 'Highlight for result 0',
    })
  })

  it('falls back to the hostname when a result carries no title', () => {
    const outcome = parseWebSearchOutput({
      requestId: 'r',
      results: [{ id: 'a', url: 'https://www.acme.com/about', title: null }],
    })
    if (outcome.status !== 'success') throw new Error('expected success')
    expect(outcome.results[0].title).toBe('acme.com')
    expect(outcome.results[0].snippet).toBeUndefined()
  })

  it('prefers a highlight over the raw crawled text', () => {
    const outcome = parseWebSearchOutput({
      requestId: 'r',
      results: [
        {
          id: 'a',
          url: 'https://acme.com',
          title: 'Acme',
          highlights: ['the relevant excerpt'],
          text: 'the entire page body, which is noise in a one-liner',
        },
      ],
    })
    if (outcome.status !== 'success') throw new Error('expected success')
    expect(outcome.results[0].snippet).toBe('the relevant excerpt')
  })

  it('uses text when there is no usable highlight, collapsing whitespace', () => {
    const outcome = parseWebSearchOutput({
      requestId: 'r',
      results: [
        { id: 'a', url: 'https://acme.com', title: 'Acme', highlights: ['   '], text: 'a\n\n  b' },
      ],
    })
    if (outcome.status !== 'success') throw new Error('expected success')
    expect(outcome.results[0].snippet).toBe('a b')
  })

  it('DROPS results whose url is not http(s) — a javascript: hit never becomes an href', () => {
    const outcome = parseWebSearchOutput({
      requestId: 'r',
      results: [
        { id: 'a', url: 'javascript:alert(1)', title: 'evil' },
        { id: 'b', url: 'data:text/html,<script>', title: 'also evil' },
        { id: 'c', url: 'https://ok.com', title: 'fine' },
      ],
    })
    if (outcome.status !== 'success') throw new Error('expected success')
    expect(outcome.results.map((r) => r.url)).toEqual(['https://ok.com'])
  })

  it('collapses duplicate URLs to one source line (keeps the first hit)', () => {
    const outcome = parseWebSearchOutput({
      requestId: 'r',
      results: [
        { id: 'a', url: 'https://acme.com/pricing', title: 'Pricing (live)' },
        { id: 'b', url: 'https://acme.com/pricing', title: 'Pricing (cached)' },
        { id: 'c', url: 'https://acme.com/about', title: 'About' },
      ],
    })
    if (outcome.status !== 'success') throw new Error('expected success')
    expect(outcome.results.map((r) => r.title)).toEqual(['Pricing (live)', 'About'])
  })

  it('reads the Exa ERROR branch as a plain message', () => {
    const outcome = parseWebSearchOutput({
      error: 'rate_limit',
      message: 'Too many requests',
      statusCode: 429,
    })
    expect(outcome).toEqual({ status: 'error', message: 'Too many requests' })
  })

  it('falls back to the error code when the message is blank', () => {
    const outcome = parseWebSearchOutput({ error: 'timeout', message: '   ' })
    expect(outcome).toEqual({ status: 'error', message: 'timeout' })
  })

  it('treats an empty results array as a successful empty search', () => {
    expect(parseWebSearchOutput({ requestId: 'r', results: [] })).toEqual({
      status: 'success',
      results: [],
    })
  })

  it('reports unknown for a missing / truncated / unrecognized output', () => {
    // A 64KB+ output is truncated to a STRING at the transport boundary
    // (truncateToolOutput) — the card must degrade, not throw.
    expect(parseWebSearchOutput(undefined).status).toBe('unknown')
    expect(parseWebSearchOutput(null).status).toBe('unknown')
    expect(parseWebSearchOutput('{"results": [ … truncated').status).toBe('unknown')
    expect(parseWebSearchOutput([1, 2, 3]).status).toBe('unknown')
    expect(parseWebSearchOutput({ nothing: true }).status).toBe('unknown')
  })
})

describe('readWebSearchQuery', () => {
  it('reads the Exa gateway shape { query }', () => {
    expect(readWebSearchQuery({ query: 'acme pricing' })).toBe('acme pricing')
  })

  it('joins a multi-query input { queries: string[] }', () => {
    expect(readWebSearchQuery({ queries: ['acme funding', 'acme ceo'] })).toBe(
      'acme funding, acme ceo',
    )
  })

  it("reads OpenAI's nested { action: { query } }", () => {
    expect(readWebSearchQuery({ action: { type: 'search', query: 'nested' } })).toBe('nested')
  })

  it('clips a very long query rather than blowing out the header line', () => {
    const long = 'x'.repeat(200)
    const read = readWebSearchQuery({ query: long })
    expect(read).not.toBeNull()
    expect(read!.length).toBeLessThanOrEqual(80)
    expect(read!.endsWith('…')).toBe(true)
  })

  it('returns null for absent / blank / non-object inputs', () => {
    expect(readWebSearchQuery(undefined)).toBeNull()
    expect(readWebSearchQuery({})).toBeNull()
    expect(readWebSearchQuery({ query: '  ' })).toBeNull()
    expect(readWebSearchQuery('a string')).toBeNull()
    expect(readWebSearchQuery({ queries: [] })).toBeNull()
  })
})

describe('webSearchHeadline', () => {
  it('is present-tense while running, past-tense once settled', () => {
    expect(webSearchHeadline(true, { status: 'unknown' })).toBe('Searching the web')
    expect(webSearchHeadline(false, { status: 'success', results: [] })).toBe(
      'Searched the web — no results',
    )
    expect(
      webSearchHeadline(false, {
        status: 'success',
        results: [{ url: 'https://a.com', title: 'a' }],
      }),
    ).toBe('Searched the web')
  })

  it('names a failure plainly, without alarm language', () => {
    const line = webSearchHeadline(false, { status: 'error', message: 'rate limited' })
    expect(line).toBe('Web search unavailable')
    expect(line).not.toMatch(/error|fail/i)
  })
})

describe('hostLabel', () => {
  it('strips the scheme, www. and path', () => {
    expect(hostLabel('https://www.acme.com/a/b?c=1')).toBe('acme.com')
  })
  it('returns the input unchanged when it is not parseable', () => {
    expect(hostLabel('not a url')).toBe('not a url')
  })
})

describe('<WebSearchCard /> (jsdom)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(props: Parameters<typeof WebSearchCard>[0]) {
    act(() => {
      root.render(h(WebSearchCard, props))
    })
  }

  const toggle = () => container.querySelector<HTMLButtonElement>('[data-web-search-toggle]')
  function open() {
    act(() => {
      toggle()!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('shows the query while the search is running, the headline shimmering', () => {
    render({ running: true, input: { query: 'acme funding' } })
    expect(container.textContent).toContain('Searching the web')
    expect(container.textContent).toContain('acme funding')
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('.shimmer-text')?.textContent).toBe('Searching the web')
    expect(toggle()).toBeNull()
  })

  it('settled: one collapsed line with a source count, no shimmer, no results in the thread', () => {
    render({ running: false, input: { query: 'q' }, output: exaOutput(3) })
    expect(container.textContent).toContain('Searched the web')
    expect(container.textContent).toContain('3 sources')
    expect(container.querySelector('.shimmer-text')).toBeNull()
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.textContent).not.toContain('Result 0')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
  })

  it('opening renders each result as a new-tab link hardened with rel=noopener noreferrer, closing hides them', () => {
    render({ running: false, input: { query: 'q' }, output: exaOutput(2) })
    open()
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    const links = Array.from(container.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(links[0].getAttribute('href')).toBe('https://example0.com/page')
    expect(container.textContent).toContain('Result 0')
    open()
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it(`caps the opened list at ${WEB_SEARCH_VISIBLE_RESULTS} with a "+N more" expander`, () => {
    render({ running: false, output: exaOutput(9) })
    open()
    expect(container.querySelectorAll('a')).toHaveLength(WEB_SEARCH_VISIBLE_RESULTS)
    const more = container.querySelector('[data-web-search-more]')
    expect(more?.textContent).toContain(`${9 - WEB_SEARCH_VISIBLE_RESULTS} more results`)

    act(() => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelectorAll('a')).toHaveLength(9)
    expect(container.querySelector('[data-web-search-more]')).toBeNull()
  })

  it('renders a title containing markup as TEXT, never as HTML', () => {
    render({
      running: false,
      output: {
        requestId: 'r',
        results: [{ id: 'a', url: 'https://acme.com', title: '<img src=x onerror=alert(1)>' }],
      },
    })
    open()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('surfaces the Exa error branch quietly: the headline, the message on expand, no links', () => {
    render({
      running: false,
      input: { query: 'q' },
      output: { error: 'rate_limit', message: 'Too many requests' },
    })
    expect(container.textContent).toContain('Web search unavailable')
    expect(container.textContent).not.toContain('Too many requests')
    open()
    expect(container.textContent).toContain('Too many requests')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('surfaces a transport-level output-error via errorText', () => {
    render({ running: false, errorText: 'the search tool failed' })
    expect(container.textContent).toContain('Web search unavailable')
    open()
    expect(container.textContent).toContain('the search tool failed')
  })

  it('renders just the header when the output is missing or truncated', () => {
    render({ running: false, input: { query: 'q' }, output: 'truncated…' })
    expect(container.textContent).toContain('Searched the web')
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('button')).toBeNull()
  })
})
