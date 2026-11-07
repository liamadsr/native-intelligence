'use client'

import { useEffect, useRef } from 'react'
import { dragHasFiles, dropZoneOf, filesFromTransfer } from './dropped-files'

/**
 * Files dropped or pasted onto one element, scoped to it (several panels can
 * be mounted at once; a drop attaches only to the one it landed on). The
 * element carries `data-file-drop-zone`; a zone inside it (a chat box) keeps
 * its own drops.
 *
 * `el` is the element as state (a callback ref's setter), so the listeners
 * attach whenever it mounts: a panel that renders a loading state first gets
 * them once its element is there. (A ref read in a mount effect never saw it,
 * and a drop then did nothing.)
 */
export function useElementFileDrop(
  el: HTMLElement | null,
  onFiles: (files: File[]) => void,
  onDragging: (dragging: boolean) => void,
  { paste = true }: { paste?: boolean } = {},
): void {
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles
  const onDraggingRef = useRef(onDragging)
  onDraggingRef.current = onDragging

  useEffect(() => {
    if (!el) return
    const ours = (e: Event) => {
      const zone = dropZoneOf(e.target)
      return !zone || zone === el
    }
    let counter = 0
    const onDragEnter = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      counter++
      if (dragHasFiles(e.dataTransfer)) onDraggingRef.current(true)
    }
    const onDragOver = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      counter = Math.max(0, counter - 1)
      if (counter === 0) onDraggingRef.current(false)
    }
    const onDrop = (e: DragEvent) => {
      counter = 0
      onDraggingRef.current(false)
      if (!ours(e)) return
      e.preventDefault()
      e.stopPropagation()
      const files = filesFromTransfer(e.dataTransfer)
      if (files.length > 0) onFilesRef.current(files)
    }
    // Only clipboard files, and not a rich paste into a field: a copy out of
    // Office or a web page carries a picture of itself next to its text, and
    // the text is what the field wants.
    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromTransfer(e.clipboardData)
      if (files.length === 0) return
      const target = e.target as Element | null
      const types = Array.from(e.clipboardData?.types ?? [])
      const hasText = types.includes('text/plain') || types.includes('text/html')
      if (hasText && target?.closest?.('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      onFilesRef.current(files)
    }
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
    if (paste) el.addEventListener('paste', onPaste)
    return () => {
      el.removeEventListener('dragenter', onDragEnter)
      el.removeEventListener('dragover', onDragOver)
      el.removeEventListener('dragleave', onDragLeave)
      el.removeEventListener('drop', onDrop)
      el.removeEventListener('paste', onPaste)
    }
  }, [el, paste])
}
