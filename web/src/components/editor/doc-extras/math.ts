/**
 * Math in the editor (docs/plans/doc-editor-extras.md, phase 2): KaTeX, inline
 * (`$…$`) and as a block (`$$` lines). Stored as that same markdown
 * (views/markdown-conversion.ts), so the export, Copy, agents and every other
 * reader of a body get standard math.
 *
 *   mathInline   an inline atom, `latex` its TeX
 *   mathBlock    a block atom, `latex` its TeX
 *
 * Readers see the rendered formula. An editor clicks it (or selects it and
 * presses Enter) to edit the TeX in place; Enter (⌘↵ in a block) or a click
 * away puts it back, Escape leaves it as it was, and an emptied formula is
 * removed. A formula KaTeX can't read shows its TeX in red, never an error.
 *
 * Typed: a closing `$` after `$…` makes an inline formula (not after a price:
 * "$5 and $" stays text); `$$` then a space at the start of an empty line
 * makes a block, and `$$…$$` on its own line too. Both are in the `/` menu.
 */
import { InputRule, Node, mergeAttributes, type Editor } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export const MATH_INLINE = 'mathInline'
export const MATH_BLOCK = 'mathBlock'

/** KaTeX's HTML for a formula; null when it can't be read (the caller shows the TeX). Pure. */
export function renderMath(latex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(latex, { displayMode, throwOnError: true, strict: 'ignore', trust: false, output: 'htmlAndMathml' })
  } catch {
    return null
  }
}

/**
 * Should a typed `$…$` become a formula? Not when it reads as a price
 * ("$5 and $", "$12.50 $"): a number then a space or nothing. Pure.
 */
export function isTypedFormula(tex: string): boolean {
  if (!tex.trim()) return false
  return !/^\d[\d.,]*(?:\s|$)/.test(tex)
}

const EDITOR_KEY = '__niMathEdit'
type EditableDom = HTMLElement & { [EDITOR_KEY]?: () => void }

/** Open the formula at `pos` for editing (a fresh one from the `/` menu or an input rule). */
export function editMathAt(view: EditorView, pos: number) {
  const dom = view.nodeDOM(pos) as EditableDom | null
  dom?.[EDITOR_KEY]?.()
}

class MathNodeView implements NodeView {
  dom: EditableDom
  private node: PMNode
  private editing = false
  private input: HTMLInputElement | HTMLTextAreaElement | null = null

  constructor(
    node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private display: boolean,
  ) {
    this.node = node
    this.dom = document.createElement(display ? 'div' : 'span')
    this.dom.className = display ? 'ni-math-block' : 'ni-math-inline'
    this.dom.setAttribute(display ? 'data-math-block' : 'data-math-inline', '')
    this.dom.contentEditable = 'false'
    this.dom[EDITOR_KEY] = () => this.open()
    this.dom.addEventListener('mousedown', (e) => {
      if (!this.view.editable || this.editing) return
      e.preventDefault()
      this.open()
    })
    this.render()
  }

  private get latex(): string {
    return String(this.node.attrs.latex ?? '')
  }

  private render() {
    this.dom.replaceChildren()
    this.dom.title = this.view.editable ? 'Click to edit the formula' : this.latex
    if (!this.latex.trim()) {
      const empty = document.createElement('span')
      empty.className = 'ni-math-empty'
      empty.textContent = this.view.editable ? 'New formula' : ''
      this.dom.appendChild(empty)
      return
    }
    const html = renderMath(this.latex, this.display)
    if (html === null) {
      const raw = document.createElement('span')
      raw.className = 'ni-math-error'
      raw.textContent = this.display ? `$$${this.latex}$$` : `$${this.latex}$`
      this.dom.appendChild(raw)
      return
    }
    this.dom.innerHTML = html
  }

