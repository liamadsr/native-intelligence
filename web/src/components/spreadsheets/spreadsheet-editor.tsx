'use client'

/**
 * One spreadsheet open for editing. Top to bottom: its title (and a save
 * that needs the person: failed, or someone else changed it), the toolbar, the Go to cell
 * box and the formula bar, the grid, and the footer with the sheet tabs.
 * In a card the title and where it stands are in the card's header, after the
 * page's name, which is the way back to the list (Liam, 11-22: "this should
 * all move into the header. the back button should just be the breadcrum").
 *
 * It loads the record, opens the workbook in the engine, and saves a little
 * after every change against the revision it loaded, so two people editing
 * the same spreadsheet cannot silently overwrite one another: the second
 * save is refused, and that person is told and offered the newer version.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CardHeaderSlot, CardHeaderTrail, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { EntityIcon } from '@/components/entities/entity-icon'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { openModel } from '@/lib/spreadsheets/engine-client'
import type { SpreadsheetRecord, SpreadsheetSummary } from '@/lib/spreadsheets/types'
import { FindReplace } from './find-replace'
import { FormulaBar } from './formula-bar'
import { FormulaSuggest, type FormulaSuggestHandle } from './formula-suggest'
import { GridMenu, type GridCommands, type GridMenuState } from './grid-menu'
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
}

export function SpreadsheetEditor({ spreadsheetId, onBack }: SpreadsheetEditorProps) {
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
        made = new WorkbookController(model, { readOnly: json.spreadsheet.status === 'archived' })
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
  return <OpenSpreadsheet key={`${loaded.record.id}:${attempt}`} loaded={loaded} onBack={onBack} onReload={() => setAttempt((n) => n + 1)} />
}

/** The grid's outline while the workbook loads. */
function GridSkeleton({ onBack }: { onBack?: () => void }) {
  const inCard = useCardHeaderSlots() !== null
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading spreadsheet">
      {inCard && onBack ? (
        <CardHeaderTrail onBack={onBack} backLabel="Back to spreadsheets">
          <EntityIcon kind="spreadsheet" size="sm" />
          <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        </CardHeaderTrail>
      ) : (
        <div className="flex h-12 shrink-0 items-center gap-2 px-3">
          {onBack && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack} aria-label="Back to spreadsheets">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        </div>
      )}
      <div className={cn('h-9 shrink-0 border-border/60', inCard && onBack ? 'border-b' : 'border-y')} />
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

function OpenSpreadsheet({ loaded, onBack, onReload }: { loaded: Loaded; onBack?: () => void; onReload: () => void }) {
  const { workbook } = loaded
  useWorkbook(workbook)
  const [record, setRecord] = useState<SpreadsheetSummary>(loaded.record)
  const [save, setSave] = useState<SaveState>('saved')
  const [menu, setMenu] = useState<GridMenuState | null>(null)
  const [caretTick, setCaretTick] = useState(0)
  const [view, setView] = useState<ViewOptions>({ formulaBar: true, formulas: false })
  const [finding, setFinding] = useState(false)
  const [resizing, setResizing] = useState<{ axis: 'row' | 'column'; from: number; to: number; value: string } | null>(null)
  const caret = useRef<CaretState>({ start: 0, end: 0, pointed: null })
  const suggest = useRef<FormulaSuggestHandle | null>(null)
  const gridHost = useRef<HTMLDivElement>(null)
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
    try {
      const res = await fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook }),
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
      workbook.markSaved(snapshot.version)
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
          body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook }),
        }).catch(() => undefined)
      }
    }
  }, [workbook, loaded.record.id])

  // ── The title ────────────────────────────────────────────────────────────
  const [title, setTitle] = useState(loaded.record.title)
  // In a card the title and the save note are in its header (CardHeaderTrail).
  const inHeader = useCardHeaderSlots() !== null && !!onBack
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
  }

  // The name's field, in the card's header or the page's own title row.
  const nameProps = {
    'aria-label': 'Spreadsheet name',
    value: title,
    readOnly: workbook.readOnly,
    maxLength: 300,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => void renameTo(event.target.value),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur()
      else if (event.key === 'Escape') {
        setTitle(record.title)
        requestAnimationFrame(focusGrid)
      }
    },
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
      {inHeader && onBack ? (
        <>
          <CardHeaderTrail onBack={onBack} backLabel="Back to spreadsheets">
            <EntityIcon kind="spreadsheet" size="sm" />
            {/* As wide as the name (an invisible copy sizes it), renamed in place. */}
            <span className="inline-grid min-w-0 grid-cols-[minmax(0,auto)]">
              <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-1 font-medium">{title || ' '}</span>
              <input
                {...nameProps}
                data-spreadsheet-name=""
                className="col-start-1 row-start-1 w-full min-w-0 truncate rounded bg-transparent px-1 font-medium text-foreground outline-none hover:bg-foreground/[0.06] focus:bg-foreground/[0.06]"
              />
            </span>
            {record.visibility === 'private' && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </CardHeaderTrail>
          <CardHeaderSlot side="right">
            <span className="mr-2 flex items-center empty:hidden">
              <SaveNote state={workbook.readOnly ? 'saved' : save} readOnly={workbook.readOnly} onRetry={() => void saveNow()} onReload={onReload} />
            </span>
          </CardHeaderSlot>
        </>
      ) : (
        <div className="flex h-12 shrink-0 items-center gap-2 px-3">
          {onBack && (
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={onBack} aria-label="Back to spreadsheets">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}
          <input
            {...nameProps}
            className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-[15px] font-semibold text-foreground outline-none hover:bg-accent/40 focus:bg-accent/40"
          />
          {record.visibility === 'private' && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" /> Private
            </span>
          )}
          <SaveNote state={workbook.readOnly ? 'saved' : save} readOnly={workbook.readOnly} onRetry={() => void saveNow()} onReload={onReload} />
        </div>
      )}

      <Toolbar
        workbook={workbook}
        view={view}
        onView={setView}
        onFind={() => setFinding(true)}
        onPaste={(valuesOnly) => commands.paste(valuesOnly)}
        onMessage={onMessage}
        focusGrid={focusGrid}
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
        />
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
      </div>

      <SheetTabs workbook={workbook} onMessage={onMessage} focusGrid={focusGrid} />

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
  // Saved, Saving… and Unsaved changes are not shown: saving runs on its own,
  // and only what needs the person does (Liam, 11-22: "we don't need to see
  // the save button as long as it's still happening in the background").
  return null
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
