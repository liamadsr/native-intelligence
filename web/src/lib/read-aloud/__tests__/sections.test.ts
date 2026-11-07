// @vitest-environment jsdom
/**
 * The read-aloud section rules (../sections), shared by rendered markdown and
 * the note editor:
 *  - anchors: top-level h1–h4 (rank = level) and lead-in paragraphs (only bold
 *    text, optionally a trailing bare ":", 1–8 words; rank 5). Never h5/h6,
 *    list items, or anything nested;
 *  - a section runs to the next anchor of the same or a higher rank (an h2
 *    swallows its h3s, a lead-in stops at a lead-in or any heading);
 *  - what is read: the anchor as a sentence, then paragraphs, list items (one
 *    sentence each), quotes and sub-headings. Code, tables, images, rules,
 *    embeds (link previews), checkboxes, `data-read-aloud-skip` / aria-hidden
 *    are skipped; URLs read as their host; emoji are dropped;
 *  - a button needs ≥ MIN_SECTION_WORDS spoken words in the body and, with
 *    skipWhole, a section that isn't the whole content.
 * Each rule is pinned on the DOM, and the same fixtures on a ProseMirror doc.
 */
import { describe, it, expect } from 'vitest'
import { getSchema, Node as TiptapNode, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Table } from '@tiptap/extension-table'
import { TableRow } from '@tiptap/extension-table-row'
import { TableHeader } from '@tiptap/extension-table-header'
import { TableCell } from '@tiptap/extension-table-cell'
import {
  LEAD_IN_RANK,
  MIN_SECTION_WORDS,
  collectDomSection,
  collectPmSection,
  countWords,
  domAnchorRank,
  domBlockLines,
  hastIsLeadIn,
  isLeadIn,
  linesToSentences,
  pmAnchorRank,
  pmBlockLines,
  sectionHasButton,
  type HastNodeLike,
  type SectionLine,
} from '../sections'

/** Twenty-four spoken words: one body clears the threshold on its own. */
const LONG = 'The team agreed to ship the beta on Friday, after the last round of fixes lands and support has read the release notes twice.'
/** Eight spoken words: well under it. */
const SHORT = 'Short note that is under the threshold here.'

describe('the rules, on their own', () => {
  it('counts spoken words only', () => {
    expect(countWords('Ship it — now, 2 times!')).toBe(5)
    expect(countWords('  ')).toBe(0)
    expect(countWords(LONG)).toBeGreaterThanOrEqual(MIN_SECTION_WORDS)
    expect(countWords(SHORT)).toBeLessThan(MIN_SECTION_WORDS)
  })

  it('isLeadIn: only bold text, an optional trailing bare ":", 1–8 words', () => {
    const bold = (text: string) => ({ text, bold: true })
    const plain = (text: string) => ({ text, bold: false })
    expect(isLeadIn([bold('Next steps')])).toBe(true)
    expect(isLeadIn([bold('Next steps:')])).toBe(true)
    expect(isLeadIn([bold('Next steps'), plain(':')])).toBe(true)
    expect(isLeadIn([bold('Next steps'), plain(' : ')])).toBe(true)
    expect(isLeadIn([bold('Next'), plain(' '), bold('steps')])).toBe(true)
    expect(isLeadIn([bold('One two three four five six seven eight')])).toBe(true)

    expect(isLeadIn([bold('One two three four five six seven eight nine')])).toBe(false)
    expect(isLeadIn([bold('Note:'), plain(' call Sam')])).toBe(false)
    expect(isLeadIn([plain('Plain '), bold('then bold')])).toBe(false)
    expect(isLeadIn([bold('Steps'), plain(':'), bold('more')])).toBe(false)
    expect(isLeadIn([plain(':')])).toBe(false)
    expect(isLeadIn([bold('🚀')])).toBe(false)
    expect(isLeadIn([])).toBe(false)
  })

  it('linesToSentences: headings and items end as sentences, text is split, URLs read as hosts, emoji go', () => {
    const lines: SectionLine[] = [
      { kind: 'heading', text: 'Next steps' },
      { kind: 'text', text: 'Dr. Smith signed. Send the deck 🚀 to https://docs.dial8.ai/guide?x=1 today.' },
      { kind: 'item', text: 'Book the room' },
      { kind: 'item', text: 'Is it done?' },
    ]
    expect(linesToSentences(lines)).toEqual([
      'Next steps.',
      'Dr. Smith signed.',
      'Send the deck to docs.dial8.ai today.',
      'Book the room.',
      'Is it done?',
    ])
  })

  it('sectionHasButton: enough body words, and not the whole content with skipWhole', () => {
    const body = (text: string): SectionLine[] => [{ kind: 'text', text }]
    const long = { lines: [], bodyLines: body(LONG), coversAll: false }
    expect(sectionHasButton(long)).toBe(true)
    expect(sectionHasButton({ ...long, bodyLines: body(SHORT) })).toBe(false)
    // The anchor's own words never count.
    expect(sectionHasButton({ lines: [{ kind: 'heading', text: LONG }], bodyLines: body(SHORT), coversAll: false })).toBe(false)
    expect(sectionHasButton({ ...long, coversAll: true })).toBe(true)
    expect(sectionHasButton({ ...long, coversAll: true }, { skipWhole: true })).toBe(false)
    expect(sectionHasButton(long, { skipWhole: true })).toBe(true)
  })
})

