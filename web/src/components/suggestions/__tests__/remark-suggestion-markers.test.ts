import { describe, it, expect } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import {
  markerIdsIn,
  remarkSuggestionMarkers,
  stripSuggestionMarkers,
  SUGGESTION_ELEMENT,
} from '../remark-suggestion-markers'

interface HNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] }

function toHast(md: string): HNode {
  const processor = unified().use(remarkParse).use(remarkSuggestionMarkers).use(remarkRehype, { allowDangerousHtml: true })
  return processor.runSync(processor.parse(md)) as unknown as HNode
}

/** The top-level element tags (and suggestion ids), ignoring whitespace text. */
function shape(tree: HNode): string[] {
  return (tree.children ?? [])
    .filter((n) => n.type === 'element')
    .map((n) => (n.tagName === SUGGESTION_ELEMENT ? `card:${n.properties?.dataSuggestionId ?? n.properties?.['data-suggestion-id']}` : n.tagName!))
}

function text(tree: HNode): string {
  return (tree.children ?? []).map((c) => (c.type === 'text' ? c.value : text(c))).join('')
}

describe('remarkSuggestionMarkers', () => {
  it('a marker on its own line becomes a card where it stood', () => {
    const tree = toHast('GEN-297 is overdue.\n\n<!-- proposal:aa11 -->\n\nNext.')
    expect(shape(tree)).toEqual(['p', 'card:aa11', 'p'])
  })

  it('a marker on the line right after a paragraph still becomes its own block', () => {
    const tree = toHast('GEN-297 is overdue.\n<!-- proposal:aa11 -->')
    expect(shape(tree)).toEqual(['p', 'card:aa11'])
  })

  it('an inline marker is lifted to just after its paragraph', () => {
    const tree = toHast('Move it now or close it. <!-- proposal:bb22 --> More words.')
    expect(shape(tree)).toEqual(['p', 'card:bb22'])
    expect(text(tree)).not.toContain('proposal')
  })

  it('two markers in one block become two cards in order', () => {
    const tree = toHast('<!-- proposal:aa11 -->\n<!-- proposal:bb22 -->')
    expect(shape(tree)).toEqual(['card:aa11', 'card:bb22'])
  })

  it('markers inside list items stay in their item', () => {
    const tree = toHast('- GEN-1 stale <!-- proposal:aa11 -->\n- GEN-2 fine')
    const list = (tree.children ?? []).find((n) => n.tagName === 'ul')!
    const firstItem = (list.children ?? []).find((n) => n.tagName === 'li')!
    expect(JSON.stringify(firstItem)).toContain(SUGGESTION_ELEMENT)
  })

  it('leaves other HTML alone', () => {
    const tree = toHast('<!-- a normal comment -->\n\nText')
    expect(JSON.stringify(tree)).not.toContain(SUGGESTION_ELEMENT)
  })
})

describe('marker helpers', () => {
  it('markerIdsIn lists ids in order', () => {
    expect(markerIdsIn('a <!-- proposal:x1 --> b\n<!--proposal:y2-->')).toEqual(['x1', 'y2'])
  })
  it('stripSuggestionMarkers removes them cleanly', () => {
    expect(stripSuggestionMarkers('Line one.\n<!-- proposal:x1 -->\nLine two.')).toBe('Line one.\nLine two.')
  })
})
