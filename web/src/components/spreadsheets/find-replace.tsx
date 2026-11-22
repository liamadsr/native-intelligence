'use client'

/**
 * Find and replace, over the grid's top right corner. It searches the sheet
 * in view: what cells show, or with "Search formulas" what was typed into
 * them. Enter goes to the next match, Shift+Enter to the one before; Replace
 * changes the match it is on, Replace all every match, as one undo step.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import type { WorkbookController } from '@/lib/spreadsheets/controller'

interface Props {
  workbook: WorkbookController
  onClose: () => void
  onMessage: (message: string) => void
}

export function FindReplace({ workbook, onClose, onMessage }: Props) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeCell, setWholeCell] = useState(false)
  const [formulas, setFormulas] = useState(false)
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const sheet = workbook.sheet
  const dataVersion = workbook.dataVersion
  const readOnly = workbook.readOnly

  const matches = useMemo(
    () => workbook.find(query, { matchCase, wholeCell, formulas }),
    // The sheet's contents are part of the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workbook, query, matchCase, wholeCell, formulas, sheet, dataVersion],
  )

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const at = matches.length ? Math.min(index, matches.length - 1) : -1
  const go = (next: number) => {
    if (!matches.length) return
    const wrapped = (next + matches.length) % matches.length
    setIndex(wrapped)
    workbook.select(matches[wrapped].row, matches[wrapped].column)
  }

  // A new search lands on its first match.
  useEffect(() => {
    setIndex(0)
    if (matches.length) workbook.select(matches[0].row, matches[0].column)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, matchCase, wholeCell, formulas, sheet])

  const replace = (all: boolean) => {
    if (at < 0) return
    const cells = all ? matches : [matches[at]]
    const result = workbook.replace(cells, query, replacement, { matchCase, wholeCell })
    if (!result.ok) {
      onMessage(result.message)
      return
    }
    if (all) onMessage(`Replaced in ${result.replaced} ${result.replaced === 1 ? 'cell' : 'cells'}.`)
  }

  const count = !query ? '' : matches.length ? `${at + 1} of ${matches.length}${matches.length >= 10_000 ? '+' : ''}` : 'No matches'
  const field = 'h-7 min-w-0 flex-1 rounded-md border border-border/70 bg-background/60 px-2 text-[12.5px] text-foreground outline-none focus:border-primary'
  const check = (label: string, on: boolean, set: (v: boolean) => void) => (
    <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
      <input type="checkbox" checked={on} onChange={(event) => set(event.target.checked)} className="h-3 w-3 accent-primary" />
      {label}
    </label>
  )

  return (
    <div
      role="search"
      aria-label="Find and replace"
      className={cn(FLOATING_CARD_CLASS, 'absolute right-3 top-3 z-40 w-[320px] max-w-[calc(100%-1.5rem)] p-2.5 shadow-lg')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          aria-label="Find"
          placeholder="Find"
          value={query}
          spellCheck={false}
          className={field}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              go(at + (event.shiftKey ? -1 : 1))
            }
          }}
        />
        <span aria-live="polite" className="w-[68px] shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">{count}</span>
        <button type="button" aria-label="Previous match" disabled={!matches.length} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => go(at - 1)}>
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Next match" disabled={!matches.length} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => go(at + 1)}>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
        <button type="button" aria-label="Close find and replace" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          aria-label="Replace with"
          placeholder="Replace with"
          value={replacement}
          spellCheck={false}
          disabled={readOnly}
          className={cn(field, 'disabled:opacity-50')}
          onChange={(event) => setReplacement(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              replace(false)
            }
          }}
        />
        <button type="button" disabled={readOnly || at < 0} className="h-7 shrink-0 rounded-md border border-border/70 px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-40" onClick={() => replace(false)}>
          Replace
        </button>
        <button type="button" disabled={readOnly || at < 0} className="h-7 shrink-0 rounded-md border border-border/70 px-2 text-[12px] text-foreground hover:bg-accent disabled:opacity-40" onClick={() => replace(true)}>
          All
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {check('Match case', matchCase, setMatchCase)}
        {check('Whole cell', wholeCell, setWholeCell)}
        {check('Search formulas', formulas, setFormulas)}
      </div>
    </div>
  )
}