// ── Rendered markdown (DOM) ────────────────────────────────────────────────

function dom(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html.trim()
  return root
}

const child = (root: Element, selector: string) => root.querySelector(`:scope > ${selector}`)!

describe('DOM: anchors', () => {
  it('h1–h4 rank by level; h5/h6 are no anchors', () => {
    const root = dom('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>')
    expect([...root.children].map(domAnchorRank)).toEqual([1, 2, 3, 4, null, null])
  })

  it('a lead-in is a paragraph of only bold text, a trailing ":" allowed', () => {
    const root = dom(
      [
        '<p><strong>Next steps</strong></p>',
        '<p><strong>Next steps</strong>:</p>',
        '<p><strong>Next steps:</strong></p>',
        '<p><b>Risks</b></p>',
        '<p><strong><em>Open</em> questions</strong></p>',
        '<p><strong>Note:</strong> call Sam before Friday.</p>',
        '<p>Plain paragraph.</p>',
        '<p><strong>One two three four five six seven eight nine</strong></p>',
      ].join(''),
    )
    expect([...root.children].map(domAnchorRank)).toEqual([
      LEAD_IN_RANK, LEAD_IN_RANK, LEAD_IN_RANK, LEAD_IN_RANK, LEAD_IN_RANK, null, null, null,
    ])
  })

  it('only top-level anchors start a section: not one inside a list or a quote', () => {
    const root = dom(`<ul><li><h2>In a list</h2></li></ul><blockquote><h2>In a quote</h2><p>${LONG}</p></blockquote>`)
    expect(collectDomSection(root.querySelector('li h2')!, root)).toBeNull()
    expect(collectDomSection(root.querySelector('blockquote h2')!, root)).toBeNull()
    expect(collectDomSection(child(root, 'ul'), root)).toBeNull()
  })
})

