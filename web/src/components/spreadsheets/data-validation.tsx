'use client'

/**
 * The "Dropdown…" dialog: a list rule on a range. The choices are typed one
 * per line, or read live from a range (Sheet1!A2:A20). "Reject other values"
 * is on by default. Each typed choice can carry a palette color, shown as a
 * chip in the cell.
 */
import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { rangeName, type CellRange } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { PALETTE } from '@/lib/spreadsheets/formats'

interface Props {
  workbook: WorkbookController
  onClose: () => void
  onMessage: (message: string) => void
  focusGrid: () => void
}

export function DataValidationDialog({ workbook, onClose, onMessage, focusGrid }: Props) {
  const selection = workbook.selection()
  const existing = workbook.validationView(selection.row, selection.column)
  const existingList = existing && existing.isList ? existing : null

  const [rangeText, setRangeText] = useState(rangeName(selection.range))
  const [mode, setMode] = useState<'items' | 'range'>(existingList?.rule.type === 'list' && existingList.rule.source ? 'range' : 'items')
  const [source, setSource] = useState(existingList?.rule.type === 'list' ? existingList.rule.source ?? '' : '')
  const [text, setText] = useState(
    existingList && existingList.rule.type === 'list' && !existingList.rule.source ? existingList.rule.choices.map((c) => c.value).join('\n') : '',
  )
  const [colors, setColors] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    if (existingList && existingList.rule.type === 'list') for (const c of existingList.rule.choices) if (c.color) out[c.value] = c.color
    return out
  })
  const [reject, setReject] = useState(existingList ? existingList.rule.reject : true)
  const [openColor, setOpenColor] = useState<string | null>(null)

  const lines = useMemo(() => text.split('\n').map((l) => l.trim()).filter((l) => l !== ''), [text])

  const apply = () => {
    const range = parseRangeText(rangeText) ?? selection.range
    const result =
      mode === 'range'
        ? workbook.setListValidation({ range, source: source.trim(), reject })
        : workbook.setListValidation({ range, choices: lines.map((value) => ({ value, ...(colors[value] ? { color: colors[value] } : {}) })), reject })
    if (!result.ok) {
      onMessage(result.message)
      return
    }
    onClose()
  }

  const remove = () => {
    const range = parseRangeText(rangeText) ?? selection.range
    const result = workbook.clearValidation(range)
    if (!result.ok) onMessage(result.message)
    onClose()
  }

  const field = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/40" onPointerDown={onClose}>
      <form
        aria-label="Dropdown"
        className="flex max-h-[80vh] w-[360px] flex-col rounded-xl border border-border/60 bg-background p-4 shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Dropdown</h2>
          <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="text-xs font-medium text-muted-foreground">Apply to range</label>
        <input aria-label="Range" value={rangeText} spellCheck={false} className={cn(field, 'mb-3 mt-1 font-mono')} onChange={(event) => setRangeText(event.target.value)} />

        <div role="tablist" className="mb-2 flex gap-1 rounded-md bg-muted/60 p-0.5 text-xs">
          <button type="button" role="tab" aria-selected={mode === 'items'} className={cn('flex-1 rounded px-2 py-1', mode === 'items' && 'bg-background shadow-sm')} onClick={() => setMode('items')}>
            List of items
          </button>
          <button type="button" role="tab" aria-selected={mode === 'range'} className={cn('flex-1 rounded px-2 py-1', mode === 'range' && 'bg-background shadow-sm')} onClick={() => setMode('range')}>
            From a range
          </button>
        </div>

        {mode === 'items' ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <textarea
              aria-label="Choices, one per line"
              placeholder={'Open\nIn progress\nDone'}
              value={text}
              spellCheck={false}
              rows={4}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
              onChange={(event) => setText(event.target.value)}
            />
            {lines.length > 0 && (
              <ul className="mt-2 space-y-1">
                {lines.map((value) => (
                  <li key={value} className="relative flex items-center gap-2 text-sm">
                    <button
                      type="button"
                      aria-label={`Color for ${value}`}
                      className="h-5 w-5 shrink-0 rounded-full border border-border/70"
                      style={{ backgroundColor: colors[value] ?? 'transparent' }}
                      onClick={() => setOpenColor((v) => (v === value ? null : value))}
                    />
                    <span className="truncate">{value}</span>
                    {openColor === value && (
                      <div className="absolute left-0 top-6 z-10 grid grid-cols-5 gap-1 rounded-md border border-border/70 bg-background p-1.5 shadow-lg">
                        <button type="button" aria-label="No color" className="col-span-5 mb-0.5 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => { setColors((c) => { const n = { ...c }; delete n[value]; return n }); setOpenColor(null) }}>
                          No color
                        </button>
                        {PALETTE.map((p) => (
                          <button
                            key={p.hex}
                            type="button"
                            aria-label={p.name}
                            title={p.name}
                            className="h-5 w-5 rounded-full border border-border/70"
                            style={{ backgroundColor: p.hex }}
                            onClick={() => { setColors((c) => ({ ...c, [value]: p.hex })); setOpenColor(null) }}
                          />
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div>
            <label className="text-xs font-medium text-muted-foreground">Source range</label>
            <input aria-label="Source range" value={source} placeholder="Sheet1!A2:A20" spellCheck={false} className={cn(field, 'mt-1 font-mono')} onChange={(event) => setSource(event.target.value)} />
          </div>
        )}

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={reject} onChange={(event) => setReject(event.target.checked)} className="h-3.5 w-3.5 accent-primary" />
          Reject other values
        </label>
        <p className="mt-1 text-xs text-muted-foreground">{reject ? 'A value not in the list is refused.' : 'A value not in the list is kept, with a warning.'}</p>

        <div className="mt-4 flex justify-between">
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={remove}>Remove dropdown</Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => { onClose(); focusGrid() }}>Cancel</Button>
            <Button type="submit" size="sm">Apply</Button>
          </div>
        </div>
      </form>
    </div>
  )
}

/** A bare range in the dialog's box: `A1:C9` or `B2`. */
function parseRangeText(text: string): CellRange | null {
  const m = /^\s*([A-Za-z]{1,3})(\d{1,7})(?::([A-Za-z]{1,3})(\d{1,7}))?\s*$/.exec(text)
  if (!m) return null
  const col = (s: string) => {
    let n = 0
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
    return n
  }
  const c1 = col(m[1])
  const r1 = Number(m[2])
  const c2 = m[3] ? col(m[3]) : c1
  const r2 = m[4] ? Number(m[4]) : r1
  return { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) }
}
