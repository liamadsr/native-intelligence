// @vitest-environment jsdom
/**
 * Math (../math.ts and views/markdown-conversion.ts):
 *  - `$…$` and `$$` blocks parse into math nodes and write back as the same
 *    markdown; prices stay text;
 *  - the editor renders KaTeX (a bad formula shows its TeX, never throws);
 *  - typing a closing `$` makes a formula, but not after a price; `$$` then a
 *    space makes a block; `$$x$$` on a line makes one too.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { jsonContentToMarkdown, markdownToJSONContent } from '@/app/account/(dashboard)/views/markdown-conversion'
import { MathExtensions, isTypedFormula, renderMath } from '../math'

const roundTrip = (md: string) => jsonContentToMarkdown(markdownToJSONContent(md))

function inlineNodes(md: string): JSONContent[] {
  return markdownToJSONContent(md).content?.[0]?.content ?? []
}

describe('markdown', () => {
  it('reads inline math and writes it back', () => {
    const nodes = inlineNodes('Area is $\\pi r^2$ here')
    expect(nodes.map((n) => n.type)).toEqual(['text', 'mathInline', 'text'])
    expect(nodes[1].attrs).toEqual({ latex: '\\pi r^2' })
    expect(roundTrip('Area is $\\pi r^2$ here')).toBe('Area is $\\pi r^2$ here')
    expect(roundTrip('**bold $x$**')).toBe('**bold $x$**')
  })

  it('keeps prices and other dollars as text', () => {
    for (const md of ['From $5 to $10', 'Raised $5M/$10M', 'between $5-$10', 'US$5 and US$6', 'costs $ 5 $', 'a cost of $5.']) {
      expect(inlineNodes(md).every((n) => n.type === 'text'), md).toBe(true)
      expect(roundTrip(md)).toBe(md)
    }
  })

  it('leaves math inside code alone', () => {
    expect(inlineNodes('run `echo $x$` now').some((n) => n.type === 'mathInline')).toBe(false)
  })

  it('reads a $$ block, on its own lines or one line, and writes it back', () => {
    const doc = markdownToJSONContent('Before\n\n$$\n\\int_0^1 x\\,dx\n= \\tfrac12\n$$\n\nAfter')
    expect(doc.content?.map((n) => n.type)).toEqual(['paragraph', 'mathBlock', 'paragraph'])
    expect(doc.content?.[1].attrs).toEqual({ latex: '\\int_0^1 x\\,dx\n= \\tfrac12' })
    expect(jsonContentToMarkdown(doc)).toBe('Before\n$$\n\\int_0^1 x\\,dx\n= \\tfrac12\n$$\nAfter')
    expect(markdownToJSONContent('$$E = mc^2$$').content?.[0]).toEqual({ type: 'mathBlock', attrs: { latex: 'E = mc^2' } })
    // An unclosed $$ is an ordinary line.
    expect(markdownToJSONContent('$$\nnot math').content?.[0].type).toBe('paragraph')
  })
})

describe('renderMath', () => {
  it('renders KaTeX, and gives null for a formula it cannot read', () => {
    expect(renderMath('x^2', false)).toContain('katex')
    expect(renderMath('\\frac{1}{', false)).toBeNull()
  })

  it('isTypedFormula turns down prices', () => {
    expect(isTypedFormula('x^2')).toBe(true)
    expect(isTypedFormula('2^n')).toBe(true)
    expect(isTypedFormula('5 and')).toBe(false)
    expect(isTypedFormula('12.50')).toBe(false)
    expect(isTypedFormula(' ')).toBe(false)
  })
})

describe('in the editor', () => {
  let editor: Editor | null = null
  afterEach(() => {
    editor?.destroy()
    editor = null
    document.body.innerHTML = ''
  })

  function make(md: string) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    editor = new Editor({ element: el, extensions: [StarterKit, ...MathExtensions], content: markdownToJSONContent(md) })
    return editor
  }

  /** Type text the way a person does, so input rules run. */
  function type(e: Editor, text: string) {
    for (const ch of text) {
      const { from, to } = e.state.selection
      const handled = e.view.someProp('handleTextInput', (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)))
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to))
    }
  }

  it('renders formulas with KaTeX, and a bad one as its TeX', () => {
    const e = make('Inline $a+b$ and $\\frac{1}{$ end\n\n$$\nx^2\n$$')
    expect(e.view.dom.querySelectorAll('.ni-math-inline .katex')).toHaveLength(1)
    expect(e.view.dom.querySelector('.ni-math-error')?.textContent).toBe('$\\frac{1}{$')
    expect(e.view.dom.querySelector('.ni-math-block .katex-display')).not.toBeNull()
    expect(jsonContentToMarkdown(e.getJSON())).toBe('Inline $a+b$ and $\\frac{1}{$ end\n$$\nx^2\n$$')
  })

  it('a closing $ makes a formula, but not after a price', () => {
    const e = make('')
    type(e, 'so $x^2$')
    expect(jsonContentToMarkdown(e.getJSON())).toBe('so $x^2$')
    expect(e.getJSON().content?.[0].content?.some((n) => n.type === 'mathInline')).toBe(true)

    const f = make('')
    type(f, 'from $5 and $')
    expect(f.getJSON().content?.[0].content?.some((n) => n.type === 'mathInline')).toBe(false)
  })

  it('$$ then a space makes a block; $$x$$ on a line does too', () => {
    const e = make('')
    type(e, '$$ ')
    expect(e.getJSON().content?.[0].type).toBe('mathBlock')

    const f = make('')
    type(f, '$$E=mc^2$$')
    expect(f.getJSON().content?.[0]).toEqual({ type: 'mathBlock', attrs: { latex: 'E=mc^2' } })
  })
})
