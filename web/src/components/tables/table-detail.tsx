'use client'

/**
 * One table open (Tables, phase 3): its header (back, name, who sees it),
 * what the grid is doing (a sort, hidden columns: shown only while there is
 * one), its History with Undo on each change, and the grid.
 *
 * Column widths and hidden columns are this viewer's, kept in this browser
 * (saved views, shared, are phase 4). The sort lives in the page.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowUp, Eye, EyeOff, History, Lock, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ViewHeader } from '@/app/account/(dashboard)/views/view-header'
import { relativeTime } from '@/lib/work/presentation'
import { canOfferUndo, describeChange } from '@/lib/tables/describe'
import { TITLE_KEY } from '@/lib/tables/grid-edits'
import { TableGrid, type GridPrefs, type TableSort } from './table-grid'
import { useTableData, type TableNotice } from './use-table-data'

const prefsKey = (tableId: string) => `ni:table-grid:${tableId}`

function readPrefs(tableId: string): GridPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(prefsKey(tableId)) ?? 'null') as Partial<GridPrefs> | null
    return {
      widths: raw?.widths && typeof raw.widths === 'object' ? raw.widths : {},
      hidden: Array.isArray(raw?.hidden) ? raw.hidden.filter((k): k is string => typeof k === 'string') : [],
    }
  } catch {
    return { widths: {}, hidden: [] }
  }
}

function usePrefs(tableId: string): [GridPrefs, (next: GridPrefs) => void] {
  const [prefs, setPrefs] = useState<GridPrefs>(() => readPrefs(tableId))
  const save = useCallback(
    (next: GridPrefs) => {
      setPrefs(next)
      try {
        localStorage.setItem(prefsKey(tableId), JSON.stringify(next))
      } catch {
        // A private window: the change lasts this visit.
      }
    },
    [tableId],
  )
  return [prefs, save]
}

const showNotice = (n: TableNotice) => {
  if (n.tone === 'error') toast.error(n.text)
  else toast(n.text)
}

export function TableDetail({ tableId, onBack }: { tableId: string; onBack: () => void }) {
  const data = useTableData(tableId, { onNotice: showNotice })
  const { table, columns, error } = data
  const [prefs, setPrefs] = usePrefs(tableId)
  const [sort, setSort] = useState<TableSort | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const hidden = columns.filter((c) => prefs.hidden.includes(c.key))
  const sortLabel = sort ? (sort.key === TITLE_KEY ? 'Name' : columns.find((c) => c.key === sort.key)?.label) : null
  useEffect(() => {
    if (sort && sort.key !== TITLE_KEY && table && !columns.some((c) => c.key === sort.key)) setSort(null)
  }, [sort, columns, table])

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack} aria-label="All tables">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="truncate">{table?.name ?? 'Table'}</span>
            {table?.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
            {table && !data.canEdit && <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">View only</span>}
          </span>
        }
        actions={
          table && (
            <span className="flex items-center gap-1.5">
              {sort && sortLabel && (
                <span className="flex h-7 items-center gap-1 rounded-full border border-border pl-2.5 pr-1 text-xs text-muted-foreground">
                  {sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  {sortLabel}
                  <button type="button" aria-label="Stop sorting" className="rounded-full p-0.5 hover:text-foreground" onClick={() => setSort(null)}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              {hidden.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground">
                      <EyeOff className="h-3.5 w-3.5" />
                      {hidden.length} hidden
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    {hidden.map((c) => (
                      <DropdownMenuItem key={c.key} onSelect={() => setPrefs({ ...prefs, hidden: prefs.hidden.filter((k) => k !== c.key) })}>
                        <Eye className="h-3.5 w-3.5" /> Show {c.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {data.changes.length > 0 && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setHistoryOpen(true)}>
                  <History className="h-3.5 w-3.5" />
                  History
                </Button>
              )}
            </span>
          )
        }
      />
      {error && <p className="px-5 py-4 text-sm text-destructive">{error}</p>}
      {!table && !error && <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
      {table && <TableGrid data={data} prefs={prefs} onPrefs={setPrefs} sort={sort} onSort={setSort} />}
      {historyOpen && table && (
        <Sheet open onOpenChange={setHistoryOpen}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader className="text-left">
              <SheetTitle>History</SheetTitle>
              <SheetDescription>Every change to {table.name}, newest first.</SheetDescription>
            </SheetHeader>
            <ul className="mt-3 divide-y divide-border">
              {data.changes.map((ch) => (
                <li key={ch.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className={ch.undone_at ? 'block truncate text-sm text-muted-foreground line-through' : 'block truncate text-sm text-foreground'}>{describeChange(ch, table.columns)}</span>
                    {ch.reason && <span className="block truncate text-xs text-muted-foreground">{ch.reason}</span>}
                  </span>
                  {ch.source !== 'person' && <span className="shrink-0 text-xs text-muted-foreground">{ch.source === 'agent' ? 'Agent' : ch.source}</span>}
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(ch.created_at)}</span>
                  {data.canEdit && canOfferUndo(ch) && (
                    <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => void data.undo(ch.id)}>
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </SheetContent>
        </Sheet>
      )}
    </div>
  )
}
