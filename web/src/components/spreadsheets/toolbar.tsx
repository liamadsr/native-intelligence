'use client'

/**
 * The formatting row above the formula bar. Left to right: font size (smaller,
 * the size, larger); bold, italic, strikethrough, underline; undo, redo,
 * currency, percent, fewer and more decimal places, wrap; find and replace;
 * then the menus: number format, font, text color, fill, borders, horizontal
 * and vertical alignment, functions, paste special, view options, format and
 * data. On a narrow card the row scrolls sideways; nothing is hidden.
 *
 * A press never takes the keyboard from the grid.
 */
import { useState } from 'react'
import {
  AlignCenter, AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  Baseline, Bold, ChevronDown, ClipboardPaste, DollarSign, Eye, Grid2x2, Italic, Minus, PaintBucket, Percent, Plus, Redo2,
  Search, Sigma, SlidersHorizontal, Strikethrough, Type, Underline, Undo2, WrapText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { BorderKind, WorkbookController } from '@/lib/spreadsheets/controller'
import { DEFAULT_FONT_POINTS } from '@/lib/spreadsheets/cell-view'
import { DATE_FORMATS, FONT_FAMILIES, FONT_SIZES, NUMBER_FORMATS, PALETTE, formatKind } from '@/lib/spreadsheets/formats'
import { SAMPLE_DATE, previewFormat } from '@/lib/spreadsheets/format-preview'

export interface ViewOptions {
  formulaBar: boolean
  formulas: boolean
}

interface Props {
  workbook: WorkbookController
  view: ViewOptions
  onView: (next: ViewOptions) => void
  onFind: () => void
  onPaste: (valuesOnly?: boolean) => void
  onMessage: (message: string) => void
  focusGrid: () => void
}

const ICON = 'h-3.5 w-3.5'
const QUICK_FUNCTIONS = ['SUM', 'AVERAGE', 'COUNT', 'MIN', 'MAX'] as const
const BORDERS: ReadonlyArray<{ kind: BorderKind; label: string }> = [
  { kind: 'All', label: 'All borders' },
  { kind: 'Inner', label: 'Inside borders' },
  { kind: 'Outer', label: 'Outside borders' },
  { kind: 'Top', label: 'Top border' },
  { kind: 'Bottom', label: 'Bottom border' },
  { kind: 'Left', label: 'Left border' },
  { kind: 'Right', label: 'Right border' },
  { kind: 'CenterH', label: 'Horizontal inside borders' },
  { kind: 'CenterV', label: 'Vertical inside borders' },
  { kind: 'None', label: 'No borders' },
]

function Button({ label, pressed, disabled, onClick, children, wide }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        'flex h-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        wide ? 'gap-0.5 px-1' : 'w-[26px]',
        pressed && 'bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  )
}

const Divider = () => <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-border" />

function MenuButton({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button
        type="button"
        title={label}
        aria-label={label}
        disabled={disabled}
        className="flex h-7 shrink-0 items-center rounded-md px-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        {children}
        <ChevronDown className="h-2.5 w-2.5 opacity-50" />
      </button>
    </DropdownMenuTrigger>
  )
}

function Swatches({ label, current, onPick, onClear, clearLabel }: { label: string; current: string | null; onPick: (hex: string) => void; onClear: () => void; clearLabel: string }) {
  return (
    <div className="p-1.5">
      <DropdownMenuLabel className="px-1 pb-1.5 pt-0.5 text-xs font-medium text-muted-foreground">{label}</DropdownMenuLabel>
      <div role="group" aria-label={label} className="grid grid-cols-5 gap-1">
        {PALETTE.map((color) => (
          <DropdownMenuItem
            key={color.hex}
            aria-label={color.name}
            title={color.name}
            onSelect={() => onPick(color.hex)}
            className={cn('h-6 w-6 cursor-pointer rounded-md border border-border/70 p-0 focus:ring-2 focus:ring-primary', current?.toUpperCase() === color.hex && 'ring-2 ring-primary')}
            style={{ backgroundColor: color.hex }}
          />
        ))}
      </div>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onClear}>{clearLabel}</DropdownMenuItem>
    </div>
  )
}

