import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasFormatting, isRichDoc, plainToDoc, richPlain, RichText, type RichNode } from '../rich-text'

const doc: RichNode = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Ship ' }, { type: 'text', text: 'Friday', marks: [{ type: 'bold' }, { type: 'italic' }] }, { type: 'text', text: ' <b>not markup</b>' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one', marks: [{ type: 'highlight' }] }] }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.test/a' } }] }, { type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
    { type: 'paragraph' },
    { type: 'mystery', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }] },
  ],
}

describe('formatted text on the canvas', () => {
  it('draws the document as elements, never as markup, and only safe links', () => {
    const html = renderToStaticMarkup(<RichText doc={doc} />)
    expect(html).toContain('role="heading" aria-level="2"')
    expect(html).toContain('<em><strong>Friday</strong></em>')
    expect(html).toContain('&lt;b&gt;not markup&lt;/b&gt;')
    expect(html).toContain('<ul')
    expect(html).toContain('<mark')
    expect(html).toContain('href="https://example.test/a"')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('kept')
  })

  it('knows plain words from formatting, and turns each into the other', () => {
    expect(hasFormatting(doc)).toBe(true)
    const plain = plainToDoc('one\n\ntwo')
    expect(hasFormatting(plain)).toBe(false)
    expect(richPlain(plain)).toBe('one\n\ntwo')
    expect(richPlain(doc)).toBe('Plan\nShip Friday <b>not markup</b>\none\nsitebad\n\nkept')
    expect(isRichDoc(plain)).toBe(true)
    expect(isRichDoc({ type: 'paragraph' })).toBe(false)
    expect(isRichDoc('doc')).toBe(false)
    expect(hasFormatting(undefined)).toBe(false)
  })
})
