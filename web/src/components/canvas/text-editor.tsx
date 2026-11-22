'use client'

/**
 * Typing on the canvas: an editor drawn over the item, in world units, so it
 * sits exactly where the words will be, with a small bar of formats above
 * the canvas. Escape, Cmd/Ctrl+Enter or a click outside finishes; the keys
 * never reach the canvas's shortcuts. Undo while typing is the editor's own;
 * finishing is one step on the canvas.
 */
import * as React from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import { Bold, Code, Heading1, Heading2, Highlighter, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline as UnderlineIcon, type LucideIcon } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import type { CanvasItem, CanvasText, ConnectorItem } from '@/lib/canvas/types'
import { routePath } from '@/lib/canvas/engine/connectors'
import { DEFAULT_LABEL_STYLE, DEFAULT_TEXT_STYLE } from '@/lib/canvas/engine/defaults'
import type { Scene } from '@/lib/canvas/engine/scene'
import { cn } from '@/lib/utils'
import { textCss } from './item-view'
import { hasFormatting, isRichDoc, plainToDoc, richPlain, type RichNode } from './rich-text'

/** The canvas's text is small pieces: no code blocks, rules or images. */
const EXTENSIONS = [
  StarterKit.configure({ codeBlock: false, horizontalRule: false, dropcursor: false, gapcursor: false, heading: { levels: [1, 2, 3] } }),
  Underline,
  Highlight,
  Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] }),
]

/** The class the editor's own element wears: no outline, blocks laid out as the drawn text is. */
export const RICH_CLASS =
  'outline-none [&_p]:m-0 [&_p]:min-h-[1.4em] [&_h1]:m-0 [&_h1]:text-[1.6em] [&_h1]:font-semibold [&_h1]:leading-tight [&_h2]:m-0 [&_h2]:text-[1.35em] [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:m-0 [&_h3]:text-[1.15em] [&_h3]:font-semibold [&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-[1.3em] [&_ul]:text-left [&_ol]:m-0 [&_ol]:list-decimal [&_ol]:pl-[1.5em] [&_ol]:text-left [&_blockquote]:m-0 [&_blockquote]:border-l-[3px] [&_blockquote]:border-foreground/25 [&_blockquote]:pl-[0.7em] [&_blockquote]:text-left [&_blockquote]:opacity-85 [&_code]:rounded-[3px] [&_code]:bg-foreground/[0.08] [&_code]:px-[0.25em] [&_code]:font-mono [&_code]:text-[0.9em] [&_mark]:rounded-[2px] [&_mark]:bg-[var(--cv-yellow-soft)] [&_mark]:text-inherit [&_a]:text-[var(--cv-blue)] [&_a]:underline'

function Format({ editor }: { editor: Editor }) {
  // Re-render as the caret moves, so a button shows whether its format is on.
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    const on = () => tick((n) => n + 1)
    editor.on('transaction', on)
    return () => void editor.off('transaction', on)
  }, [editor])
  const items: Array<{ label: string; icon: LucideIcon; active: boolean; run: () => void } | null> = [
    { label: 'Bold', icon: Bold, active: editor.isActive('bold'), run: () => editor.chain().focus().toggleBold().run() },
    { label: 'Italic', icon: Italic, active: editor.isActive('italic'), run: () => editor.chain().focus().toggleItalic().run() },
    { label: 'Underline', icon: UnderlineIcon, active: editor.isActive('underline'), run: () => editor.chain().focus().toggleUnderline().run() },
    { label: 'Strikethrough', icon: Strikethrough, active: editor.isActive('strike'), run: () => editor.chain().focus().toggleStrike().run() },
    { label: 'Code', icon: Code, active: editor.isActive('code'), run: () => editor.chain().focus().toggleCode().run() },
    { label: 'Highlight', icon: Highlighter, active: editor.isActive('highlight'), run: () => editor.chain().focus().toggleHighlight().run() },
    {
      label: 'Link',
      icon: Link2,
      active: editor.isActive('link'),
      run: () => {
        if (editor.isActive('link')) return void editor.chain().focus().unsetLink().run()
        const href = window.prompt('Link to (https://…)')?.trim()
        if (href && /^(https?:|mailto:)/i.test(href)) editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
        else editor.commands.focus()
      },
    },
    null,
    { label: 'Heading 1', icon: Heading1, active: editor.isActive('heading', { level: 1 }), run: () => editor.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: 'Heading 2', icon: Heading2, active: editor.isActive('heading', { level: 2 }), run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Quote', icon: Quote, active: editor.isActive('blockquote'), run: () => editor.chain().focus().toggleBlockquote().run() },
    { label: 'Bulleted list', icon: List, active: editor.isActive('bulletList'), run: () => editor.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', icon: ListOrdered, active: editor.isActive('orderedList'), run: () => editor.chain().focus().toggleOrderedList().run() },
  ]
  return (
    <div
      data-canvas-chrome
      data-canvas-format
      role="toolbar"
      aria-label="Text format"
      className={cn(FLOATING_CARD_CLASS, 'flex h-9 items-center gap-0.5 px-1')}
      // A press on the bar must not take the caret out of the text (that would finish the edit).
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it ? (
          <button
            key={it.label}
            type="button"
            aria-label={it.label}
            title={it.label}
            aria-pressed={it.active}
            onClick={it.run}
            className={cn('flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground', it.active && 'bg-foreground/10 text-foreground')}
          >
            <it.icon className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span key={`sep${i}`} className="mx-0.5 h-4 w-px bg-border" />
        ),
      )}
    </div>
  )
}

