'use client'

/**
 * The document editor's extras in one place (docs/plans/doc-editor-extras.md),
 * so the document panel adds one hook and a few slots instead of each
 * extension by hand: the extensions to give the editor (read once, when it is
 * created), the editor itself once it exists (for the outline, the find bar
 * and the word count), and the find bar's open state.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { Editor, AnyExtension } from '@tiptap/core'
import { HeadingFold, foldStorageKey } from './heading-fold'
import { FindReplace } from './find-replace'
import { EmojiShortcodes } from './emoji-shortcodes'
import GlobalDragHandle from 'tiptap-extension-global-drag-handle'

export interface FindBarState {
  /** Bumped on every open, so a second ⌘⇧F refocuses the field. */
  signal: number
  /** The selected text it opened with. */
  query: string
}

export interface DocumentExtras {
  /** Extensions for the editor (stable for the document). */
  extensions: AnyExtension[]
  /** The editor once it is created (null before, and after it goes). */
  editor: Editor | null
  /** Hand to the editor's `onEditorReady`. */
  onEditorReady: (editor: Editor) => void
  /** The find bar, when open. */
  find: FindBarState | null
  openFind: (query?: string) => void
  closeFind: () => void
}

export function useDocumentExtras(documentId: string): DocumentExtras {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [find, setFind] = useState<FindBarState | null>(null)
  const openFind = useCallback((query = '') => setFind((cur) => ({ signal: (cur?.signal ?? 0) + 1, query })), [])
  const closeFind = useCallback(() => setFind(null), [])
  // The extension is made once; it reaches the current opener through a ref.
  const openFindRef = useRef(openFind)
  openFindRef.current = openFind

  const extensions = useMemo<AnyExtension[]>(
    () => [
      HeadingFold.configure({ storageKey: foldStorageKey(documentId) }),
      FindReplace.configure({ onOpen: (selected) => openFindRef.current(selected) }),
      EmojiShortcodes,
      // A handle beside each block (editors only) to drag it somewhere else.
      // Placed 44px left of a block, so it never sits on a heading’s fold arrow (doc-extras.css).
      GlobalDragHandle.configure({ dragHandleWidth: 44, scrollTreshold: 100 }),
    ],
    [documentId],
  )
  const onEditorReady = useCallback((e: Editor) => {
    setEditor(e)
    e.on('destroy', () => setEditor((cur) => (cur === e ? null : cur)))
  }, [])
  return { extensions, editor, onEditorReady, find, openFind, closeFind }
}