  open() {
    if (this.editing || !this.view.editable) return
    this.editing = true
    const input = this.display ? document.createElement('textarea') : document.createElement('input')
    input.className = 'ni-math-editor'
    input.value = this.latex
    input.spellcheck = false
    input.setAttribute('aria-label', 'Formula (TeX)')
    if (input instanceof HTMLTextAreaElement) input.rows = Math.max(2, this.latex.split('\n').length)
    else input.size = Math.max(8, this.latex.length + 2)
    input.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.close(false)
      } else if (ev.key === 'Enter' && (!this.display || ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault()
        this.close(true)
      }
    })
    input.addEventListener('input', () => {
      if (input instanceof HTMLInputElement) input.size = Math.max(8, input.value.length + 2)
    })
    input.addEventListener('blur', () => this.close(true))
    this.input = input
    this.dom.replaceChildren(input)
    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
  }

  private close(commit: boolean) {
    if (!this.editing) return
    const value = this.input?.value ?? this.latex
    this.editing = false
    this.input = null
    const pos = this.getPos()
    if (pos === undefined) return
    const { state } = this.view
    if (commit && value !== this.latex) {
      const tr = value.trim()
        ? state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, latex: value })
        : state.tr.delete(pos, pos + this.node.nodeSize)
      const after = value.trim() ? pos + this.node.nodeSize : pos
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(after, tr.doc.content.size))))
      this.view.dispatch(tr)
    } else if (!this.latex.trim()) {
      // Left empty (a fresh one, cancelled): it goes.
      const tr = state.tr.delete(pos, pos + this.node.nodeSize)
      this.view.dispatch(tr)
    } else {
      this.render()
      const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + this.node.nodeSize)))
      this.view.dispatch(tr)
    }
    this.view.focus()
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.latex !== this.node.attrs.latex
    this.node = node
    if (changed && !this.editing) this.render()
    return true
  }

  selectNode() {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode() {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  // Keys and clicks in the TeX box are the box's, not the editor's.
  stopEvent(event: Event) {
    return this.editing && !!this.input && event.target === this.input
  }

  ignoreMutation() {
    return true
  }

  destroy() {
    this.editing = false
    this.input = null
  }
}

function latexAttr() {
  return {
    latex: {
      default: '',
      parseHTML: (el: HTMLElement) => el.getAttribute('data-latex') ?? el.textContent ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({ 'data-latex': String(attrs.latex ?? '') }),
    },
  }
}

/** Enter on a selected formula opens it. */
function enterOpens(editor: Editor, type: string): boolean {
  const sel = editor.state.selection
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== type || !editor.isEditable) return false
  editMathAt(editor.view, sel.from)
  return true
}

/** Insert a fresh formula where the caret is and open it. */
export function insertMath(editor: Editor, display: boolean) {
  const type = display ? MATH_BLOCK : MATH_INLINE
  const { from } = editor.state.selection
  editor.chain().focus().insertContent({ type, attrs: { latex: '' } }).run()
  // The new node sits at the caret (a block: on the next line when the
  // paragraph wasn't empty); find it near where it went in.
  const doc = editor.state.doc
  let at: number | null = null
  doc.nodesBetween(Math.max(0, from - 2), Math.min(doc.content.size, from + 4), (node, pos) => {
    if (at === null && node.type.name === type && !node.attrs.latex) at = pos
    return at === null
  })
  if (at !== null) {
    const pos = at
    requestAnimationFrame(() => editMathAt(editor.view, pos))
  }
}

export const MathInline = Node.create({
  name: MATH_INLINE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes: latexAttr,

  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math-inline': '', class: 'ni-math-inline' }), `$${node.attrs.latex}$`]
  },

  renderText({ node }) {
    return `$${node.attrs.latex}$`
  },

  addNodeView() {
    return ({ node, view, getPos }) => new MathNodeView(node, view, getPos as () => number | undefined, false)
  },

  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => enterOpens(editor, MATH_INLINE) }
  },

  addInputRules() {
    return [
      new InputRule({
        // `$…$` just closed: the opening `$` not right after a word, `\` or `$`.
        find: /(^|[^\w\\$])\$([^\s$](?:[^$\n]*[^\s$\\])?)\$$/,
        handler: ({ state, range, match }) => {
          const tex = match[2]
          if (!isTypedFormula(tex)) return null
          const start = range.from + match[1].length
          state.tr.replaceWith(start, range.to, this.type.create({ latex: tex }))
        },
      }),
    ]
  },
})

export const MathBlock = Node.create({
  name: MATH_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes: latexAttr,

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-math-block': '', class: 'ni-math-block' }), `$$${node.attrs.latex}$$`]
  },

  renderText({ node }) {
    return `$$\n${node.attrs.latex}\n$$`
  },

  addNodeView() {
    return ({ node, view, getPos }) => new MathNodeView(node, view, getPos as () => number | undefined, true)
  },

  addKeyboardShortcuts() {
    return { Enter: ({ editor }) => enterOpens(editor, MATH_BLOCK) }
  },

  addInputRules() {
    const type = this.type
    const toBlock = (latex: string) =>
      new InputRule({
        find: latex ? /^\$\$([^$]+)\$\$$/ : /^\$\$\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from)
          if ($from.depth !== 1 || $from.parent.type.name !== 'paragraph') return null
          const tex = latex ? match[1].trim() : ''
          if (latex && !tex) return null
          const start = $from.before(1)
          const end = $from.after(1)
          // Only when the formula is the whole line.
          if ($from.parent.textContent.length !== range.to - range.from) return null
          state.tr.replaceWith(start, end, type.create({ latex: tex }))
          if (!tex) {
            const view = this.editor.view
            requestAnimationFrame(() => editMathAt(view, start))
          }
        },
      })
    return [toBlock('x'), toBlock('')]
  },
})

export const MathExtensions = [MathInline, MathBlock]
