'use client'

/**
 * One spreadsheet open for editing. Top to bottom: its title (and where it
 * stands: saved, saving, who else changed it), the toolbar, the Go to cell
 * box and the formula bar, the grid, and the footer with the sheet tabs.
 *
 * It loads the record, opens the workbook in the engine, and saves a little
 * after every change against the revision it loaded, so two people editing
 * the same spreadsheet cannot silently overwrite one another: the second
 * save is refused, and that person is told and offered the newer version.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, History, Loader2, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { openModel } from '@/lib/spreadsheets/engine-client'
import { readExtras } from '@/lib/spreadsheets/extras'
import type { SpreadsheetRecord, SpreadsheetSummary } from '@/lib/spreadsheets/types'
import { ChartDialog } from './chart-dialog'
import { ConditionalFormat } from './conditional-format'
import { DataValidationDialog } from './data-validation'
import { FindReplace } from './find-replace'
import { FormulaBar } from './formula-bar'
import { GoalSeekDialog } from './goal-seek-dialog'
import { TableColumnMenu, TableOptionsPanel, type ColumnMenuState } from './table-tools'
import { FormulaSuggest, type FormulaSuggestHandle } from './formula-suggest'
import { GridMenu, type GridCommands, type GridMenuState } from './grid-menu'
import { ImportExport } from './import-export'
import { VersionHistory } from './version-history'
import { SheetGrid, pasteInto, type CaretState } from './sheet-grid'
import { SheetTabs } from './sheet-tabs'
import { Toolbar, type ViewOptions } from './toolbar'
import { useWorkbook } from './use-workbook'

/** How long after the last change a save goes out. */
const SAVE_DELAY_MS = 1200

type SaveState = 'saved' | 'unsaved' | 'saving' | 'conflict' | 'failed'

interface Loaded {
  record: SpreadsheetRecord
  workbook: WorkbookController
}

export interface SpreadsheetEditorProps {
  spreadsheetId: string
  onBack?: () => void
  /** Open another spreadsheet by id (an .xlsx just imported). */
  onOpen?: (id: string, title: string) => void
}

export function SpreadsheetEditor({ spreadsheetId, onBack, onOpen }: SpreadsheetEditorProps) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    let made: WorkbookController | null = null
    setLoaded(null)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(`/api/account/spreadsheets/${spreadsheetId}`)
        const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetRecord; error?: string }
        if (!res.ok || !json.spreadsheet) throw new Error(json.error || 'Could not load the spreadsheet')
        const model = await openModel(json.spreadsheet.workbook, json.spreadsheet.title)
        if (!live) {
          model.free()
          return
        }
        made = new WorkbookController(model, { readOnly: json.spreadsheet.status === 'archived', extras: readExtras(json.spreadsheet.extras) })
        setLoaded({ record: json.spreadsheet, workbook: made })
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : 'Could not load the spreadsheet')
      }
    })()
    return () => {
      live = false
      // After the editor under it has unmounted: its own cleanup still reads the workbook (the last save).
      const gone = made
      if (gone) setTimeout(() => gone.dispose(), 0)
    }
  }, [spreadsheetId, attempt])

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <div className="flex gap-2">
          {onBack && <Button size="sm" variant="outline" onClick={onBack}>Back</Button>}
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      </div>
    )
  }
  if (!loaded) return <GridSkeleton onBack={onBack} />
  return <OpenSpreadsheet key={`${loaded.record.id}:${attempt}`} loaded={loaded} onBack={onBack} onOpen={onOpen} onReload={() => setAttempt((n) => n + 1)} />
}

/** The grid's outline while the workbook loads. */
function GridSkeleton({ onBack }: { onBack?: () => void }) {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading spreadsheet">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {onBack && (
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack} aria-label="Back to spreadsheets">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-9 shrink-0 border-y border-border/60" />
      <div
        className="min-h-0 flex-1 animate-pulse opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(to right, hsl(var(--border) / 0.6) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.6) 1px, transparent 1px)',
          backgroundSize: '90px 25px',
        }}
      />
      <div className="h-9 shrink-0 border-t border-border/60" />
    </div>
  )
}

