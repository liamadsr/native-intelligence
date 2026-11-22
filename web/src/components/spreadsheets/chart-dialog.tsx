'use client'

/** "Edit chart": its type, title, legend and data range. Each Apply is one undo step. */
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { parseRange, rangeName, type CellRange } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { CHART_TYPES, type ChartType } from '@/lib/spreadsheets/extras'

interface Props {
  workbook: WorkbookController
  chartId: string
  onClose: () => void
  onMessage: (message: string) => void
  focusGrid: () => void
}

const TYPE_LABELS: Record<ChartType, string> = {
  column: 'Column',
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
  doughnut: 'Doughnut',
  scatter: 'Scatter',
}

export function ChartDialog({ workbook, chartId, onClose, onMessage, focusGrid }: Props) {
  const chart = workbook.charts().find((c) => c.id === chartId)
  const [type, setType] = useState<ChartType>(chart?.type ?? 'column')
  const [title, setTitle] = useState(chart?.title ?? '')
  const [legend, setLegend] = useState(chart?.legend ?? true)
  const [range, setRange] = useState(chart ? rangeName(chart.source) : '')
  if (!chart) return null

  const apply = () => {
    const parsed = parseRange(range.trim())
    if (!parsed) {
      onMessage(`"${range}" is not a range (e.g. A1:C9).`)
      return
    }
    const source: CellRange = parsed
    const result = workbook.updateChartSpec(chartId, { type, title: title.trim(), legend, source })
    if (!result.ok) {
      onMessage(result.message)
      return
    }
    onClose()
    focusGrid()
  }

  const field = 'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary'
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/40" onPointerDown={onClose}>
      <form
        aria-label="Edit chart"
        className="w-[340px] rounded-xl border border-border/60 bg-background p-4 shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Edit chart</h2>
          <button type="button" aria-label="Close" className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <label className="text-xs font-medium text-muted-foreground">Type</label>
        <select aria-label="Chart type" value={type} className={cn(field, 'mb-2 mt-1')} onChange={(event) => setType(event.target.value as ChartType)}>
          {CHART_TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
        <label className="text-xs font-medium text-muted-foreground">Title</label>
        <input aria-label="Chart title" value={title} className={cn(field, 'mb-2 mt-1')} onChange={(event) => setTitle(event.target.value)} />
        <label className="text-xs font-medium text-muted-foreground">Data range</label>
        <input aria-label="Data range" value={range} spellCheck={false} className={cn(field, 'mb-2 mt-1 font-mono')} onChange={(event) => setRange(event.target.value)} />
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={legend} onChange={(event) => setLegend(event.target.checked)} className="h-3.5 w-3.5 accent-primary" />
          Show legend
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => { onClose(); focusGrid() }}>Cancel</Button>
          <Button type="submit" size="sm">Apply</Button>
        </div>
      </form>
    </div>
  )
}
