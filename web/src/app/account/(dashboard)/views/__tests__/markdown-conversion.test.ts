import { describe, it, expect } from 'vitest'
import {
  markdownToJSONContent,
  jsonContentToMarkdown,
  type ProposalChangeRef,
} from '../markdown-conversion'
import type { JSONContent } from 'novel'

/** Build a ProposalChangeRef the same way capture-detail-panel.tsx does. */
function makeProposalRefs(ids: string[]): ProposalChangeRef {
  const byIndex = new Map<number, string>()
  const byId = new Map<string, string>()
  const allIds: string[] = []
  ids.forEach((id, i) => {
    byIndex.set(i, id)
    byId.set(id, id)
    byId.set(id.slice(0, 8), id)
    allIds.push(id)
  })
  return { byIndex, byId, allIds }
}

function proposalNodes(doc: JSONContent): JSONContent[] {
  return (doc.content || []).filter((n) => n.type === 'proposalNode')
}

/**
 * Tests for GFM table support in the NoteEditor markdown <-> JSONContent
 * converters. Captures and documents store their bodies as markdown and render
 * them through these functions, so a regression here means tables silently fall
 * back to raw pipe-delimited paragraphs (the bug these tests guard against).
 */

const TABLE_MD = [
  '| Area | Advantage |',
  '| --- | --- |',
  '| Scope | Broad |',
  '| Knowledge | Deep synthesis |',
].join('\n')

function findTable(doc: JSONContent): JSONContent | undefined {
  return doc.content?.find((n) => n.type === 'table')
}

describe('markdownToJSONContent — tables', () => {
  it('parses a GFM table into a table node', () => {
    const doc = markdownToJSONContent(TABLE_MD)
    const table = findTable(doc)
    expect(table).toBeDefined()
    // header row + 2 body rows
    expect(table!.content).toHaveLength(3)
  })

  it('marks the first row cells as headers', () => {
    const table = findTable(markdownToJSONContent(TABLE_MD))!
    const headerRow = table.content![0]
    expect(headerRow.content!.every((c) => c.type === 'tableHeader')).toBe(true)
    const bodyRow = table.content![1]
    expect(bodyRow.content!.every((c) => c.type === 'tableCell')).toBe(true)
  })

  it('preserves cell text', () => {
    const table = findTable(markdownToJSONContent(TABLE_MD))!
    const firstHeaderText =
      table.content![0].content![0].content![0].content![0].text
    expect(firstHeaderText).toBe('Area')
  })

  it('reads column alignment from the delimiter row', () => {
    const md = [
      '| L | C | R |',
      '| :--- | :---: | ---: |',
      '| a | b | c |',
    ].join('\n')
    const table = findTable(markdownToJSONContent(md))!
    const headerCells = table.content![0].content!
    expect(headerCells[0].content![0].attrs?.textAlign).toBe('left')
    expect(headerCells[1].content![0].attrs?.textAlign).toBe('center')
    expect(headerCells[2].content![0].attrs?.textAlign).toBe('right')
  })

  it('does not treat a horizontal rule as a table', () => {
    const doc = markdownToJSONContent('text\n\n---\n\nmore')
    expect(findTable(doc)).toBeUndefined()
    expect(doc.content?.some((n) => n.type === 'horizontalRule')).toBe(true)
  })
})

