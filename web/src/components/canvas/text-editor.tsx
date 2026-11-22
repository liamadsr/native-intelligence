'use client'

/**
 * Typing on the canvas: an editable box drawn over the item, in world units,
 * so it sits exactly where the words will be. Escape, Cmd/Ctrl+Enter or a
 * click outside finishes; the keys never reach the canvas's shortcuts.
 */
import * as React from 'react'
import type { CanvasItem, ConnectorItem } from '@/lib/canvas/types'
import { routePath } from '@/lib/canvas/engine/connectors'
import { DEFAULT_LABEL_STYLE, DEFAULT_TEXT_STYLE } from '@/lib/canvas/engine/defaults'
import type { Scene } from '@/lib/canvas/engine/scene'
import { textCss } from './item-view'

export function TextEditor({ item, scene, onFinish }: { item: CanvasItem; scene: Scene; onFinish: (plain: string | null) => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const done = React.useRef(false)
  const initial = item.kind === 'text' ? item.content.plain : item.kind === 'rectangle' || item.kind === 'ellipse' || item.kind === 'connector' ? (item.label?.plain ?? '') : ''

  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.textContent = initial
    el.focus({ preventScroll: true })
    // Caret at the end, everything selected when there is something to replace.
    const range = document.createRange()
    range.selectNodeContents(el)
    if (!initial) range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const finish = (cancel = false) => {
    if (done.current) return
    done.current = true
    const el = ref.current
    // innerText keeps the line breaks the person typed.
    onFinish(cancel ? null : (el?.innerText ?? '').replace(/\n$/, ''))
  }
  // Unmounted without finishing (the item went away): nothing to save.
  React.useEffect(() => {
    // Set again on every mount: React's development double-mount runs the cleanup once first.
    done.current = false
    return () => void (done.current = true)
  }, [])

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

  const editable = (
    <div
      ref={ref}
      role="textbox"
      aria-label="Text"
      aria-multiline="true"
      data-canvas-text-editor
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      className={item.kind === 'connector' ? 'bg-background outline-none' : 'outline-none'}
      style={item.kind === 'text' || item.kind === 'connector' ? { ...frame, ...text, cursor: 'text' } : { ...text, minWidth: 4, maxWidth: '100%', cursor: 'text' }}
      onBlur={() => finish()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          finish()
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onPaste={(e) => {
        // Words only: no pasted styles on the canvas.
        e.preventDefault()
        e.stopPropagation()
        const t = e.clipboardData.getData('text/plain')
        if (t) document.execCommand('insertText', false, t)
      }}
      onCopy={(e) => e.stopPropagation()}
      onCut={(e) => e.stopPropagation()}
    />
  )
  if (item.kind === 'text' || item.kind === 'connector') return editable
  return <div style={frame}>{editable}</div>
}