export function Toolbar({ workbook, view, onView, onFind, onPaste, onMessage, focusGrid }: Props) {
  const readOnly = workbook.readOnly
  const { row, column } = workbook.selection()
  const style = workbook.style(row, column)
  const font = style.font
  const size = font?.sz ?? DEFAULT_FONT_POINTS
  const kind = formatKind(style.num_fmt || 'general')
  const horizontal = style.alignment?.horizontal ?? 'general'
  const vertical = style.alignment?.vertical ?? 'bottom'
  const wrap = style.alignment?.wrap_text ?? false
  const [sizeDraft, setSizeDraft] = useState<string | null>(null)
  const [customDate, setCustomDate] = useState<string | null>(null)

  const run = (result: { ok: boolean; message?: string }) => {
    if (!result.ok && result.message) onMessage(result.message)
    focusGrid()
  }
  const set = (path: string, value: string) => run(workbook.setStyle(path, value))
  const after = { onCloseAutoFocus: (event: Event) => { event.preventDefault(); focusGrid() } }
  const HIcon = horizontal === 'center' ? AlignCenter : horizontal === 'right' ? AlignRight : AlignLeft
  const VIcon = vertical === 'top' ? AlignVerticalJustifyStart : vertical === 'center' ? AlignVerticalJustifyCenter : AlignVerticalJustifyEnd

  return (
    <div role="toolbar" aria-label="Formatting" className="flex h-9 shrink-0 items-center gap-px overflow-x-auto border-y border-border/60 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* Font size */}
      <Button label="Decrease font size" disabled={readOnly} onClick={() => run(workbook.stepFontSize(-1))}><Minus className={ICON} /></Button>
      <input
        aria-label="Font size"
        list="spreadsheet-font-sizes"
        inputMode="numeric"
        disabled={readOnly}
        value={sizeDraft ?? String(size)}
        className="h-7 w-9 shrink-0 rounded-md border border-border/60 bg-transparent text-center text-[12px] tabular-nums text-foreground outline-none focus:border-primary disabled:opacity-40"
        onFocus={(event) => { setSizeDraft(String(size)); event.currentTarget.select() }}
        onChange={(event) => setSizeDraft(event.target.value.replace(/[^0-9]/g, '').slice(0, 2))}
        onBlur={() => setSizeDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            const next = Number(sizeDraft)
            setSizeDraft(null)
            if (next > 0) run(workbook.setFontSize(next))
            else focusGrid()
          } else if (event.key === 'Escape') {
            setSizeDraft(null)
            focusGrid()
          }
        }}
      />
      <datalist id="spreadsheet-font-sizes">{FONT_SIZES.map((s) => <option key={s} value={s} />)}</datalist>
      <Button label="Increase font size" disabled={readOnly} onClick={() => run(workbook.stepFontSize(1))}><Plus className={ICON} /></Button>
      <Divider />

      {/* Text styles */}
      <Button label="Bold" pressed={Boolean(font?.b)} disabled={readOnly} onClick={() => set('font.b', font?.b ? 'false' : 'true')}><Bold className={ICON} /></Button>
      <Button label="Italic" pressed={Boolean(font?.i)} disabled={readOnly} onClick={() => set('font.i', font?.i ? 'false' : 'true')}><Italic className={ICON} /></Button>
      <Button label="Strikethrough" pressed={Boolean(font?.strike)} disabled={readOnly} onClick={() => set('font.strike', font?.strike ? 'false' : 'true')}><Strikethrough className={ICON} /></Button>
      <Button label="Underline" pressed={Boolean(font?.u)} disabled={readOnly} onClick={() => set('font.u', font?.u ? 'false' : 'true')}><Underline className={ICON} /></Button>
      <Divider />

      {/* Spreadsheet formatting */}
      <Button label="Undo" disabled={!workbook.canUndo()} onClick={() => run(workbook.undo())}><Undo2 className={ICON} /></Button>
      <Button label="Redo" disabled={!workbook.canRedo()} onClick={() => run(workbook.redo())}><Redo2 className={ICON} /></Button>
      <Button label="Format as currency" pressed={kind === 'currency'} disabled={readOnly} onClick={() => run(workbook.setNumberFormat(NUMBER_FORMATS[2].code))}><DollarSign className={ICON} /></Button>
      <Button label="Format as percent" pressed={kind === 'percent'} disabled={readOnly} onClick={() => run(workbook.setNumberFormat(NUMBER_FORMATS[4].code))}><Percent className={ICON} /></Button>
      <Button label="Decrease decimal places" disabled={readOnly} wide onClick={() => run(workbook.changeDecimals(-1))}><span className="text-[11px] font-medium tabular-nums">.0</span><Minus className="h-2.5 w-2.5" /></Button>
      <Button label="Increase decimal places" disabled={readOnly} wide onClick={() => run(workbook.changeDecimals(1))}><span className="text-[11px] font-medium tabular-nums">.00</span><Plus className="h-2.5 w-2.5" /></Button>
      <Button label="Wrap text" pressed={wrap} disabled={readOnly} onClick={() => set('alignment.wrap_text', wrap ? 'false' : 'true')}><WrapText className={ICON} /></Button>
      <Divider />
      <Button label="Find and replace" onClick={onFind}><Search className={ICON} /></Button>
      <Divider />

      {/* Number format */}
      <DropdownMenu>
        <MenuButton label="Number format" disabled={readOnly}><span className="text-[11.5px] font-medium">123</span></MenuButton>
        <DropdownMenuContent align="start" className="w-64" {...after}>
          {NUMBER_FORMATS.filter((f) => f.id !== 'date').map((f) => (
            <DropdownMenuCheckboxItem key={f.id} checked={kind === f.id} onCheckedChange={() => run(workbook.setNumberFormat(f.code))}>
              <span className="flex-1">{f.label}</span>
              <span className="ml-3 text-xs tabular-nums text-muted-foreground">{f.example}</span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className={cn(kind === 'date' && 'font-medium')}>Date</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-64">
              {DATE_FORMATS.map((f) => (
                <DropdownMenuCheckboxItem key={f.code} checked={style.num_fmt === f.code} onCheckedChange={() => run(workbook.setNumberFormat(f.code))}>
                  {f.example}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCustomDate(kind === 'date' || kind === 'time' ? style.num_fmt : 'ddd, mmm d, yyyy')}>Custom date and time…</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Font */}
      <DropdownMenu>
        <MenuButton label="Font" disabled={readOnly}><Type className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-52" {...after}>
          {FONT_FAMILIES.map((f) => (
            <DropdownMenuCheckboxItem key={f.name} checked={(font?.name ?? 'Inter') === f.name} onCheckedChange={() => run(workbook.setFontFamily(f.name))}>
              <span style={f.name === 'Inter' ? undefined : { fontFamily: `"${f.name}"` }}>{f.label}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Colors */}
      <DropdownMenu>
        <MenuButton label="Text color" disabled={readOnly}>
          <span className="flex flex-col items-center"><Baseline className="h-3 w-3" /><span aria-hidden className="h-[3px] w-3.5 rounded-sm" style={{ backgroundColor: typeof font?.color === 'string' ? font.color : 'currentColor' }} /></span>
        </MenuButton>
        <DropdownMenuContent align="start" className="w-auto" {...after}>
          <Swatches label="Text color" current={typeof font?.color === 'string' ? font.color : null} onPick={(hex) => set('font.color', hex)} onClear={() => set('font.color', '#000000')} clearLabel="Automatic" />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuButton label="Fill color" disabled={readOnly}>
          <span className="flex flex-col items-center"><PaintBucket className="h-3 w-3" /><span aria-hidden className="h-[3px] w-3.5 rounded-sm border border-border/60" style={{ backgroundColor: typeof style.fill?.color === 'string' ? style.fill.color : 'transparent' }} /></span>
        </MenuButton>
        <DropdownMenuContent align="start" className="w-auto" {...after}>
          <Swatches label="Fill color" current={typeof style.fill?.color === 'string' ? style.fill.color : null} onPick={(hex) => set('fill.fg_color', hex)} onClear={() => set('fill.fg_color', '')} clearLabel="No fill" />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Borders */}
      <DropdownMenu>
        <MenuButton label="Borders" disabled={readOnly}><Grid2x2 className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-56" {...after}>
          {BORDERS.map((b) => (
            <DropdownMenuItem key={b.kind} onSelect={() => run(workbook.setBorders(b.kind))}>{b.label}</DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => run(workbook.setBorders('Outer', { style: 'medium' }))}>Thick outside border</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Alignment */}
      <DropdownMenu>
        <MenuButton label="Horizontal alignment" disabled={readOnly}><HIcon className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-44" {...after}>
          <DropdownMenuCheckboxItem checked={horizontal === 'general'} onCheckedChange={() => set('alignment.horizontal', 'general')}>Automatic</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={horizontal === 'left'} onCheckedChange={() => set('alignment.horizontal', 'left')}>Left</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={horizontal === 'center'} onCheckedChange={() => set('alignment.horizontal', 'center')}>Center</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={horizontal === 'right'} onCheckedChange={() => set('alignment.horizontal', 'right')}>Right</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <MenuButton label="Vertical alignment" disabled={readOnly}><VIcon className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-44" {...after}>
          <DropdownMenuCheckboxItem checked={vertical === 'top'} onCheckedChange={() => set('alignment.vertical', 'top')}>Top</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={vertical === 'center'} onCheckedChange={() => set('alignment.vertical', 'center')}>Middle</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={vertical === 'bottom'} onCheckedChange={() => set('alignment.vertical', 'bottom')}>Bottom</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Functions */}
      <DropdownMenu>
        <MenuButton label="Functions" disabled={readOnly}><Sigma className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-44" {...after}>
          {QUICK_FUNCTIONS.map((name) => (
            <DropdownMenuItem key={name} className="font-mono text-[12px]" onSelect={() => run(workbook.insertFunction(name))}>{name}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Paste special */}
      <DropdownMenu>
        <MenuButton label="Paste special" disabled={readOnly}><ClipboardPaste className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-48" {...after}>
          <DropdownMenuItem onSelect={() => onPaste()}>Paste</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaste(true)}>Paste values only</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* View options */}
      <DropdownMenu>
        <MenuButton label="View options"><Eye className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-48" {...after}>
          <DropdownMenuCheckboxItem checked={workbook.showGridLines()} disabled={readOnly} onCheckedChange={(on) => run(workbook.setShowGridLines(Boolean(on)))}>Gridlines</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={view.formulaBar} onCheckedChange={(on) => onView({ ...view, formulaBar: Boolean(on) })}>Formula bar</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={view.formulas} onCheckedChange={(on) => onView({ ...view, formulas: Boolean(on) })}>Formulas</DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Format and data */}
      <DropdownMenu>
        <MenuButton label="Format and data" disabled={readOnly}><SlidersHorizontal className={ICON} /></MenuButton>
        <DropdownMenuContent align="start" className="w-56" {...after}>
          <DropdownMenuItem onSelect={() => run(workbook.sortRange(workbook.selection().range.c1))}>Sort range A to Z</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(workbook.sortRange(workbook.selection().range.c1, true))}>Sort range Z to A</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(workbook.trimWhitespace())}>Trim whitespace</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => run(workbook.fillDown())}>Fill down</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(workbook.fillRight())}>Fill right</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => run(workbook.clearFormatting())}>Clear formatting</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(workbook.clearSelection())}>Clear values</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {customDate !== null && (
        <CustomDateBox
          initial={customDate}
          onCancel={() => { setCustomDate(null); focusGrid() }}
          onApply={(code) => { setCustomDate(null); run(workbook.setNumberFormat(code)) }}
        />
      )}
    </div>
  )
}