describe('DOM: where a section ends', () => {
  const root = dom(
    [
      '<p>Intro before any heading.</p>',
      '<h2>Plan</h2>',
      '<p>Plan body.</p>',
      '<h3>Phase one</h3>',
      '<p>Phase one body.</p>',
      '<p><strong>Risks</strong></p>',
      '<p>Risk body.</p>',
      '<p><strong>Owners</strong>:</p>',
      '<p>Owner body.</p>',
      '<h3>Phase two</h3>',
      '<p>Phase two body.</p>',
      '<h2>Budget</h2>',
      '<p>Budget body.</p>',
    ].join(''),
  )
  const anchors = [...root.children]
  const section = (text: string) => collectDomSection(anchors.find((el) => el.textContent === text)!, root)!
  const texts = (text: string) => section(text).blocks.map((el) => el.textContent)

  it('an h2 swallows its h3s and lead-ins, and ends at the next h2', () => {
    expect(texts('Plan')).toEqual([
      'Plan', 'Plan body.', 'Phase one', 'Phase one body.', 'Risks', 'Risk body.', 'Owners:', 'Owner body.',
      'Phase two', 'Phase two body.',
    ])
  })

  it('an h3 ends at the next h3', () => {
    expect(texts('Phase one')).toEqual(['Phase one', 'Phase one body.', 'Risks', 'Risk body.', 'Owners:', 'Owner body.'])
  })

  it('a lead-in ends at the next lead-in, and at any heading', () => {
    expect(texts('Risks')).toEqual(['Risks', 'Risk body.'])
    expect(texts('Owners:')).toEqual(['Owners:', 'Owner body.'])
  })

  it('the last section runs to the end', () => {
    expect(texts('Budget')).toEqual(['Budget', 'Budget body.'])
  })

  it('reads the anchor as a sentence, then the body in order', () => {
    expect(linesToSentences(section('Phase one').lines)).toEqual([
      'Phase one.', 'Phase one body.', 'Risks.', 'Risk body.', 'Owners:', 'Owner body.',
    ])
  })
})

describe('DOM: what is read', () => {
  it('list items are sentences of their own; nested lists and loose items too', () => {
    const root = dom(
      '<h2>Todo</h2>' +
        '<ul><li>Book the room<ul><li>Ask Sam first</li></ul></li><li><p>Send the deck</p><p>It is on the drive.</p></li></ul>' +
        '<ol><li>Call the bank</li></ol>',
    )
    const section = collectDomSection(child(root, 'h2'), root)!
    expect(section.bodyLines).toEqual([
      { kind: 'item', text: 'Book the room' },
      { kind: 'item', text: 'Ask Sam first' },
      { kind: 'item', text: 'Send the deck' },
      { kind: 'text', text: 'It is on the drive.' },
      { kind: 'item', text: 'Call the bank' },
    ])
    expect(linesToSentences(section.lines)).toEqual([
      'Todo.', 'Book the room.', 'Ask Sam first.', 'Send the deck.', 'It is on the drive.', 'Call the bank.',
    ])
  })

  it('reads quotes; skips code, tables, images, rules, checkboxes, skip-marked and aria-hidden content', () => {
    const root = dom(
      [
        '<h2>Mixed</h2>',
        '<blockquote><p>Quoted wisdom.</p></blockquote>',
        '<div data-read-aloud-skip=""><pre><code>npm install</code></pre></div>',
        '<pre><code>raw code</code></pre>',
        '<div data-read-aloud-skip=""><table><tr><td>cell</td></tr></table></div>',
        '<table><tr><td>bare cell</td></tr></table>',
        '<hr>',
        '<p><img alt="a chart" src="x.png"></p>',
        '<ul><li class="task-list-item"><input type="checkbox" disabled> Buy milk</li></ul>',
        '<p>Visible <span aria-hidden="true">hidden</span>words.</p>',
        '<p>Ref<sup><a href="#fn-1" data-footnote-ref="">1</a></sup> done.</p>',
      ].join(''),
    )
    const section = collectDomSection(child(root, 'h2'), root)!
    expect(linesToSentences(section.lines)).toEqual(['Mixed.', 'Quoted wisdom.', 'Buy milk.', 'Visible words.', 'Ref done.'])
    // Skipped blocks still belong to the section (they are highlighted with it).
    expect(section.blocks).toHaveLength(11)
  })

  it('a lead-in inside a quote, or after an item\'s first paragraph, reads as a sentence', () => {
    const root = dom(
      '<h2>Quoted</h2>' +
        '<blockquote><p><strong>Note</strong></p><p>Mind the gap.</p></blockquote>' +
        '<ul><li><p><strong>First</strong></p><p><strong>Then</strong></p></li></ul>',
    )
    const section = collectDomSection(child(root, 'h2'), root)!
    expect(section.bodyLines).toEqual([
      { kind: 'heading', text: 'Note' },
      { kind: 'text', text: 'Mind the gap.' },
      { kind: 'item', text: 'First' },
      { kind: 'heading', text: 'Then' },
    ])
    expect(linesToSentences(section.lines)).toEqual(['Quoted.', 'Note.', 'Mind the gap.', 'First.', 'Then.'])
  })

  it('URLs read as their host, emoji are dropped, line breaks are spaces', () => {
    const root = dom('<h2>Links 🔗</h2><p>See <a href="https://x.dev/a">https://www.dial8.ai/docs/setup</a> 🎉 now.<br>Then go.</p>')
    const section = collectDomSection(child(root, 'h2'), root)!
    expect(linesToSentences(section.lines)).toEqual(['Links.', 'See dial8.ai now.', 'Then go.'])
  })

  it('domBlockLines of a skipped block is empty', () => {
    expect(domBlockLines(dom('<pre><code>x = 1</code></pre>').firstElementChild!)).toEqual([])
    expect(domBlockLines(dom('<div data-read-aloud-skip=""><p>no</p></div>').firstElementChild!)).toEqual([])
  })
})