function OpenSpreadsheet({ loaded, onBack, onOpen, onReload }: { loaded: Loaded; onBack?: () => void; onOpen?: (id: string, title: string) => void; onReload: () => void }) {
  const { workbook } = loaded
  useWorkbook(workbook)
  const [record, setRecord] = useState<SpreadsheetSummary>(loaded.record)
  const [save, setSave] = useState<SaveState>('saved')
  const [menu, setMenu] = useState<GridMenuState | null>(null)
  const [caretTick, setCaretTick] = useState(0)
  const [view, setView] = useState<ViewOptions>({ formulaBar: true, formulas: false })
  const [finding, setFinding] = useState(false)
  const [history, setHistory] = useState(false)
  const [dialog, setDialog] = useState<'dropdown' | 'goalSeek' | null>(null)
  const [conditional, setConditional] = useState(false)
  const [tableMenu, setTableMenu] = useState<ColumnMenuState | null>(null)
  const [tablePanel, setTablePanel] = useState<string | null>(null)
  const [chartEdit, setChartEdit] = useState<string | null>(null)
  const [resizing, setResizing] = useState<{ axis: 'row' | 'column'; from: number; to: number; value: string } | null>(null)
  const caret = useRef<CaretState>({ start: 0, end: 0, pointed: null })
  const suggest = useRef<FormulaSuggestHandle | null>(null)
  const gridHost = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const revision = useRef(loaded.record.revision)
  const saving = useRef(false)
  const stopped = useRef(false)

  const focusGrid = useCallback(() => {
    gridHost.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true })
  }, [])
  const onMessage = useCallback((message: string) => toast.error(message), [])

  // ── Saving ───────────────────────────────────────────────────────────────
  const saveNow = useCallback(async () => {
    if (saving.current || stopped.current || !workbook.dirty || workbook.readOnly) return
    saving.current = true
    setSave('saving')
    const snapshot = workbook.snapshot()
    // Send the extras only when they changed, so an ordinary edit does not rewrite them.
    const extrasDirty = workbook.extrasDirty
    try {
      const res = await fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook, ...(extrasDirty ? { extras: snapshot.extras } : {}) }),
      })
      const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetSummary; error?: string; code?: string }
      if (res.status === 409) {
        stopped.current = true
        setSave('conflict')
        return
      }
      if (!res.ok || !json.spreadsheet) throw new Error(json.error || 'Could not save')
      revision.current = json.spreadsheet.revision
      setRecord((prev) => ({ ...prev, ...json.spreadsheet }))
      workbook.markSaved(snapshot.version, snapshot.extras)
      setSave(workbook.dirty ? 'unsaved' : 'saved')
    } catch {
      setSave('failed')
    } finally {
      saving.current = false
    }
  }, [workbook, loaded.record.id])

  const dataVersion = workbook.dataVersion
  useEffect(() => {
    if (!workbook.dirty || stopped.current) return
    setSave((s) => (s === 'saving' ? s : 'unsaved'))
    const timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [dataVersion, workbook, saveNow, save === 'saving'])

  // Leaving with something unsaved: save it, and let the browser ask before a tab closes.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (workbook.dirty && !stopped.current) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => {
      window.removeEventListener('beforeunload', warn)
      if (!workbook.disposed && workbook.dirty && !stopped.current && !workbook.readOnly) {
        const snapshot = workbook.snapshot()
        void fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook, ...(workbook.extrasDirty ? { extras: snapshot.extras } : {}) }),
        }).catch(() => undefined)
      }
    }
  }, [workbook, loaded.record.id])

  // ── The title ────────────────────────────────────────────────────────────
  const [title, setTitle] = useState(loaded.record.title)
  const renameTo = async (next: string) => {
    const clean = next.replace(/\s+/g, ' ').trim()
    if (!clean || clean === record.title) {
      setTitle(record.title)
      return
    }
    try {
      const res = await fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: clean }),
      })
      const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetSummary; error?: string }
      if (!res.ok || !json.spreadsheet) throw new Error(json.error || 'Could not rename')
      // A rename moves the revision on; the next save must be made from it.
      revision.current = json.spreadsheet.revision
      setRecord((prev) => ({ ...prev, ...json.spreadsheet }))
      setTitle(json.spreadsheet.title)
    } catch (e) {
      setTitle(record.title)
      toast.error(e instanceof Error ? e.message : 'Could not rename')
    }
  }

  // ── Commands the menus share ─────────────────────────────────────────────
  const commands: GridCommands = {
    cut: () => {
      focusGrid()
      if (!document.execCommand('cut')) toast.message('Use Ctrl+X (⌘X on a Mac) to cut.')
    },
    copy: () => {
      focusGrid()
      if (!document.execCommand('copy')) toast.message('Use Ctrl+C (⌘C on a Mac) to copy.')
    },
    paste: (valuesOnly) => {
      focusGrid()
      if (!navigator.clipboard?.readText) {
        toast.message('Use Ctrl+V (⌘V on a Mac) to paste.')
        return
      }
      navigator.clipboard.readText().then(
        (text) => {
          const result = pasteInto(workbook, text, '', { valuesOnly })
          if (!result.ok && result.message) onMessage(result.message)
        },
        () => toast.message('The browser did not allow reading the clipboard. Use Ctrl+V (⌘V on a Mac) to paste.'),
      )
    },
    fitColumns: (from, to) => {
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      const family = getComputedStyle(gridHost.current ?? document.body).fontFamily
      const result = workbook.fitColumns(from, to, (text) => {
        if (!context) return text.length * 7.5 + 14
        context.font = `13px ${family}`
        return Math.max(...text.split('\n').map((line) => context.measureText(line).width)) + 16
      })
      if (!result.ok) onMessage(result.message)
    },
    resize: (axis, from, to) => {
      const layout = workbook.layout()
      const starts = axis === 'column' ? layout.columnStarts : layout.rowStarts
      setResizing({ axis, from, to, value: String(Math.round(starts[from] - starts[from - 1])) })
    },
    dropdown: () => setDialog('dropdown'),
    convertToTable: () => {
      const result = workbook.convertToTable()
      if (!result.ok) onMessage(result.message)
      focusGrid()
    },
    tableOptions: (id) => setTablePanel(id),
  }

  const insertImage = () => imageInput.current?.click()
  const onImageFile = async (file: File | undefined) => {
    if (imageInput.current) imageInput.current.value = ''
    if (!file) return
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { width, height } = await imageDimensions(file)
      const { result } = workbook.insertImageFromBytes(bytes, width, height)
      if (!result.ok) onMessage(result.message)
    } catch {
      onMessage('Could not read that image.')
    }
    focusGrid()
  }
  const convertOrOptions = () => {
    const sel = workbook.selection()
    const table = workbook.tableAtCell(sel.row, sel.column)
    if (table) setTablePanel(table.id)
    else {
      const result = workbook.convertToTable()
      if (!result.ok) onMessage(result.message)
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-spreadsheet-editor
      onKeyDown={(event) => {
        // Ctrl/Cmd+F anywhere in the editor: this spreadsheet's find, not the browser's.
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
          event.preventDefault()
          if (workbook.editing) workbook.commitEdit()
          setFinding(true)
        }
      }}
    >
      {/* Title bar */}
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        {onBack && (
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack} aria-label="Back to spreadsheets">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <input
          aria-label="Spreadsheet name"
          value={title}
          readOnly={workbook.readOnly}
          maxLength={300}
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-[15px] font-semibold text-foreground outline-none hover:bg-accent/40 focus:bg-accent/40"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={(event) => void renameTo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            else if (event.key === 'Escape') {
              setTitle(record.title)
              requestAnimationFrame(focusGrid)
            }
          }}
        />
        {record.visibility === 'private' && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" /> Private
          </span>
        )}
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Version history" aria-pressed={history} title="Version history" onClick={() => setHistory((on) => !on)}>
          <History className="h-4 w-4" />
        </Button>
        <SaveNote state={workbook.readOnly ? 'saved' : save} readOnly={workbook.readOnly} onRetry={() => void saveNow()} onReload={onReload} />
      </div>

      <Toolbar
        workbook={workbook}
        view={view}
        onView={setView}
        onFind={() => setFinding(true)}
        onPaste={(valuesOnly) => commands.paste(valuesOnly)}
        onMessage={onMessage}
        focusGrid={focusGrid}
        onDropdown={() => setDialog('dropdown')}
        onConditionalFormatting={() => setConditional(true)}
        onGoalSeek={() => setDialog('goalSeek')}
        onInsertChart={() => {
          const { result } = workbook.insertChart('column')
          if (!result.ok) onMessage(result.message)
          focusGrid()
        }}
        onInsertImage={insertImage}
        onConvertToTable={commands.convertToTable}
        onTableOptions={(id) => setTablePanel(id)}
      />

      {view.formulaBar && <FormulaBar workbook={workbook} caret={caret} suggest={suggest} onCaret={() => setCaretTick((n) => n + 1)} onMessage={onMessage} focusGrid={focusGrid} />}

      <div ref={gridHost} className="relative min-h-0 flex-1">
        <SheetGrid
          workbook={workbook}
          caret={caret}
          ariaLabel={`${record.title}: ${workbook.sheets()[workbook.sheet]?.name ?? 'sheet'}`}
          showGridlines={workbook.showGridLines()}
          showFormulas={view.formulas}
          onMessage={onMessage}
          onContextMenu={(target, at) => setMenu({ target, x: at.x, y: at.y })}
          onEditorKey={(event) => suggest.current?.handleKey(event) ?? false}
          onTableColumnMenu={(table, offset, at) => setTableMenu({ table, offset, x: at.x, y: at.y })}
          onEditChart={(id) => setChartEdit(id)}
          onTableShortcut={convertOrOptions}
        />
        {history && (
          <VersionHistory
            spreadsheetId={loaded.record.id}
            revision={record.revision}
            readOnly={workbook.readOnly}
            dirty={workbook.dirty}
            onMessage={onMessage}
            onClose={() => {
              setHistory(false)
              focusGrid()
            }}
            onRestored={() => {
              // The restore is saved; what is open here is the older workbook, so nothing of it is saved over it.
              stopped.current = true
              onReload()
            }}
          />
        )}
        {finding && (
          <FindReplace
            workbook={workbook}
            onMessage={(message) => (message.startsWith('Replaced') ? toast.message(message) : onMessage(message))}
            onClose={() => {
              setFinding(false)
              focusGrid()
            }}
          />
        )}
        {conditional && (
          <ConditionalFormat
            workbook={workbook}
            onMessage={onMessage}
            onClose={() => {
              setConditional(false)
              focusGrid()
            }}
          />
        )}
        {tablePanel && (
          <TableOptionsPanel
            workbook={workbook}
            tableId={tablePanel}
            onMessage={onMessage}
            focusGrid={focusGrid}
            onClose={() => {
              setTablePanel(null)
              focusGrid()
            }}
          />
        )}
      </div>

      <SheetTabs
        workbook={workbook}
        onMessage={onMessage}
        focusGrid={focusGrid}
        trailing={<ImportExport workbook={workbook} title={record.title} onMessage={onMessage} onOpen={onOpen} focusGrid={focusGrid} />}
      />

      <FormulaSuggest workbook={workbook} caret={caret} handle={suggest} caretTick={caretTick} />
      <GridMenu
        workbook={workbook}
        state={menu}
        onClose={() => {
          setMenu(null)
          requestAnimationFrame(focusGrid)
        }}
        commands={commands}
        onMessage={onMessage}
      />
      {dialog === 'dropdown' && (
        <DataValidationDialog
          workbook={workbook}
          onMessage={onMessage}
          focusGrid={focusGrid}
          onClose={() => {
            setDialog(null)
            focusGrid()
          }}
        />
      )}
      {dialog === 'goalSeek' && (
        <GoalSeekDialog
          workbook={workbook}
          onMessage={onMessage}
          focusGrid={focusGrid}
          onClose={() => {
            setDialog(null)
            focusGrid()
          }}
        />
      )}
      {tableMenu && (
        <TableColumnMenu
          workbook={workbook}
          state={tableMenu}
          onMessage={onMessage}
          onOpenOptions={(id) => {
            setTableMenu(null)
            setTablePanel(id)
          }}
          onClose={() => {
            setTableMenu(null)
            requestAnimationFrame(focusGrid)
          }}
        />
      )}
      {chartEdit && (
        <ChartDialog
          workbook={workbook}
          chartId={chartEdit}
          onMessage={onMessage}
          focusGrid={focusGrid}
          onClose={() => setChartEdit(null)}
        />
      )}
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => void onImageFile(event.target.files?.[0] ?? undefined)}
      />
      {resizing && (
        <ResizeBox
          state={resizing}
          onCancel={() => {
            setResizing(null)
            focusGrid()
          }}
          onApply={(px) => {
            const result = resizing.axis === 'column' ? workbook.setColumnWidth(resizing.from, resizing.to, px) : workbook.setRowHeight(resizing.from, resizing.to, px)
            if (!result.ok) onMessage(result.message)
            setResizing(null)
            focusGrid()
          }}
        />
      )}
    </div>
  )
}

