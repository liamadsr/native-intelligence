'use client'

/**
 * "Goal Seek…": change one input cell until a formula cell reaches a value.
 * The search runs on a throwaway copy of the workbook (goal-seek.ts), never on
 * the open one; Apply writes the found value into the input cell as one step.
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { parseSheetRange } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { openModel } from '@/lib/spreadsheets/engine-client'
import { goalSeek } from '@/lib/spreadsheets/goal-seek'
import { listSheets } from '@/lib/spreadsheets/workbook'

interface Props {
  workbook: WorkbookController
  onClose: () => void
  onMessage: (message: string) => void
  focusGrid: () => void
}

type Found = { ok: true; input: number; result: number; text: string } | { ok: false; message: string }

export function GoalSeekDialog({ workbook, onClose, onMessage, focusGrid }: Props) {
  const sheetName = workbook.sheets()[workbook.sheet]?.name ?? ''
  const [setCell, setSetCell] = useState(`${workbook.selectionName()}`)
  const [toValue, setToValue] = useState('')
  const [changeCell, setChangeCell] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [busy, setBusy] = useState(false)

  const resolve = (text: string): { sheet: number; row: number; column: number } | null => {
    const parsed = parseSheetRange(text)
    if (!parsed) return null
    const { range } = parsed
    if (range.r1 !== range.r2 || range.c1 !== range.c2) return null
    const sheets = workbook.sheets()
    const index = parsed.sheet ? sheets.find((s) => s.name.toLowerCase() === parsed.sheet!.toLowerCase())?.index : workbook.sheet
    if (index === undefined) return null
    return { sheet: index, row: range.r1, column: range.c1 }
  }

  const find = async () => {
    const set = resolve(setCell)
    const change = resolve(changeCell)
    const target = Number(toValue)
    if (!set) return setFound({ ok: false, message: `"${setCell}" is not a cell.` })
    if (!change) return setFound({ ok: false, message: `"${changeCell}" is not a cell.` })
    if (!Number.isFinite(target)) return setFound({ ok: false, message: 'Enter a number to reach.' })
    setBusy(true)
    const copy = await openModel(workbook.snapshot().workbook)
    try {
      const result = goalSeek(copy, {
        setSheet: set.sheet,
        setRow: set.row,
        setColumn: set.column,
        changeSheet: change.sheet,
        changeRow: change.row,
        changeColumn: change.column,
        target,
      })
      if (result.ok) {
        const names = listSheets(copy)
        const setName = names[set.sheet]?.name ?? sheetName
        const changeName = names[change.sheet]?.name ?? sheetName
        const n = (x: number) => Number(x.toPrecision(10)).toLocaleString('en-US')
        setFound({ ok: true, input: result.input, result: result.result, text: `${changeName}!${cell(change.row, change.column)} = ${n(result.input)} makes ${setName}!${cell(set.row, set.column)} = ${n(result.result)}` })
      } else {
        setFound({ ok: false, message: result.message })
      }
    } finally {
      copy.free()
      setBusy(false)
    }
  }

  const apply = () => {
    if (!found || !found.ok) return
    const change = resolve(changeCell)
    if (!change) return
    if (change.sheet !== workbook.sheet) workbook.selectSheet(change.sheet)
    const result = workbook.setCell(change.row, change.column, String(found.input), change.sheet)
    if (!result.ok) onMessage(result.message)
    onClose()
  }

  const field = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/40" onPointerDown={onClose}>
      <form
        aria-label="Goal Seek"
        className="w-[340px] rounded-xl border border-border/60 bg-background p-4 shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void find()
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Goal Seek</h2>
          <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="text-xs font-medium text-muted-foreground">Set cell</label>
        <input aria-label="Set cell" value={setCell} spellCheck={false} className={cn(field, 'mb-2 mt-1 font-mono')} onChange={(event) => { setSetCell(event.target.value); setFound(null) }} />
        <label className="text-xs font-medium text-muted-foreground">To value</label>
        <input aria-label="To value" value={toValue} inputMode="decimal" spellCheck={false} className={cn(field, 'mb-2 mt-1')} onChange={(event) => { setToValue(event.target.value); setFound(null) }} />
        <label className="text-xs font-medium text-muted-foreground">By changing cell</label>
        <input aria-label="By changing cell" value={changeCell} spellCheck={false} placeholder={`e.g. ${sheetName ? `${sheetName}!` : ''}B2`} className={cn(field, 'mt-1 font-mono')} onChange={(event) => { setChangeCell(event.target.value); setFound(null) }} />

        {found && (
          <p aria-live="polite" className={cn('mt-3 text-sm', found.ok ? 'text-foreground' : 'text-destructive')}>
            {found.ok ? found.text : found.message}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => { onClose(); focusGrid() }}>Cancel</Button>
          {found && found.ok ? (
            <Button type="button" size="sm" onClick={apply}>Apply</Button>
          ) : (
            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Searching…' : 'Find'}</Button>
          )}
        </div>
      </form>
    </div>
  )
}

function cell(row: number, column: number): string {
  let n = column
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return `${letters}${row}`
}