describe('DOM: coversAll and the word threshold', () => {
  it('coversAll only when nothing speakable comes before and the section runs to the end', () => {
    const whole = dom(`<h2>Only</h2><p>${LONG}</p>`)
    expect(collectDomSection(child(whole, 'h2'), whole)!.coversAll).toBe(true)

    const codeFirst = dom(`<pre><code>x</code></pre><h2>Only</h2><p>${LONG}</p>`)
    expect(collectDomSection(child(codeFirst, 'h2'), codeFirst)!.coversAll).toBe(true)

    const introFirst = dom(`<p>Intro.</p><h2>Only</h2><p>${LONG}</p>`)
    expect(collectDomSection(child(introFirst, 'h2'), introFirst)!.coversAll).toBe(false)

    const more = dom(`<h2>First</h2><p>${LONG}</p><h2>Second</h2><p>${LONG}</p>`)
    expect(collectDomSection(child(more, 'h2'), more)!.coversAll).toBe(false)
  })

  it('a short body gets no button; with skipWhole, neither does the whole content', () => {
    const short = dom(`<h2>Tiny</h2><p>${SHORT}</p>`)
    expect(sectionHasButton(collectDomSection(child(short, 'h2'), short)!)).toBe(false)

    const whole = dom(`<h2>Only</h2><p>${LONG}</p>`)
    const section = collectDomSection(child(whole, 'h2'), whole)!
    expect(sectionHasButton(section)).toBe(true)
    expect(sectionHasButton(section, { skipWhole: true })).toBe(false)
  })
})

// ── react-markdown's hast ──────────────────────────────────────────────────

describe('hast: the render-time lead-in check', () => {
  const text = (value: string): HastNodeLike => ({ type: 'text', value })
  const el = (tagName: string, ...children: HastNodeLike[]): HastNodeLike => ({ type: 'element', tagName, children })

  it('matches the DOM rule', () => {
    expect(hastIsLeadIn(el('p', el('strong', text('Next steps'))))).toBe(true)
    expect(hastIsLeadIn(el('p', el('strong', text('Next steps')), text(':')))).toBe(true)
    expect(hastIsLeadIn(el('p', el('strong', el('em', text('Open')), text(' questions'))))).toBe(true)
    expect(hastIsLeadIn(el('p', el('strong', text('Note:')), text(' call Sam')))).toBe(false)
    expect(hastIsLeadIn(el('p', text('Plain')))).toBe(false)
    expect(hastIsLeadIn(el('h2', el('strong', text('Bold heading'))))).toBe(false)
    expect(hastIsLeadIn(undefined)).toBe(false)
  })
})

// ── The note editor (ProseMirror) ──────────────────────────────────────────

const LinkPreview = TiptapNode.create({ name: 'linkPreview', group: 'block', atom: true, addAttributes: () => ({ url: { default: null } }) })
const schema = getSchema([
  StarterKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  LinkPreview,
])