const textOf = (item: CanvasItem): CanvasText | undefined =>
  item.kind === 'text' ? item.content : item.kind === 'rectangle' || item.kind === 'ellipse' || item.kind === 'connector' ? item.label : undefined

export function TextEditor({
  item,
  scene,
  onFinish,
  renderBar,
}: {
  item: CanvasItem
  scene: Scene
  /** What the box holds now: its words, and its formatting when it has any. Null: nothing to save. */
  onFinish: (text: CanvasText | null) => void
  /** Where the format bar goes (outside the zoomed layer, so it stays one size). */
  renderBar: (bar: React.ReactNode) => React.ReactNode
}) {
  const done = React.useRef(false)
  const initial = textOf(item)
  const finishRef = React.useRef<(cancel?: boolean) => void>(() => undefined)

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: (isRichDoc(initial?.rich) ? initial.rich : plainToDoc(initial?.plain ?? '')) as object,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: RICH_CLASS, role: 'textbox', 'aria-label': 'Text', 'aria-multiline': 'true', 'data-canvas-text-editor': '', spellcheck: 'false' },
      handleKeyDown: (_view, e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          finishRef.current()
          return true
        }
        return false
      },
    },
    onBlur: () => finishRef.current(),
  })

  finishRef.current = (cancel = false) => {
    if (done.current || !editor) return
    done.current = true
    if (cancel) return onFinish(null)
    const doc = editor.getJSON() as RichNode
    const plain = richPlain(doc).replace(/\n+$/, '')
    onFinish({ plain, ...(hasFormatting(doc) && plain.trim() ? { rich: doc } : {}) })
  }

  React.useEffect(() => {
    // Set again on every mount: React's development double-mount runs the cleanup once first.
    done.current = false
    return () => void (done.current = true)
  }, [])

  // The caret goes at the end of what is there. (Selecting it all would make the next key replace the lot.)
  React.useEffect(() => {
    editor?.commands.focus('end')
  }, [editor])

  let frame: React.CSSProperties
  let text: React.CSSProperties
  if (item.kind === 'text') {
    frame = {
      position: 'absolute',
      left: 0,
      top: 0,
      transform: `translate(${item.x}px, ${item.y}px)${item.rotation ? ` rotate(${item.rotation}rad)` : ''}`,
      transformOrigin: `${item.w / 2}px ${item.h / 2}px`,
      minWidth: 4,
      width: item.autoWidth ? 'max-content' : item.w,
      whiteSpace: item.autoWidth ? 'pre' : 'pre-wrap',
      overflowWrap: item.autoWidth ? undefined : 'anywhere',
    }
    text = textCss(item.text, DEFAULT_TEXT_STYLE)
  } else if (item.kind === 'connector') {
    const mid = routePath(scene, item as ConnectorItem).mid
    frame = { position: 'absolute', left: mid.x, top: mid.y, transform: 'translate(-50%, -50%)', minWidth: 24, padding: '0 6px', whiteSpace: 'pre', borderRadius: 4 }
    text = textCss(item.text, { ...DEFAULT_LABEL_STYLE, fontSize: 14 })
  } else {
    const inset = item.kind === 'ellipse' ? 0.146 : 0
    frame = {
      position: 'absolute',
      left: 0,
      top: 0,
      width: item.w,
      height: item.h,
      transform: `translate(${item.x}px, ${item.y}px)${item.rotation ? ` rotate(${item.rotation}rad)` : ''}`,
      transformOrigin: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: inset ? `${item.h * inset}px ${item.w * inset}px` : '4px 8px',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    }
    text = textCss((item as { text?: typeof DEFAULT_LABEL_STYLE }).text, DEFAULT_LABEL_STYLE)
  }

  const stop = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
    onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
    onKeyUp: (e: React.KeyboardEvent) => e.stopPropagation(),
    onCopy: (e: React.ClipboardEvent) => e.stopPropagation(),
    onCut: (e: React.ClipboardEvent) => e.stopPropagation(),
    onPaste: (e: React.ClipboardEvent) => e.stopPropagation(),
  }
  const inner =
    item.kind === 'text' || item.kind === 'connector' ? (
      <div style={{ ...frame, ...text, cursor: 'text' }} className={item.kind === 'connector' ? 'bg-background' : undefined} {...stop}>
        <EditorContent editor={editor} />
      </div>
    ) : (
      <div style={frame}>
        <div style={{ ...text, minWidth: 4, maxWidth: '100%', cursor: 'text' }} {...stop}>
          <EditorContent editor={editor} />
        </div>
      </div>
    )
  return (
    <>
      {inner}
      {editor ? renderBar(<Format editor={editor} />) : null}
    </>
  )
}
