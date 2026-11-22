'use client'

/**
 * The strip above the grid: the Go to cell box at the left (it names the
 * active cell; type an address or a range and press Enter to go there), then
 * the formula bar, which shows what was typed into the active cell and edits
 * the same draft the cell's own editor does.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { columnName, parseSheetRange } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import type { CaretState } from './sheet-grid'
import type { FormulaSuggestHandle } from './formula-suggest'

interface Props {
  workbook: WorkbookController
  caret: React.MutableRefObject<CaretState>
  suggest: React.RefObject<FormulaSuggestHandle | null>
  onCaret: () => void
  onMessage: (message: string) => void
  /** Give the keyboard back to the grid. */
  focusGrid: () => void
}

export function FormulaBar({ workbook, caret, suggest, onCaret, onMessage, focusGrid }: Props) {
  const selection = workbook.selection()
  const editing = workbook.editing
  const { range } = selection
  const single = range.r1 === range.r2 && range.c1 === range.c2
  const name = `${columnName(selection.column)}${selection.row}`
  const size = single ? name : `${range.r2 - range.r1 + 1}R × ${range.c2 - range.c1 + 1}C`
  const [goTo, setGoTo] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const value = editing ? editing.draft : workbook.input(selection.row, selection.column)

  useLayoutEffect(() => {
    const el = input.current
    if (!el || !editing || editing.source !== 'bar') return
    if (document.activeElement !== el) el.focus({ preventScroll: true })
    const start = Math.min(caret.current.start, el.value.length)
    const end = Math.min(caret.current.end, el.value.length)
    if (el.selectionStart !== start || el.selectionEnd !== end) el.setSelectionRange(start, end)
  }, [editing, caret])

  useEffect(() => setGoTo(null), [selection.row, selection.column, workbook.sheet])

  const go = (text: string) => {
    const parsed = parseSheetRange(text)
    if (!parsed) {
      onMessage(`“${text}” is not a cell or a range. Try B7 or A1:C9.`)
      return
    }
    if (parsed.sheet) {
      const target = workbook.sheets().find((s) => s.name.toLowerCase() === parsed.sheet?.toLowerCase())
      if (!target || target.hidden) {
        onMessage(`There is no sheet named “${parsed.sheet}”.`)
        return
      }
      workbook.selectSheet(target.index)
    }
    const layout = workbook.layout()
    // A whole column or row runs to the end of the sheet as it is now.
    workbook.select(parsed.range.r1, parsed.range.c1)
    workbook.selectRange({ ...parsed.range, r2: Math.min(parsed.range.r2, Math.max(layout.rows, parsed.range.r1)), c2: Math.min(parsed.range.c2, Math.max(layout.columns, parsed.range.c1)) })
    setGoTo(null)
    focusGrid()
  }

  const syncCaret = (el: HTMLInputElement, typed: boolean) => {
    caret.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0, pointed: typed ? null : caret.current.pointed }
    onCaret()
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border/60 text-sm">
      <input
        aria-label="Go to cell"
        value={goTo ?? size}
        spellCheck={false}
        className="w-[92px] shrink-0 border-r border-border/60 bg-transparent px-3 text-center font-mono text-[12px] text-foreground outline-none focus:bg-accent/40"
        onFocus={(event) => {
          setGoTo(name)
          requestAnimationFrame(() => event.target.select())
        }}
        onBlur={() => setGoTo(null)}
        onChange={(event) => setGoTo(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            go(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setGoTo(null)
            focusGrid()
          }
        }}
      />
      <div className="flex w-[58px] shrink-0 items-center justify-center gap-0.5 border-r border-border/60">
        {editing ? (
          <>
            <button
              type="button"
              aria-label="Cancel edit"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                workbook.cancelEdit()
                focusGrid()
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="Apply edit"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const result = workbook.commitEdit()
                if (!result.ok) onMessage(result.message)
                focusGrid()
              }}
            >
              <Check className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <span aria-hidden className="select-none font-serif text-[13px] italic text-muted-foreground">fx</span>
        )}
      </div>
      <input
        ref={input}
        data-formula-input="bar"
        aria-label="Formula bar"
        value={value}
        readOnly={workbook.readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={cn('min-w-0 flex-1 bg-transparent px-3 font-mono text-[12.5px] text-foreground outline-none', workbook.readOnly && 'text-muted-foreground')}
        onFocus={(event) => {
          if (workbook.readOnly) return
          const el = event.currentTarget
          if (!workbook.editing) {
            caret.current = { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length, pointed: null }
            workbook.startEdit({ source: 'bar' })
          } else if (workbook.editing.source !== 'bar') {
            workbook.setDraft(workbook.editing.draft, 'bar')
          }
        }}
        onChange={(event) => {
          if (!workbook.editing && !workbook.startEdit({ source: 'bar' })) return
          syncCaret(event.currentTarget, true)
          workbook.setDraft(event.currentTarget.value, 'bar')
        }}
        onSelect={(event) => {
          if (workbook.editing?.source === 'bar') syncCaret(event.currentTarget, false)
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (suggest.current?.handleKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            const result = workbook.commitEdit(event.shiftKey ? 'up' : 'down')
            if (!result.ok) onMessage(result.message)
            focusGrid()
          } else if (event.key === 'Tab') {
            event.preventDefault()
            const result = workbook.commitEdit(event.shiftKey ? 'left' : 'right')
            if (!result.ok) onMessage(result.message)
            focusGrid()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            workbook.cancelEdit()
            focusGrid()
          } else if (event.key === 'F4') {
            event.preventDefault()
            const el = event.currentTarget
            try {
              const [text, start, end] = workbook.model.cycleReference(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0)
              caret.current = { start, end, pointed: null }
              workbook.setDraft(text, 'bar')
            } catch {
              // The caret is not on a reference.
            }
          }
        }}
      />
    </div>
  )
}
