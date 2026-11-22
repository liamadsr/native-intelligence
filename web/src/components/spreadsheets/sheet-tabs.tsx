'use client'

/**
 * The footer: the workbook's sheets as tabs that scroll sideways, with a
 * button to add one. A tab's menu (right-click, or the arrow on the active
 * tab) renames, duplicates, deletes and moves it; double-click renames in
 * place; a tab can be dragged to another spot.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, List, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { WorkbookController } from '@/lib/spreadsheets/controller'

interface Props {
  workbook: WorkbookController
  onMessage: (message: string) => void
  focusGrid: () => void
  /** What sits pinned at the right of the footer (Import and export). */
  trailing?: React.ReactNode
}

export function SheetTabs({ workbook, onMessage, focusGrid, trailing }: Props) {
  const sheets = workbook.sheets().filter((s) => !s.hidden)
  const active = workbook.sheet
  const [renaming, setRenaming] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [dragging, setDragging] = useState<{ index: number; over: number | null } | null>(null)
  const strip = useRef<HTMLDivElement>(null)
  const readOnly = workbook.readOnly
  const say = (result: { ok: boolean; message?: string }) => {
    if (!result.ok && result.message) onMessage(result.message)
  }

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, sheets.length])

  const visibleIndexes = sheets.map((s) => s.index)
  const position = (index: number) => visibleIndexes.indexOf(index)

  const menu = (index: number) => {
    const at = position(index)
    return (
      <DropdownMenuContent align="start" side="top" className="w-48" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem disabled={readOnly} onSelect={() => setRenaming(index)}>Rename</DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.duplicateSheet(index))}>Duplicate</DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly || sheets.length <= 1} onSelect={() => say(workbook.deleteSheet(index))}>Delete</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={readOnly || at <= 0} onSelect={() => say(workbook.moveSheet(index, visibleIndexes[at - 1]))}>Move left</DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly || at >= sheets.length - 1} onSelect={() => say(workbook.moveSheet(index, visibleIndexes[at + 1]))}>Move right</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.addSheet())}>Add sheet</DropdownMenuItem>
      </DropdownMenuContent>
    )
  }

  return (
    <div className="flex h-9 shrink-0 items-stretch border-t border-border/60 text-[12.5px]">
      <button
        type="button"
        aria-label="Add sheet"
        disabled={readOnly}
        className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
        onClick={() => {
          say(workbook.addSheet())
          focusGrid()
        }}
      >
        <Plus className="h-4 w-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Workbook sheets" className="flex w-8 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/60 hover:text-foreground">
            <List className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="max-h-72 w-56 overflow-y-auto">
          <DropdownMenuLabel>Workbook sheets</DropdownMenuLabel>
          {sheets.map((s) => (
            <DropdownMenuItem key={s.id} onSelect={() => workbook.selectSheet(s.index)} className={cn(s.index === active && 'font-medium')}>
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <div ref={strip} role="tablist" aria-label="Sheets" className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sheets.map((s) => {
          const selected = s.index === active
          return (
            <div
              key={s.id}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              draggable={!readOnly && renaming !== s.index}
              className={cn(
                'group relative flex shrink-0 cursor-default select-none items-center gap-1 border-r border-border/50 px-3',
                selected ? 'bg-background/80 font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                dragging?.over === s.index && dragging.index !== s.index && 'bg-primary/10',
              )}
              style={s.color ? { boxShadow: `inset 0 -2px 0 ${s.color}` } : undefined}
              onClick={() => {
                // A formula being typed stays open across sheets, so a cell on another sheet can be pointed at.
                workbook.selectSheet(s.index)
                if (!workbook.editing) focusGrid()
              }}
              onDoubleClick={() => !readOnly && setRenaming(s.index)}
              onContextMenu={(event) => {
                event.preventDefault()
                workbook.selectSheet(s.index)
                setMenuFor(s.index)
              }}
              onKeyDown={(event) => {
                if (event.key === 'F2' && !readOnly) setRenaming(s.index)
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', s.name)
                setDragging({ index: s.index, over: null })
              }}
              onDragOver={(event) => {
                if (!dragging) return
                event.preventDefault()
                if (dragging.over !== s.index) setDragging({ ...dragging, over: s.index })
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging && dragging.index !== s.index) say(workbook.moveSheet(dragging.index, s.index))
                setDragging(null)
              }}
              onDragEnd={() => setDragging(null)}
            >
              {selected && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
              {renaming === s.index ? (
                <RenameInput
                  name={s.name}
                  onDone={(next) => {
                    setRenaming(null)
                    if (next !== null) say(workbook.renameSheet(s.index, next))
                    focusGrid()
                  }}
                />
              ) : (
                <span className="max-w-[180px] truncate">{s.name}</span>
              )}
              <DropdownMenu open={menuFor === s.index} onOpenChange={(open) => setMenuFor(open ? s.index : null)}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${s.name}: sheet menu`}
                    className={cn('rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground', !selected && 'invisible group-hover:visible')}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                {menu(s.index)}
              </DropdownMenu>
            </div>
          )
        })}
      </div>
      {trailing && <div className="flex shrink-0 items-center border-l border-border/60 px-1.5">{trailing}</div>}
    </div>
  )
}

function RenameInput({ name, onDone }: { name: string; onDone: (next: string | null) => void }) {
  const [value, setValue] = useState(name)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (next: string | null) => {
    if (done.current) return
    done.current = true
    onDone(next)
  }
  return (
    <input
      ref={ref}
      aria-label="Sheet name"
      value={value}
      maxLength={31}
      className="w-[120px] rounded border border-primary/60 bg-background px-1 py-0.5 text-[12.5px] text-foreground outline-none"
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') finish(value)
        else if (event.key === 'Escape') finish(null)
      }}
    />
  )
}
