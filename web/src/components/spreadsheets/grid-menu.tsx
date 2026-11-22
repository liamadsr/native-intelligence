'use client'

/**
 * The menu a right-click opens: on cells, on a row's number, on a column's
 * letter. It opens where the pointer is.
 */
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { columnName } from '@/lib/spreadsheets/a1'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import type { GridMenuTarget } from './sheet-grid'

export interface GridMenuState {
  target: GridMenuTarget
  x: number
  y: number
}

export interface GridCommands {
  cut: () => void
  copy: () => void
  paste: (valuesOnly?: boolean) => void
  fitColumns: (from: number, to: number) => void
  resize: (axis: 'row' | 'column', from: number, to: number) => void
  /** Open the Dropdown… dialog. */
  dropdown: () => void
}

interface Props {
  workbook: WorkbookController
  state: GridMenuState | null
  onClose: () => void
  commands: GridCommands
  onMessage: (message: string) => void
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

export function GridMenu({ workbook, state, onClose, commands, onMessage }: Props) {
  if (!state) return null
  const { target } = state
  const readOnly = workbook.readOnly
  const selection = workbook.selection()
  const { range } = selection
  const activeIsCheckbox = workbook.isCheckboxCell(selection.row, selection.column)
  const activeHasDropdown = workbook.validationView(selection.row, selection.column)?.isList ?? false
  const say = (result: { ok: boolean; message?: string }) => {
    if (!result.ok && result.message) onMessage(result.message)
  }
  const rows = range.r2 - range.r1 + 1
  const columns = range.c2 - range.c1 + 1
  const rowWord = rows === 1 ? 'row' : `${rows} rows`
  const columnWord = columns === 1 ? 'column' : `${columns} columns`

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed h-px w-px" style={{ left: state.x, top: state.y }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={2} className="w-60" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem disabled={readOnly} onSelect={commands.cut}>
          Cut<DropdownMenuShortcut>{MOD}X</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={commands.copy}>
          Copy<DropdownMenuShortcut>{MOD}C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly} onSelect={() => commands.paste()}>
          Paste<DropdownMenuShortcut>{MOD}V</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={readOnly} onSelect={() => commands.paste(true)}>Paste values only</DropdownMenuItem>
        <DropdownMenuSeparator />

        {target.kind === 'row' && (
          <>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertRows(range.r1, rows))}>Insert {rowWord} above</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertRows(range.r2 + 1, rows))}>Insert {rowWord} below</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.deleteRows(range.r1, rows))}>Delete {rowWord}</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.clearSelection())}>Clear {rowWord}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.hideRows(range.r1, range.r2))}>Hide {rowWord}</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly || !workbook.hiddenRows().length} onSelect={() => say(workbook.unhideAllRows())}>Unhide all rows</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => commands.resize('row', range.r1, range.r2)}>Resize…</DropdownMenuItem>
          </>
        )}

        {target.kind === 'column' && (
          <>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertColumns(range.c1, columns))}>Insert {columnWord} left</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertColumns(range.c2 + 1, columns))}>Insert {columnWord} right</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.deleteColumns(range.c1, columns))}>Delete {columnWord}</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.clearSelection())}>Clear {columnWord}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.hideColumns(range.c1, range.c2))}>Hide {columnWord}</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly || !workbook.hiddenColumns().length} onSelect={() => say(workbook.unhideAllColumns())}>Unhide all columns</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => commands.resize('column', range.c1, range.c2)}>Resize…</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => commands.fitColumns(range.c1, range.c2)}>Fit to data</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={readOnly}
              onSelect={() => {
                workbook.selectAll()
                say(workbook.sortRange(target.column))
              }}
            >
              Sort sheet A to Z
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly}
              onSelect={() => {
                workbook.selectAll()
                say(workbook.sortRange(target.column, true))
              }}
            >
              Sort sheet Z to A
            </DropdownMenuItem>
          </>
        )}

        {target.kind === 'cell' && (
          <>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.clearSelection())}>
              Clear values<DropdownMenuShortcut>Del</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.clearFormatting())}>Clear formatting</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={readOnly} onSelect={commands.dropdown}>Dropdown…</DropdownMenuItem>
            {activeHasDropdown && (
              <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.clearValidation())}>Remove dropdown</DropdownMenuItem>
            )}
            {activeIsCheckbox ? (
              <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.removeCheckboxes())}>Remove checkbox</DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertCheckboxes())}>Insert checkbox</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertRows(range.r1, rows))}>Insert {rowWord} above</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.insertColumns(range.c1, columns))}>Insert {columnWord} left</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.deleteRows(range.r1, rows))}>Delete {rowWord}</DropdownMenuItem>
            <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.deleteColumns(range.c1, columns))}>Delete {columnWord}</DropdownMenuItem>
            {rows > 1 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.sortRange(range.c1))}>Sort range by column {columnName(range.c1)}, A to Z</DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly} onSelect={() => say(workbook.sortRange(range.c1, true))}>Sort range by column {columnName(range.c1)}, Z to A</DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
