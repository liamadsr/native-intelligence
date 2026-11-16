import { describe, expect, it } from 'vitest'
import { htmlToLines, pageToLines, PAGE_TEXT_MAX_LINE_CHARS, PAGE_TEXT_MAX_LINES, plainTextToLines } from '../text'

describe('htmlToLines', () => {
  it('keeps visible text, one line per block, and drops what a reader never sees', () => {
    const html = `<!doctype html><html><head><title>Example pricing</title><style>.a{color:red}</style>
      <script>window.x = "not text"</script></head>
      <body><!-- a comment -->
        <nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav>
        <h1>Plans &amp; prices</h1>
        <p>Starter <b>$9</b>&nbsp;/ month</p>
        <ul><li>Pro $29</li><li>Team&#160;$99</li></ul>
        <noscript>Turn on scripts</noscript>
        <svg><text>chart label</text></svg>
        <template><p>hidden template</p></template>
        <table><tr><td>Seats</td><td>10</td></tr></table>
        <p>   </p>
        line one<br>line two
      </body></html>`
    expect(htmlToLines(html)).toEqual(['Home Pricing', 'Plans & prices', 'Starter $9 / month', 'Pro $29', 'Team $99', 'Seats | 10', 'line one', 'line two'])
  })

  it('a table row is one line, its cells joined, so a changed price says which plan', () => {
    const html = `<table><thead><tr><th>Plan</th><th>Price</th></tr></thead>
      <tbody><tr><td>Basic</td><td>$10 -&gt; $12</td></tr><tr><td><div>Pro</div><div>billed yearly</div></td><td>$12</td></tr></tbody></table>`
    expect(htmlToLines(html)).toEqual(['Plan | Price', 'Basic | $10 -> $12', 'Pro | billed yearly | $12'])
  })

  it('a list item or a label keeps its own text together, and a nested list is its own lines', () => {
    const html = `<ul><li><span>Starter</span><div>$9</div></li>
      <li>Team<ul><li>Up to 10 seats</li><li><p>Priority support</p></li></ul>then $99</li></ul>
      <label><span>Email</span><div>required</div></label><button><b>Buy</b><div>now</div></button>`
    expect(htmlToLines(html)).toEqual(['Starter | $9', 'Team', 'Up to 10 seats', 'Priority support', 'then $99', 'Email | required', 'Buy | now'])
  })

  it('an unclosed row or item is closed by the next one', () => {
    expect(htmlToLines('<table><tr><td>A<td>1<tr><td>B<td>2</table><ul><li>x<li>y</ul>')).toEqual(['A | 1', 'B | 2', 'x', 'y'])
  })

  it('reads a broken page without throwing', () => {
    expect(htmlToLines('<div><p>Open <b>tag never closed<div>Next')).toEqual(['Open tag never closed', 'Next'])
  })

  it('caps line length and line count', () => {
    const long = `<p>${'a'.repeat(PAGE_TEXT_MAX_LINE_CHARS * 2)}</p>`
    expect(htmlToLines(long)[0]).toHaveLength(PAGE_TEXT_MAX_LINE_CHARS)
    const many = Array.from({ length: PAGE_TEXT_MAX_LINES + 50 }, (_, i) => `<p>Item ${i}</p>`).join('')
    expect(htmlToLines(many)).toHaveLength(PAGE_TEXT_MAX_LINES)
  })
})

describe('pageToLines', () => {
  it('reads plain text line by line', () => {
    expect(plainTextToLines('one\r\n\n  two  \nthree')).toEqual(['one', 'two', 'three'])
    expect(pageToLines('a\nb', 'text/plain')).toEqual(['a', 'b'])
  })

  it('pretty-prints JSON so a one-line answer reads as many lines', () => {
    const lines = pageToLines('{"plan":"pro","price":29,"tags":["a","b"]}', 'application/json')
    expect(lines).toContain('"plan": "pro",')
    expect(lines).toContain('"price": 29,')
    expect(lines.length).toBeGreaterThan(4)
  })

  it('reads an untyped body as HTML only when it looks like markup', () => {
    expect(pageToLines('<p>Hi</p><p>There</p>', '')).toEqual(['Hi', 'There'])
    expect(pageToLines('Hi\nThere', '')).toEqual(['Hi', 'There'])
  })

  it('has no lines for a type that is not text', () => {
    expect(pageToLines('binary', 'image/png')).toEqual([])
  })
})