/** "Custom date and time…": any Excel date or time code, with what 9 March 2026, 6:00 PM looks like in it. */
function CustomDateBox({ initial, onCancel, onApply }: { initial: string; onCancel: () => void; onApply: (code: string) => void }) {
  const [code, setCode] = useState(initial)
  const preview = previewFormat(code, SAMPLE_DATE)
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-background/40" onPointerDown={onCancel}>
      <form
        aria-label="Custom date and time"
        className="w-80 rounded-xl border border-border/60 bg-background p-4 shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (preview !== null) onApply(code.trim())
        }}
      >
        <label className="block text-sm font-medium text-foreground">
          Custom date and time
          <input
            autoFocus
            aria-label="Format code"
            value={code}
            spellCheck={false}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && onCancel()}
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:border-primary"
          />
        </label>
        <p className="mt-2 text-sm" aria-live="polite">
          {preview !== null ? <span className="text-foreground">{preview}</span> : <span className="text-destructive">That is not a format this spreadsheet can show.</span>}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">d, dd, ddd, dddd for the day; m to mmmm for the month; yy or yyyy; h, mm, ss and AM/PM for the time.</p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="rounded-md px-2.5 py-1 text-sm text-muted-foreground hover:bg-accent" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={preview === null} className="rounded-md bg-primary px-2.5 py-1 text-sm text-primary-foreground disabled:opacity-40">Apply</button>
        </div>
      </form>
    </div>
  )
}
