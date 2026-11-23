/**
 * Code blocks highlighted by language (docs/plans/doc-editor-extras.md, phase
 * 6): TipTap's lowlight code block (highlight.js grammars, the common set),
 * with a language picker on each block. The language is the block's
 * `language`, written in the fence (```ts) as before, so markdown, agents and
 * the export are unchanged; a block with none is highlighted by guess.
 *
 * The picker sits in the block's top right corner while it is hovered or
 * focused; a reader sees the language, not a picker.
 */
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView, NodeView } from '@tiptap/pm/view'
import { common, createLowlight } from 'lowlight'

export const lowlight = createLowlight(common)

/** The languages the picker offers, by name, sorted; `plaintext` stands for none. */
export const CODE_LANGUAGES: readonly string[] = lowlight
  .listLanguages()
  .filter((l) => l !== 'plaintext')
  .sort()

const LABELS: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  graphql: 'GraphQL',
  ini: 'INI / TOML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  perl: 'Perl',
  php: 'PHP',
  'php-template': 'PHP template',
  python: 'Python',
  'python-repl': 'Python REPL',
  r: 'R',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Shell session',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  vbnet: 'VB.NET',
  wasm: 'WebAssembly',
  xml: 'HTML / XML',
  yaml: 'YAML',
}

/** A language's name in the picker. Pure. */
export function languageLabel(language: string | null | undefined): string {
  if (!language) return 'Auto'
  return LABELS[language] ?? language
}

class CodeBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private select: HTMLSelectElement | null = null
  private label: HTMLSpanElement | null = null

  constructor(
    private node: PMNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    htmlClass: string,
  ) {
    const pre = document.createElement('pre')
    if (htmlClass) pre.className = htmlClass
    const code = document.createElement('code')
    this.dom = pre
    this.contentDOM = code
    if (view.editable) {
      const select = document.createElement('select')
      select.className = 'ni-code-language'
      select.contentEditable = 'false'
      select.setAttribute('aria-label', 'Code language')
      select.addEventListener('change', () => {
        const pos = this.getPos()
        if (pos === undefined) return
        const language = select.value || null
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, language }))
      })
      // Keep ProseMirror from treating clicks on the picker as editor clicks.
      select.addEventListener('mousedown', (e) => e.stopPropagation())
      this.select = select
      pre.appendChild(select)
    } else {
      const label = document.createElement('span')
      label.className = 'ni-code-language'
      label.contentEditable = 'false'
      this.label = label
      pre.appendChild(label)
    }
    pre.appendChild(code)
    this.sync()
  }

  private sync() {
    const language = (this.node.attrs.language as string | null) || ''
    this.contentDOM.className = language ? `language-${language}` : ''
    if (this.select) {
      const options = ['', ...CODE_LANGUAGES]
      // A fence language the picker doesn't list (an alias like `ts`, or one
      // without a grammar) is kept, shown as written.
      if (language && !options.includes(language)) options.splice(1, 0, language)
      if (this.select.options.length !== options.length || this.select.dataset.for !== language) {
        this.select.replaceChildren(
          ...options.map((l) => {
            const o = document.createElement('option')
            o.value = l
            o.textContent = languageLabel(l)
            return o
          }),
        )
        this.select.dataset.for = language
      }
      this.select.value = language
    }
    if (this.label) {
      this.label.textContent = language ? languageLabel(language) : ''
      this.label.hidden = !language
    }
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.sync()
    return true
  }

  stopEvent(event: Event) {
    return event.target === this.select
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }) {
    // Changes to the picker (or the label) are ours, not the document's.
    if (mutation.type === 'selection') return false
    const target = mutation.target
    return target === this.select || target === this.label || (!!this.select && this.select.contains(target)) || (!!this.label && this.label.contains(target))
  }
}

export interface HighlightedCodeBlockOptions {
  /** Classes on the `<pre>` (the editor's code block look). */
  preClass: string
}

/** The editor's `codeBlock`, highlighted. Replaces StarterKit's (configure it with `codeBlock: false`). */
export function highlightedCodeBlock({ preClass }: HighlightedCodeBlockOptions) {
  return CodeBlockLowlight.extend({
    addNodeView() {
      return ({ node, view, getPos }) => new CodeBlockView(node, view, getPos as () => number | undefined, preClass)
    },
  }).configure({ lowlight, defaultLanguage: null, HTMLAttributes: { class: preClass } })
}