const t = (text: string, bold = false): JSONContent => ({ type: 'text', text, ...(bold ? { marks: [{ type: 'bold' }] } : {}) })
const h = (level: number, text: string): JSONContent => ({ type: 'heading', attrs: { level }, content: [t(text)] })
const p = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
const pt = (text: string) => p(t(text))
const li = (...content: JSONContent[]): JSONContent => ({ type: 'listItem', content })
const doc = (...content: JSONContent[]) => schema.nodeFromJSON({ type: 'doc', content })
const indexOf = (d: ReturnType<typeof doc>, text: string) => {
  let found = -1
  d.forEach((node, _offset, index) => {
    if (found < 0 && node.textContent === text) found = index
  })
  return found
}

describe('ProseMirror: anchors', () => {
  it('h1–h4 rank by level; h5/h6 are no anchors', () => {
    const d = doc(h(1, 'A'), h(2, 'B'), h(3, 'C'), h(4, 'D'), h(5, 'E'), h(6, 'F'))
    const ranks: Array<number | null> = []
    d.forEach((node) => ranks.push(pmAnchorRank(node)))
    expect(ranks).toEqual([1, 2, 3, 4, null, null])
  })

  it('a lead-in is a paragraph of only bold text, a trailing ":" allowed', () => {
    const d = doc(
      p(t('Next steps', true)),
      p(t('Next steps', true), t(':')),
      p(t('Next', true), t(' '), t('steps', true)),
      p(t('Note:', true), t(' call Sam')),
      pt('Plain'),
      p(t('One two three four five six seven eight nine', true)),
      p(t('Line one', true), { type: 'hardBreak' }, t('line two', true)),
    )
    const ranks: Array<number | null> = []
    d.forEach((node) => ranks.push(pmAnchorRank(node)))
    expect(ranks).toEqual([LEAD_IN_RANK, LEAD_IN_RANK, LEAD_IN_RANK, null, null, null, LEAD_IN_RANK])
  })

  it('an index that is no anchor has no section', () => {
    const d = doc(pt('Plain'), { type: 'bulletList', content: [li(p(t('Bold item', true)))] })
    expect(collectPmSection(d, 0)).toBeNull()
    expect(collectPmSection(d, 1)).toBeNull()
    expect(collectPmSection(d, 5)).toBeNull()
  })
})

describe('ProseMirror: where a section ends, and its positions', () => {
  const d = doc(
    pt('Intro before any heading.'),
    h(2, 'Plan'),
    pt('Plan body.'),
    h(3, 'Phase one'),
    pt('Phase one body.'),
    p(t('Risks', true)),
    pt('Risk body.'),
    h(3, 'Phase two'),
    pt('Phase two body.'),
    h(2, 'Budget'),
    pt('Budget body.'),
  )
  const section = (text: string) => collectPmSection(d, indexOf(d, text))!
  const texts = (text: string) => section(text).nodeRanges.map(({ from }) => d.nodeAt(from)!.textContent)

  it('an h2 swallows its h3s and lead-ins, and ends at the next h2', () => {
    expect(texts('Plan')).toEqual(['Plan', 'Plan body.', 'Phase one', 'Phase one body.', 'Risks', 'Risk body.', 'Phase two', 'Phase two body.'])
  })

  it('a lead-in ends at the next heading; the last section runs to the end', () => {
    expect(texts('Risks')).toEqual(['Risks', 'Risk body.'])
    expect(texts('Budget')).toEqual(['Budget', 'Budget body.'])
  })

  it('from/to span the section’s top-level blocks exactly', () => {
    const s = section('Phase one')
    expect(s.from).toBe(s.nodeRanges[0].from)
    expect(s.to).toBe(s.nodeRanges[s.nodeRanges.length - 1].to)
    expect(d.nodeAt(s.from)!.textContent).toBe('Phase one')
    expect(d.nodeAt(s.to)!.textContent).toBe('Phase two')
  })

  it('reads the anchor as a sentence, then the body', () => {
    expect(linesToSentences(section('Phase one').lines)).toEqual(['Phase one.', 'Phase one body.', 'Risks.', 'Risk body.'])
  })
})