describe('markdownToJSONContent — proposal markers', () => {
  const FULL = 'a0fd2594-ad8b-493e-b11b-2f7a2deaedf4'

  it('renders ONE card when the same valid marker appears twice', () => {
    // The real prod bug: a capture summary contains the same `<!-- proposal:ID -->`
    // marker on two separate bullets, which would otherwise render two identical
    // cards for one action item.
    const md =
      `## Next Steps\n\n` +
      `- Email Sarah the proposal by Friday\n<!-- proposal:${FULL} -->\n\n` +
      `## Team Work\n\n` +
      `- Email Sarah the proposal by Friday\n<!-- proposal:${FULL} -->`
    const doc = markdownToJSONContent(md, makeProposalRefs([FULL]))
    const nodes = proposalNodes(doc)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].attrs?.changeId).toBe(FULL)
  })

  it('renders ONE card when a full-uuid marker and an 8-char-prefix marker resolve to the same change', () => {
    const short = FULL.slice(0, 8)
    const md =
      `- Do the thing\n<!-- proposal:${FULL} -->\n` +
      `- Do the thing again\n<!-- proposal:${short} -->`
    const doc = markdownToJSONContent(md, makeProposalRefs([FULL]))
    expect(proposalNodes(doc)).toHaveLength(1)
  })

  it('does not double-append a proposal that was already anchored by a (duplicated) marker', () => {
    const md =
      `- A\n<!-- proposal:${FULL} -->\n` +
      `- A\n<!-- proposal:${FULL} -->`
    // allIds contains FULL → the post-loop append must NOT add a third node.
    const doc = markdownToJSONContent(md, makeProposalRefs([FULL]))
    expect(proposalNodes(doc)).toHaveLength(1)
  })

  it('still renders distinct proposals once each', () => {
    const a = 'aaaaaaaa-0000-0000-0000-000000000000'
    const b = 'bbbbbbbb-0000-0000-0000-000000000000'
    const md =
      `- Task A\n<!-- proposal:${a} -->\n` +
      `- Task B\n<!-- proposal:${b} -->`
    const doc = markdownToJSONContent(md, makeProposalRefs([a, b]))
    const ids = proposalNodes(doc).map((n) => n.attrs?.changeId)
    expect(ids).toEqual([a, b])
  })

  it('appends an unmarked proposal exactly once', () => {
    const doc = markdownToJSONContent(
      `## Summary\n\nWe talked.`,
      makeProposalRefs([FULL]),
    )
    expect(proposalNodes(doc)).toHaveLength(1)
  })
})

describe('jsonContentToMarkdown — tables', () => {
  it('round-trips a table back to GFM pipes', () => {
    const doc = markdownToJSONContent(TABLE_MD)
    const md = jsonContentToMarkdown(doc).trim()
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Area | Advantage |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| Scope | Broad |')
    expect(lines[3]).toBe('| Knowledge | Deep synthesis |')
  })

  it('round-trips alignment', () => {
    const md = ['| L | C | R |', '| :--- | :---: | ---: |', '| a | b | c |'].join(
      '\n',
    )
    const out = jsonContentToMarkdown(markdownToJSONContent(md)).trim()
    expect(out.split('\n')[1]).toBe('| :--- | :---: | ---: |')
  })

  it('escapes pipes inside cell text', () => {
    const md = ['| A | B |', '| --- | --- |', '| x \\| y | z |'].join('\n')
    const out = jsonContentToMarkdown(markdownToJSONContent(md)).trim()
    expect(out).toContain('x \\| y')
  })

  it('pads rows to a consistent column count', () => {
    // A table whose body row is shorter than the header (as can transiently
    // happen mid-edit) must still serialize as a rectangular GFM table.
    const doc = markdownToJSONContent(TABLE_MD)
    const table = doc.content!.find((n) => n.type === 'table')!
    // Drop the last cell of the first body row to simulate a ragged row.
    table.content![1].content!.pop()
    const out = jsonContentToMarkdown(doc).trim()
    // Every emitted row has the same number of pipes.
    const pipeCounts = out.split('\n').map((l) => (l.match(/\|/g) || []).length)
    expect(new Set(pipeCounts).size).toBe(1)
  })
})

// --- Round-trip helpers ---

/** parse → serialize → parse; assert the second parse is identical. */
function expectRoundTripIdentity(md: string): {
  doc: JSONContent
  serialized: string
} {
  const doc = markdownToJSONContent(md)
  const serialized = jsonContentToMarkdown(doc)
  const reparsed = markdownToJSONContent(serialized)
  expect(reparsed).toEqual(doc)
  return { doc, serialized }
}

/** Collect every text node anywhere in the tree. */
function collectTextNodes(node: JSONContent): JSONContent[] {
  const out: JSONContent[] = []
  const walk = (n: JSONContent) => {
    if (n.type === 'text') out.push(n)
    n.content?.forEach(walk)
  }
  walk(node)
  return out
}

