'use client'

/**
 * A rich-text editor's `;` menu: the snippet menu, opened under the `;…` being
 * typed. The editor's suggestion plugin (snippet-suggestion.ts) says what's
 * typed and where; picking a snippet puts its body there, its fill-ins filled
 * from what this place knows (`fillIns`: the mail composer's recipient).
 *
 * Mounted once per editor, beside it. Draws nothing while no `;` is open.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { SnippetMenu, type SnippetMenuHandle } from '@/components/snippets/snippet-menu'
import { snippetsMyName, useSnippets } from '@/components/snippets/use-snippets'
import { applyFillIns, type FillInContext } from '@/lib/snippets/fill-ins'
import type { Snippet } from '@/lib/snippets/types'
import type { SnippetSuggestionStore } from './snippet-suggestion'

const noState = () => null

export function SnippetSuggestionMenu({
  store,
  fillIns,
}: {
  store: SnippetSuggestionStore
  /** What this place knows for the fill-ins, read at the pick (the recipient in mail). */
  fillIns?: () => Partial<FillInContext>
}) {
  const state = useSyncExternalStore(store.subscribe, store.get, noState)
  // Loaded when the editor takes the focus (SnippetSuggestion.onFocus): a
  // read-only editor fetches nothing.
  const { snippets } = useSnippets(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<SnippetMenuHandle>(null)

  useEffect(() => {
    store.setKeys((e) => menuRef.current?.handleKey(e) ?? false)
    return () => store.setKeys(null)
  }, [store])

  const pick = (snippet: Snippet) => {
    const body = applyFillIns(snippet.body, { me: { name: snippetsMyName() }, ...(fillIns?.() ?? {}) })
    store.get()?.pick(body)
  }

  if (!state) return null
  return (
    <>
      {createPortal(
        <div
          ref={anchorRef}
          aria-hidden
          data-snippet-anchor=""
          style={{
            position: 'fixed',
            left: state.rect.left,
            top: state.rect.top,
            width: 1,
            height: Math.max(state.rect.bottom - state.rect.top, 1),
            pointerEvents: 'none',
          }}
        />,
        document.body,
      )}
      <SnippetMenu open query={state.query} snippets={snippets} onPick={pick} onDismiss={store.dismiss} anchorRef={anchorRef} menuRef={menuRef} side="bottom" />
    </>
  )
}