describe('ProseMirror: what is read', () => {
  it('list and task items are sentences of their own; later paragraphs and nested lists follow', () => {
    const d = doc(
      h(2, 'Todo'),
      {
        type: 'bulletList',
        content: [
          li(pt('Book the room'), { type: 'bulletList', content: [li(pt('Ask Sam first'))] }),
          li(pt('Send the deck'), pt('It is on the drive.')),
        ],
      },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [pt('Buy milk')] }] },
      { type: 'orderedList', content: [li(pt('Call the bank'))] },
    )
    const s = collectPmSection(d, 0)!
    expect(s.bodyLines).toEqual([
      { kind: 'item', text: 'Book the room' },
      { kind: 'item', text: 'Ask Sam first' },
      { kind: 'item', text: 'Send the deck' },
      { kind: 'text', text: 'It is on the drive.' },
      { kind: 'item', text: 'Buy milk' },
      { kind: 'item', text: 'Call the bank' },
    ])
  })

  it('reads quotes; skips code blocks, tables, rules and link previews', () => {
    const d = doc(
      h(2, 'Mixed'),
      { type: 'blockquote', content: [pt('Quoted wisdom.')] },
      { type: 'codeBlock', content: [t('npm install')] },
      {
        type: 'table',
        content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [pt('cell')] }] }],
      },
      { type: 'horizontalRule' },
      { type: 'linkPreview', attrs: { url: 'https://dial8.ai' } },
      pt('After the embeds.'),
    )
    const s = collectPmSection(d, 0)!
    expect(linesToSentences(s.lines)).toEqual(['Mixed.', 'Quoted wisdom.', 'After the embeds.'])
    // Skipped blocks still belong to the section (they are highlighted with it).
    expect(s.nodeRanges).toHaveLength(7)
    expect(pmBlockLines(d.child(2))).toEqual([])
  })

  it('a lead-in inside a quote, or after an item\'s first paragraph, reads as a sentence (as in the DOM)', () => {
    const d = doc(
      h(2, 'Quoted'),
      { type: 'blockquote', content: [p(t('Note', true)), pt('Mind the gap.')] },
      { type: 'bulletList', content: [li(p(t('First', true)), p(t('Then', true)))] },
    )
    expect(collectPmSection(d, 0)!.bodyLines).toEqual([
      { kind: 'heading', text: 'Note' },
      { kind: 'text', text: 'Mind the gap.' },
      { kind: 'item', text: 'First' },
      { kind: 'heading', text: 'Then' },
    ])
  })

  it('hard breaks never glue words; URLs read as hosts; emoji go', () => {
    const d = doc(h(2, 'Links 🔗'), p(t('See https://www.dial8.ai/docs now.'), { type: 'hardBreak' }, t('Then go.')))
    expect(collectPmSection(d, 0)!.bodyLines).toEqual([{ kind: 'text', text: 'See dial8.ai now. Then go.' }])
    expect(linesToSentences(collectPmSection(d, 0)!.lines)).toEqual(['Links.', 'See dial8.ai now.', 'Then go.'])
  })

  it('a literal markdown link reads as its text, a literal image not at all (the import parses no links)', () => {
    const d = doc(
      h(2, 'Setup'),
      pt('Follow [the setup guide](https://dial8.ai/docs/setup_(v2)) first. ![diagram](https://dial8.ai/d.png)Then call Sam.'),
    )
    expect(collectPmSection(d, 0)!.bodyLines).toEqual([{ kind: 'text', text: 'Follow the setup guide first. Then call Sam.' }])
  })

  it('coversAll and the word threshold, as in the DOM', () => {
    const whole = doc(h(2, 'Only'), pt(LONG), p())
    const s = collectPmSection(whole, 0)!
    expect(s.coversAll).toBe(true)
    expect(sectionHasButton(s)).toBe(true)
    expect(sectionHasButton(s, { skipWhole: true })).toBe(false)

    const introFirst = doc(pt('Intro.'), h(2, 'Only'), pt(LONG))
    expect(collectPmSection(introFirst, 1)!.coversAll).toBe(false)

    const emptyFirst = doc(p(), h(2, 'Only'), pt(LONG))
    expect(collectPmSection(emptyFirst, 1)!.coversAll).toBe(true)

    const short = doc(h(2, 'Tiny'), pt(SHORT))
    expect(sectionHasButton(collectPmSection(short, 0)!)).toBe(false)
  })
})
