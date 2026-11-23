'use client'

/**
 * The composer's message field: rich text (bold, italic, links, bulleted and
 * numbered lists) on the editor the app already ships (tiptap, through
 * novel's StarterKit and link extension: no new dependency). Its toolbar is
 * the composer's; this is the field and the commands on it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { StarterKit, TiptapLink } from 'novel'
import { cn } from '@/lib/utils'
import { editorIsEmpty } from '@/lib/email/compose'
import { SnippetSuggestion, createSnippetSuggestionStore } from '@/components/editor/snippet-suggestion'
import { SnippetSuggestionMenu } from '@/components/editor/snippet-suggestion-menu'
import type { FillInContext } from '@/lib/snippets/fill-ins'

export interface ComposeEditorHandle {
  getHTML: () => string
  setHTML: (html: string) => void
  focus: () => void
  toggleBold: () => void
  toggleItalic: () => void
  toggleBulletList: () => void
  toggleOrderedList: () => void
  /** Links the selection (or the word at the cursor) to `href`; empty unlinks. */
  setLink: (href: string) => void
  isActive: (mark: 'bold' | 'italic' | 'bulletList' | 'orderedList' | 'link') => boolean
  currentLink: () => string
}

interface ComposeEditorProps {
  initialHtml: string
  placeholder?: string
  autoFocus?: boolean
  onChange?: (html: string) => void
  className?: string
  /** `;` snippets' fill-ins this message knows (its first recipient), read at the pick. */
  snippetFillIns?: () => Partial<FillInContext>
}

/** Only web and mail links: a link is written into mail others open. */
export function safeLinkHref(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : value.includes('@') && !value.includes('/') ? `mailto:${value}` : `https://${value}`
  try {
    const url = new URL(withScheme)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * What the editor wrote, kept to what it can write (paragraphs, breaks, bold,
 * italic, links, lists, quotes), before it goes into a message: a pasted
 * fragment can't bring a script, a style or an event handler along.
 */
export function sanitizeComposeHtml(html: string): string {
  if (typeof window === 'undefined') return html
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 's', 'u', 'a', 'ul', 'ol', 'li', 'blockquote', 'code'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  })
  // A link the editor kept must still be a web or mail link.
  return clean.replace(/<a\s+([^>]*?)href="([^"]*)"/gi, (whole, before: string, href: string) =>
    safeLinkHref(href.replace(/&amp;/g, '&')) ? whole : `<a ${before}`,
  )
}

export const ComposeEditor = forwardRef<ComposeEditorHandle, ComposeEditorProps>(function ComposeEditor(
  { initialHtml, placeholder = 'Write your message…', autoFocus = false, onChange, className, snippetFillIns },
  ref,
) {
  // `;` in the message: the person's snippets (docs/plans/snippets.md).
  const [snippetStore] = useState(createSnippetSuggestionStore)
  const [empty, setEmpty] = useState(() => editorIsEmpty(initialHtml))
  // Re-render the toolbar's active states as the selection moves.
  const [, setTick] = useState(0)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ heading: false, codeBlock: false, horizontalRule: false }),
      TiptapLink.configure({
        openOnClick: false,
        autolink: true,
        protocols: ['mailto'],
        isAllowedUri: (url: string) => safeLinkHref(url) !== null,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      SnippetSuggestion.configure({ store: snippetStore }),
    ],
    content: initialHtml || '',
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: {
        'aria-label': 'Message',
        role: 'textbox',
        'aria-multiline': 'true',
        class:
          'min-h-[120px] w-full select-text text-[15px] leading-relaxed outline-none [&_a]:text-primary [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-0 [&_ul]:list-disc [&_ul]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
      },
    },
    onUpdate: ({ editor: e }) => {
      setEmpty(e.isEmpty)
      onChangeRef.current?.(e.getHTML())
    },
    onSelectionUpdate: () => setTick((t) => t + 1),
  })

  useImperativeHandle(
    ref,
    (): ComposeEditorHandle => ({
      getHTML: () => editor?.getHTML() ?? initialHtml,
      setHTML: (html) => {
        editor?.commands.setContent(html, true)
        setEmpty(editorIsEmpty(html))
      },
      focus: () => editor?.commands.focus('end'),
      toggleBold: () => editor?.chain().focus().toggleBold().run(),
      toggleItalic: () => editor?.chain().focus().toggleItalic().run(),
      toggleBulletList: () => editor?.chain().focus().toggleBulletList().run(),
      toggleOrderedList: () => editor?.chain().focus().toggleOrderedList().run(),
      setLink: (href) => setLink(editor, href),
      isActive: (mark) => !!editor?.isActive(mark),
      currentLink: () => (editor?.getAttributes('link').href as string | undefined) ?? '',
    }),
    [editor, initialHtml],
  )

  useEffect(() => () => editor?.destroy(), [editor])

  return (
    <div className={cn('relative', className)} data-compose-editor="">
      {empty && (
        <p className="pointer-events-none absolute left-0 top-0 text-[15px] leading-relaxed text-muted-foreground/70" aria-hidden>
          {placeholder}
        </p>
      )}
      <EditorContent editor={editor} />
      <SnippetSuggestionMenu store={snippetStore} fillIns={snippetFillIns} />
    </div>
  )
})

function setLink(editor: Editor | null, raw: string) {
  if (!editor) return
  const href = safeLinkHref(raw)
  const chain = editor.chain().focus().extendMarkRange('link')
  if (!href) {
    chain.unsetLink().run()
    return
  }
  if (editor.state.selection.empty && !editor.isActive('link')) {
    // Nothing selected: the link's own text goes in.
    editor.chain().focus().insertContent({ type: 'text', text: raw.trim(), marks: [{ type: 'link', attrs: { href } }] }).run()
    return
  }
  chain.setLink({ href }).run()
}
