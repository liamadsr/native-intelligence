'use client'

/**
 * Text selected in a doc or a capture open in a card, handed to the chat for
 * AI editing context (the main chat's host listens: main-chat-host.tsx). A
 * panel going away — the card folded, Back, another record — clears what it
 * said.
 */
import { useCallback, useEffect, useRef } from 'react'

export const EDITOR_SELECTION_EVENT = 'ni:editor-selection'

export interface EditorSelection {
  entityType: string
  entityId: string
  field: string
  selectedText: string
}

function say(selection: EditorSelection | null): void {
  window.dispatchEvent(new CustomEvent(EDITOR_SELECTION_EVENT, { detail: selection }))
}

/** The `onSelectionChange` a record panel in a card is handed. */
export function useEditorSelectionRelay(): (selection: EditorSelection | null) => void {
  const spoke = useRef(false)
  useEffect(
    () => () => {
      if (spoke.current) say(null)
    },
    [],
  )
  return useCallback((selection: EditorSelection | null) => {
    spoke.current = selection !== null
    say(selection)
  }, [])
}