/** An image file's natural size, scaled so it is at most 360 px wide. Falls back to a default if it cannot be read. */
async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  const fallback = { width: 240, height: 180 }
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return fallback
  const url = URL.createObjectURL(file)
  try {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.naturalWidth || 240, height: img.naturalHeight || 180 })
      img.onerror = reject
      img.src = url
    })
    const max = 360
    if (size.width <= max) return size
    const scale = max / size.width
    return { width: max, height: Math.round(size.height * scale) }
  } catch {
    return fallback
  } finally {
    URL.revokeObjectURL(url)
  }
}

function SaveNote({ state, readOnly, onRetry, onReload }: { state: SaveState; readOnly: boolean; onRetry: () => void; onReload: () => void }) {
  if (readOnly) return <span className="shrink-0 text-xs text-muted-foreground">Archived: view only</span>
  if (state === 'conflict') {
    return (
      <span role="alert" className="flex shrink-0 items-center gap-2 text-xs text-destructive">
        Someone else changed this spreadsheet. Your last changes are not saved.
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onReload}>Load their version</Button>
      </span>
    )
  }
  if (state === 'failed') {
    return (
      <span role="alert" className="flex shrink-0 items-center gap-2 text-xs text-destructive">
        Not saved
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onRetry}>Try again</Button>
      </span>
    )
  }
  return (
    <span aria-live="polite" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      {state === 'saving' && <Loader2 className="h-3 w-3 animate-spin" />}
      {state === 'saved' ? 'Saved' : state === 'saving' ? 'Saving…' : 'Unsaved changes'}
    </span>
  )
}

function ResizeBox({ state, onCancel, onApply }: { state: { axis: 'row' | 'column'; from: number; to: number; value: string }; onCancel: () => void; onApply: (px: number) => void }) {
  const [value, setValue] = useState(state.value)
  const many = state.to > state.from
  const what = state.axis === 'column' ? (many ? 'Column width' : 'Column width') : 'Row height'
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/40" onPointerDown={onCancel}>
      <form
        className="w-64 rounded-xl border border-border/60 bg-background p-4 shadow-lg"
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          const px = Number(value)
          if (Number.isFinite(px) && px > 0) onApply(px)
        }}
      >
        <label className="block text-sm font-medium text-foreground">
          {what}{many ? ` (${state.to - state.from + 1} selected)` : ''}
          <input
            autoFocus
            type="number"
            min={8}
            max={640}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && onCancel()}
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          />
        </label>
        <p className="mt-1 text-xs text-muted-foreground">In pixels, 8 to 640.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" size="sm">Apply</Button>
        </div>
      </form>
    </div>
  )
}