/** True when the tree holds a `{ type: 'text', text: '' }` poison node. */
function hasEmptyTextNode(doc: JSONContent): boolean {
  return collectTextNodes(doc).some((n) => (n.text ?? '') === '')
}

/** Collect the text of every node of a given type (for presence checks). */
function docText(doc: JSONContent): string {
  return collectTextNodes(doc)
    .map((n) => n.text)
    .join('\n')
}

describe('nested lists — round trip', () => {
  it('round-trips a 3-level nested bullet list exactly', () => {
    const md = '- Parent\n  - Child\n    - Grandchild'
    const { doc, serialized } = expectRoundTripIdentity(md)
    // Serializer emits the same 2-spaces-per-level convention it parses.
    expect(serialized).toBe(md)
    // Structure: listItem content = [paragraph, bulletList]
    const top = doc.content![0]
    expect(top.type).toBe('bulletList')
    const parentItem = top.content![0]
    expect(parentItem.content![0].type).toBe('paragraph')
    expect(parentItem.content![1].type).toBe('bulletList')
    const childItem = parentItem.content![1].content![0]
    expect(childItem.content![0].content![0].text).toBe('Child')
    expect(childItem.content![1].type).toBe('bulletList')
    expect(
      childItem.content![1].content![0].content![0].content![0].text,
    ).toBe('Grandchild')
  })

  it('round-trips a nested task list with checked states', () => {
    const md = '- [ ] Parent\n  - [x] Child\n  - [ ] Child 2'
    const { doc, serialized } = expectRoundTripIdentity(md)
    expect(serialized).toBe(md)
    const taskList = doc.content![0]
    expect(taskList.type).toBe('taskList')
    const parent = taskList.content![0]
    expect(parent.type).toBe('taskItem')
    expect(parent.attrs?.checked).toBe(false)
    const nested = parent.content![1]
    expect(nested.type).toBe('taskList')
    expect(nested.content![0].attrs?.checked).toBe(true)
    expect(nested.content![1].attrs?.checked).toBe(false)
  })

  it('round-trips an ordered list containing a bullet sublist', () => {
    const md = '1. First\n  - Sub one\n  - Sub two\n2. Second'
    const { doc, serialized } = expectRoundTripIdentity(md)
    expect(serialized).toBe(md)
    const ordered = doc.content![0]
    expect(ordered.type).toBe('orderedList')
    expect(ordered.content).toHaveLength(2)
    const sub = ordered.content![0].content![1]
    expect(sub.type).toBe('bulletList')
    expect(sub.content).toHaveLength(2)
  })

  it('round-trips a bullet list containing an ordered sublist', () => {
    const md = '- Top\n  1. Step one\n  2. Step two\n- Next'
    const { serialized } = expectRoundTripIdentity(md)
    expect(serialized).toBe(md)
  })

  it('serializes nested child text that the old converter destroyed', () => {
    // The original destruction bug: an editor doc shaped
    // [listItem: paragraph("Parent") + nested bulletList("Child")]
    // used to serialize to "- Parent\n" — "Child" was gone forever.
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          content: [{ type: 'text', text: 'Child' }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
    expect(jsonContentToMarkdown(doc)).toBe('- Parent\n  - Child')
  })

  it('keeps flat lists serializing exactly as before', () => {
    expect(jsonContentToMarkdown(markdownToJSONContent('- a\n- b'))).toBe(
      '- a\n- b',
    )
    expect(jsonContentToMarkdown(markdownToJSONContent('1. a\n2. b'))).toBe(
      '1. a\n2. b',
    )
    expect(
      jsonContentToMarkdown(markdownToJSONContent('- [x] done\n- [ ] todo')),
    ).toBe('- [x] done\n- [ ] todo')
  })
})

describe('table cells — multiple paragraphs', () => {
  const MULTI_PARA_TABLE = [
    '| Col |',
    '| --- |',
    '| First para<br>Second para |',
  ].join('\n')

  it('splits <br> into separate cell paragraphs', () => {
    const doc = markdownToJSONContent(MULTI_PARA_TABLE)
    const table = findTable(doc)!
    const cell = table.content![1].content![0]
    expect(cell.content).toHaveLength(2)
    expect(cell.content![0].type).toBe('paragraph')
    expect(cell.content![0].content![0].text).toBe('First para')
    expect(cell.content![1].content![0].text).toBe('Second para')
  })

  it('serializes all cell paragraphs instead of dropping the second', () => {
    const doc = markdownToJSONContent(MULTI_PARA_TABLE)
    const out = jsonContentToMarkdown(doc)
    expect(out).toContain('| First para<br>Second para |')
  })

  it('round-trips a two-paragraph cell exactly', () => {
    expectRoundTripIdentity(MULTI_PARA_TABLE)
  })

  it('a second paragraph added in the editor survives save', () => {
    // Simulate pressing Enter in a cell: append a paragraph to a parsed cell.
    const doc = markdownToJSONContent(TABLE_MD)
    const table = findTable(doc)!
    table.content![1].content![0].content!.push({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Extra line' }],
    })
    const out = jsonContentToMarkdown(doc)
    expect(out).toContain('Scope<br>Extra line')
    // And it comes back as two paragraphs on reparse.
    const cell = findTable(markdownToJSONContent(out))!.content![1].content![0]
    expect(cell.content).toHaveLength(2)
    expect(cell.content![1].content![0].text).toBe('Extra line')
  })
})

describe('code blocks — empty fences and language', () => {
  it('parses an empty fence into a codeBlock with NO empty text node', () => {
    for (const md of ['```\n```', '```\n\n```']) {
      const doc = markdownToJSONContent(md)
      const block = doc.content!.find((n) => n.type === 'codeBlock')
      expect(block).toBeDefined()
      // Valid empty codeBlock: no content array at all (empty is fine;
      // an empty TEXT NODE is what makes ProseMirror throw).
      expect(block!.content ?? []).toHaveLength(0)
      expect(hasEmptyTextNode(doc)).toBe(false)
    }
  })

  it('serializes an empty codeBlock as ``` fence with no body line', () => {
    const out = jsonContentToMarkdown({
      type: 'doc',
      content: [{ type: 'codeBlock' }],
    })
    expect(out).toBe('```\n```')
  })

  it('round-trips an empty code fence exactly', () => {
    const { doc, serialized } = expectRoundTripIdentity('```\n```')
    expect(serialized).toBe('```\n```')
    expect(hasEmptyTextNode(doc)).toBe(false)
  })

  it('parses the fence language into attrs and serializes it back', () => {
    const md = '```ts\nconst a = 1\n```'
    const { doc, serialized } = expectRoundTripIdentity(md)
    expect(serialized).toBe(md)
    const block = doc.content![0]
    expect(block.attrs?.language).toBe('ts')
    expect(block.content![0].text).toBe('const a = 1')
  })

  it('round-trips an empty fence WITH a language', () => {
    const md = '```python\n```'
    const { doc, serialized } = expectRoundTripIdentity(md)
    expect(serialized).toBe(md)
    expect(doc.content![0].attrs?.language).toBe('python')
    expect(hasEmptyTextNode(doc)).toBe(false)
  })

  it('empty fence followed by real content parses cleanly (poison case)', () => {
    const md = '```\n```\n\nAfter the fence\n\n- a bullet'
    const doc = markdownToJSONContent(md)
    // The whole tree must be free of empty text nodes — one empty text node
    // makes Tiptap fall back to an EMPTY document, blanking the entire note.
    expect(hasEmptyTextNode(doc)).toBe(false)
    // The content AFTER the fence survived.
    expect(docText(doc)).toContain('After the fence')
    expect(docText(doc)).toContain('a bullet')
    expectRoundTripIdentity(md)
  })
})

describe('regression — parse output never contains empty text nodes', () => {
  const PATHOLOGICAL_INPUTS: [string, string][] = [
    ['empty fence', '```\n```'],
    ['empty fence with blank body line', '```\n\n```'],
    ['lone opening fence', '```'],
    ['lone fence then newline', '```\n'],
    ['fence with only whitespace body', '```\n   \n```'],
    ['fence with language and empty body', '```js\n```'],
    ['unclosed fence with language', '```rust'],
    ['empty fence between paragraphs', 'before\n\n```\n```\n\nafter'],
    ['two empty fences back to back', '```\n```\n```\n```'],
  ]

  it.each(PATHOLOGICAL_INPUTS)('%s', (_label, md) => {
    const doc = markdownToJSONContent(md)
    for (const textNode of collectTextNodes(doc)) {
      expect(textNode.text ?? '').not.toBe('')
    }
    // And the serialized form must reparse without poison either.
    const reparsed = markdownToJSONContent(jsonContentToMarkdown(doc))
    expect(hasEmptyTextNode(reparsed)).toBe(false)
  })
})

describe('inline links — round trip', () => {
  it('parses [text](url) into a link mark and writes it back the same', () => {
    const md = 'See [the plan](https://dial8.ai/plan) and **bold** text.'
    const doc = markdownToJSONContent(md)
    const para = doc.content?.[0]
    const link = para?.content?.find((n) => n.marks?.some((m) => m.type === 'link'))
    expect(link).toMatchObject({ text: 'the plan', marks: [{ type: 'link', attrs: { href: 'https://dial8.ai/plan' } }] })
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })

  it('leaves an unsafe href as plain text', () => {
    const doc = markdownToJSONContent('[click](javascript:alert(1))')
    expect(JSON.stringify(doc)).not.toContain('"link"')
  })
})

describe('nested inline marks — round trip', () => {
  const markTypes = (n: JSONContent) => (n.marks ?? []).map((m) => m.type).sort()

  it('parses bold inside italic instead of leaving literal asterisks', () => {
    const md = '_**both**_'
    const doc = markdownToJSONContent(md)
    const [node] = doc.content![0].content!
    expect(node.text).toBe('both')
    expect(markTypes(node)).toEqual(['bold', 'italic'])
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })

  it('parses bold inside a link and inside strike', () => {
    const md = '[**plan**](https://dial8.ai/plan) and ~~**old**~~'
    const doc = markdownToJSONContent(md)
    const nodes = doc.content![0].content!
    expect(nodes[0]).toMatchObject({ text: 'plan' })
    expect(markTypes(nodes[0])).toEqual(['bold', 'link'])
    expect(nodes[2]).toMatchObject({ text: 'old' })
    expect(markTypes(nodes[2])).toEqual(['bold', 'strike'])
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })
})

describe('intraword underscores', () => {
  it('keeps snake_case identifiers as plain text', () => {
    const md = 'workspace_id and user_id'
    const doc = markdownToJSONContent(md)
    expect(doc.content![0].content).toEqual([{ type: 'text', text: md }])
  })

  it('still treats word-boundary underscores as emphasis', () => {
    const doc = markdownToJSONContent('an _italic_ word and __bold__ one')
    const nodes = doc.content![0].content!
    expect(nodes.find((n) => n.text === 'italic')?.marks).toEqual([{ type: 'italic' }])
    expect(nodes.find((n) => n.text === 'bold')?.marks).toEqual([{ type: 'bold' }])
  })
})

describe('mixed task and bullet lines', () => {
  it('splits a task line followed by a bullet line into sibling lists', () => {
    const md = '- [ ] task\n- plain'
    const doc = markdownToJSONContent(md)
    expect(doc.content!.map((n) => n.type)).toEqual(['taskList', 'bulletList'])
    expect(doc.content![0].content!.map((n) => n.type)).toEqual(['taskItem'])
    expect(doc.content![1].content!.map((n) => n.type)).toEqual(['listItem'])
    expect(jsonContentToMarkdown(doc)).toBe(md)
  })

  it('splits a bullet line followed by a task line into sibling lists', () => {
    const doc = markdownToJSONContent('- plain\n- [x] done')
    expect(doc.content!.map((n) => n.type)).toEqual(['bulletList', 'taskList'])
    expect(doc.content![1].content![0]).toMatchObject({ type: 'taskItem', attrs: { checked: true } })
  })
})

describe('blockquotes — round trip', () => {
  it('keeps every line of a multi-line quote inside the quote', () => {
    const md = '> a\n> b'
    const serialized = jsonContentToMarkdown(markdownToJSONContent(md))
    expect(serialized).toBe(md)
    expect(markdownToJSONContent(serialized).content!.map((n) => n.type)).toEqual(['blockquote'])
  })
})
