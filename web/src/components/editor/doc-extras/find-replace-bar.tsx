'use client'

/**
 * The find-and-replace bar over a document (./find-replace.ts holds the
 * search). Enter and ⇧Enter step through the matches, Escape closes it (and
 * clears the highlights). A reader gets find only.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/core'
import { ChevronDown, ChevronUp, Replace, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { clearSearch, getFindState, replaceActive, replaceAll, setSearch, stepMatch, type FindState } from './find-replace'

function useFindState(editor: Editor): FindState {
  return useSyncExternalStore(
    (notify) => {
      editor.on('transaction', notify)
      return () => {
        editor.off('transaction', notify)
      }
    },
    () => getFindState(editor.state),
    () => getFindState(editor.state),
  )
}

function Toggle({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded px-1 font-mono text-[11px] transition-colors',
        on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function IconButton({ onClick, label, disabled, children }: { onClick: () => void; label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function FindReplaceBar({
  editor,
  initialQuery,
  openSignal,
  onClose,
}: {
  editor: Editor
  /** What to search for on open (the selected text), if anything. */
  initialQuery: string
  /** Changes on every ⌘⇧F, so a second press refocuses the field. */
  openSignal: number
  onClose: () => void
}) {
  const state = useFindState(editor)
  const canReplace = editor.isEditable
  const [query, setQuery] = useState(initialQuery || state.query)
  const [replacement, setReplacement] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const findRef = useRef<HTMLInputElement>(null)

  // Opened (again): take the selection, focus the field.
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery)
    requestAnimationFrame(() => {
      findRef.current?.focus()
      findRef.current?.select()
    })
  }, [openSignal, initialQuery])

  useEffect(() => {
    if (editor.isDestroyed) return
    setSearch(editor.view, { query })
  }, [editor, query])

  // Closing clears the highlights.
  useEffect(() => {
    return () => {
      if (!editor.isDestroyed) clearSearch(editor.view)
    }
  }, [editor])

  const close = () => {
    onClose()
    if (!editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: false })
  }

  const count = state.error
    ? 'Not a valid pattern'
    : !query
      ? ''
      : state.matches.length === 0
        ? 'No results'
        : `${state.active + 1} of ${state.matches.length}`

  const onFieldKey = (e: React.KeyboardEvent, isReplace: boolean) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isReplace) {
        if (e.metaKey || e.ctrlKey) {
          const n = replaceAll(editor.view, replacement)
          setNotice(n ? `Replaced ${n}` : null)
        } else replaceActive(editor.view, replacement)
      } else stepMatch(editor.view, e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div
      role="search"
      aria-label="Find in document"
      // Escape anywhere in the bar (a button has focus after a click) closes
      // it, and only it: the page behind stays (it checks defaultPrevented).
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault()
          close()
        }
      }}
      className="flex w-[min(100%,26rem)] flex-col gap-1 rounded-lg border border-border bg-background p-1.5 text-xs shadow-lg"
    >
      <div className="flex items-center gap-1">
        {canReplace && (
          <IconButton onClick={() => setShowReplace((v) => !v)} label={showReplace ? 'Hide replace' : 'Replace'}>
            <Replace className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <input
          ref={findRef}
          // Focused as it mounts, so keys typed right after ⌘⇧F land here.
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setNotice(null)
          }}
          onKeyDown={(e) => onFieldKey(e, false)}
          placeholder="Find"
          aria-label="Find"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
        />
        <span className={cn('shrink-0 tabular-nums', state.error ? 'text-destructive' : 'text-muted-foreground')} aria-live="polite" title={state.error ?? undefined}>
          {notice ?? count}
        </span>
        <Toggle on={state.caseSensitive} onClick={() => setSearch(editor.view, { caseSensitive: !state.caseSensitive })} label="Match case">
          Aa
        </Toggle>
        <Toggle on={state.wholeWord} onClick={() => setSearch(editor.view, { wholeWord: !state.wholeWord })} label="Whole word">
          W
        </Toggle>
        <Toggle on={state.regex} onClick={() => setSearch(editor.view, { regex: !state.regex })} label="Regular expression">
          .*
        </Toggle>
        <IconButton onClick={() => stepMatch(editor.view, -1)} label="Previous match (⇧Enter)" disabled={state.matches.length === 0}>
          <ChevronUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton onClick={() => stepMatch(editor.view, 1)} label="Next match (Enter)" disabled={state.matches.length === 0}>
          <ChevronDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton onClick={close} label="Close (Esc)">
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {canReplace && showReplace && (
        <div className="flex items-center gap-1 pl-7">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => onFieldKey(e, true)}
            placeholder={state.regex ? 'Replace ($1 for a group)' : 'Replace'}
            aria-label="Replace with"
            spellCheck={false}
            className="h-6 min-w-0 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => {
              replaceActive(editor.view, replacement)
              // The button disables once nothing is left: keep the keyboard in the bar.
              findRef.current?.focus()
            }}
            disabled={state.matches.length === 0}
            className="h-6 shrink-0 rounded px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => {
              const n = replaceAll(editor.view, replacement)
              setNotice(n ? `Replaced ${n}` : null)
              findRef.current?.focus()
            }}
            disabled={state.matches.length === 0}
            title="Replace all (⌘Enter)"
            className="h-6 shrink-0 rounded px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            All
          </button>
        </div>
      )}
    </div>
  )
}
