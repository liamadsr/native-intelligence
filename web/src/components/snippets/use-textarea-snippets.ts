'use client'

/**
 * `;` in a plain text box (the chat composers, comments, team chat, the
 * MentionTextarea boxes): where the `;query` is, read from the text and the
 * caret (findSnippetToken), the menu's keys, and the pick, which puts the
 * snippet's words (its markdown, which those surfaces render) in place of
 * `;query`.
 *
 * The host tells it where the caret is (noteCaret, from the box's change and
 * select events), hands it the box's keys first (handleKey: true, it took
 * them), and draws <SnippetMenu {...menuProps} /> beside the box. State moves
 * only when the token read there changes, as the `@` menu's does. The list
 * loads the first time a `;` is typed (not on focus): a box nobody types `;`
 * in fetches nothing.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { findSnippetToken, replaceSnippetToken, type SnippetToken } from '@/lib/snippets/trigger'
import { applyFillIns, type FillInContext } from '@/lib/snippets/fill-ins'
import type { Snippet } from '@/lib/snippets/types'
import { ensureSnippets, snippetsMyName, useSnippets } from './use-snippets'
import type { SnippetMenuHandle, SnippetMenuProps } from './snippet-menu'

function sameToken(a: SnippetToken | null, b: SnippetToken | null): boolean {
  if (!a || !b) return a === b
  return a.start === b.start && a.caret === b.caret && a.query === b.query
}

export interface TextareaSnippets {
  /** The menu shows (a `;query` at the caret, not dismissed, with snippets to show). */
  open: boolean
  /** The caret moved or the text changed (-1: a selection, no caret). */
  noteCaret: (value: string, caret: number) => void
  /** A key in the box. True: the menu took it (the box does nothing with it). */
  handleKey: (e: KeyboardEvent | React.KeyboardEvent) => boolean
  /** For <SnippetMenu>, less its anchor and side. */
  menuProps: Pick<SnippetMenuProps, 'open' | 'query' | 'snippets' | 'onPick' | 'onDismiss' | 'menuRef'>
}

export function useTextareaSnippets(opts: {
  value: string
  /** Off: never opens (voice mode, a read-only box, Code). */
  enabled?: boolean
  /** Put the text in the box and the caret after the snippet. */
  onCommit: (next: { value: string; caret: number }) => void
  /** What this place knows for the fill-ins, read at the pick. */
  fillIns?: () => Partial<FillInContext>
}): TextareaSnippets {
  const { value, enabled = true, onCommit, fillIns } = opts
  const [at, setAt] = useState<{ value: string; caret: number }>({ value: '', caret: -1 })
  const atRef = useRef(at)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const { snippets } = useSnippets(false)
  const menuRef = useRef<SnippetMenuHandle>(null)

  const token = useMemo(
    () => (enabled && snippets.length > 0 && at.value === value ? findSnippetToken(value, at.caret) : null),
    [enabled, snippets.length, at, value],
  )
  const open = !!token && dismissedAt !== token.start

  const noteCaret = useCallback(
    (nextValue: string, nextCaret: number) => {
      const next = findSnippetToken(nextValue, nextCaret)
      if (next) ensureSnippets()
      const cur = atRef.current
      const current = cur.value === nextValue ? findSnippetToken(nextValue, cur.caret) : null
      if (!sameToken(next, current) || cur.value !== nextValue) {
        atRef.current = { value: nextValue, caret: nextCaret }
        setAt(atRef.current)
      }
      // An Esc lasts while its `;` is typed on; leave it and it's forgotten.
      setDismissedAt((d) => (d !== null && next?.start !== d ? null : d))
    },
    [],
  )

  const onPick = useCallback(
    (snippet: Snippet) => {
      if (!token) return
      const body = applyFillIns(snippet.body, { me: { name: snippetsMyName() }, ...(fillIns?.() ?? {}) })
      const next = replaceSnippetToken(value, token, body)
      atRef.current = next
      setAt(next)
      onCommit(next)
    },
    [token, value, fillIns, onCommit],
  )

  const onDismiss = useCallback(() => {
    if (token) setDismissedAt(token.start)
  }, [token])

  const handleKey = useCallback((e: KeyboardEvent | React.KeyboardEvent) => (open ? (menuRef.current?.handleKey(e) ?? false) : false), [open])

  return {
    open,
    noteCaret,
    handleKey,
    menuProps: { open, query: token?.query ?? '', snippets, onPick, onDismiss, menuRef },
  }
}
