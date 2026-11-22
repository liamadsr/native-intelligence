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
import { ArrowLeft, History, Link2, Lock, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CardHeaderSlot, CardHeaderTrail, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { EntityIcon } from '@/components/entities/entity-icon'
import { EntityActionsMenu, PANEL_OMIT } from '@/components/entities/entity-actions-menu'
import { LinksPanel } from './links-panel'
import { parseRange, rangeName } from '@/lib/spreadsheets/a1'
import { WorkbookController } from '@/lib/spreadsheets/controller'
import { openModel } from '@/lib/spreadsheets/engine-client'
import { appendStructure, readExtras, type ExtrasChange, type StructureEntry, type WorkbookExtras } from '@/lib/spreadsheets/extras'
import { droppedNote, mergeExtras, rebaseWithLog } from '@/lib/spreadsheets/sync'
import type { SpreadsheetRecord, SpreadsheetSummary } from '@/lib/spreadsheets/types'
import { CommentOverlay, CommentsPanel, useSpreadsheetComments } from './comments'
import { createClient } from '@/lib/supabase/client'
import { type RoomClient } from '@/components/canvas/live'
import { SpreadsheetPresence, peerColor, type SheetSelection } from './presence'
import { PeerFaces, PresenceOverlay, useSheetPeers } from './presence-layer'
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
/** How often, while the tab is visible, the editor asks whether someone else saved. */
const POLL_MS = 4000
/** How many times a save retries the rebase-and-save loop before giving up. */
const MAX_MERGE_ATTEMPTS = 4

type SaveState = 'saved' | 'unsaved' | 'saving' | 'failed'

interface Loaded {
  record: SpreadsheetRecord
  workbook: WorkbookController
  memberId: string
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
        const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetRecord; member_id?: string; error?: string }
        if (!res.ok || !json.spreadsheet) throw new Error(json.error || 'Could not load the spreadsheet')
        const model = await openModel(json.spreadsheet.workbook, json.spreadsheet.title)
        if (!live) {
          model.free()
          return
        }
        made = new WorkbookController(model, { readOnly: json.spreadsheet.status === 'archived', extras: readExtras(json.spreadsheet.extras) })
        setLoaded({ record: json.spreadsheet, workbook: made, memberId: json.member_id ?? '' })
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

/** A structural change as a log entry stamped with the revision the save is made over; null for a kind not logged. */
function structureEntryFromChange(change: ExtrasChange, base: number): StructureEntry | null {
  if (change.type === 'insertRows' || change.type === 'deleteRows' || change.type === 'insertColumns' || change.type === 'deleteColumns') {
    return { base, sheetId: change.sheetId, type: change.type, at: change.at, count: change.count }
  }
  if (change.type === 'deleteSheet') return { base, sheetId: change.sheetId, type: 'deleteSheet' }
  return null
}

/** The newer record a poll or a conflict pointed at, with its workbook, loaded fresh. */
async function fetchRecord(id: string): Promise<SpreadsheetRecord | null> {
  const res = await fetch(`/api/account/spreadsheets/${id}`)
  const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetRecord }
  return res.ok && json.spreadsheet ? json.spreadsheet : null
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
  const [showComments, setShowComments] = useState(false)
  const [showLinks, setShowLinks] = useState(false)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [composingAnchor, setComposingAnchor] = useState<string | null>(null)
  const [updatedBy, setUpdatedBy] = useState<string | null>(null)
  // Set when a merge cannot be done with certainty (the other person changed rows,
  // columns or sheets under my unsaved edits): the editor keeps my version on screen,
  // stops saving and polling, and offers to load the latest.
  const [guard, setGuard] = useState<{ name: string | null } | null>(null)
  // My unsaved structural edits (and the inverse of any I undid), stamped with the
  // base revision of each save attempt and written into the saved structure log.
  const unsavedStructure = useRef<ExtrasChange[]>([])
  const caret = useRef<CaretState>({ start: 0, end: 0, pointed: null })
  const suggest = useRef<FormulaSuggestHandle | null>(null)
  const gridHost = useRef<HTMLDivElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const revision = useRef(loaded.record.revision)
  const saving = useRef(false)
  const stopped = useRef(false)
  // The dataVersion a save gave up at, so a failed save does not auto-retry
  // forever; a new edit (a higher dataVersion) or a manual retry resumes it.
  const giveUp = useRef(-1)

  const focusGrid = useCallback(() => {
    gridHost.current?.querySelector<HTMLElement>('[role="grid"]')?.focus({ preventScroll: true })
  }, [])
  const onMessage = useCallback((message: string) => toast.error(message), [])
  const comments = useSpreadsheetComments(loaded.record.id, onMessage)

  // ── Presence: who else has this open, and each one's selected cell ─────────
  // Independent of saving — a view-only (archived) viewer is as much "here" as
  // an editor — so this runs whatever the spreadsheet's status. The controller
  // joins a private Realtime room (migration 689); if the server refuses, it
  // stays quiet and shows nobody else.
  const [presence, setPresence] = useState<SpreadsheetPresence | null>(null)
  useEffect(() => {
    const supabase = createClient()
    let live = true
    let controller: SpreadsheetPresence | null = null
    let offWorkbook: (() => void) | null = null
    const snapshot = (): SheetSelection => {
      const sel = workbook.selection()
      return { sheetId: workbook.sheetIdAt(), range: sel.range, active: { row: sel.row, column: sel.column } }
    }
    const onVisible = () => controller?.setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisible)
    void supabase.auth.getUser().then(({ data }) => {
      const user = data.user
      if (!live || !user) return
      const meta = (user.user_metadata ?? {}) as { full_name?: string; name?: string }
      const name = (meta.full_name || meta.name || user.email?.split('@')[0] || 'Someone').slice(0, 60)
      const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
      const me = { key, userId: user.id, name, color: peerColor(user.id) }
      controller = new SpreadsheetPresence(supabase as unknown as RoomClient, loaded.record.id, me, snapshot())
      setPresence(controller)
      controller.setVisible(!document.hidden)
      controller.start()
      // The editor re-renders on every workbook change; feed presence only when
      // the sheet or selection actually moved (the controller throttles sends).
      let last = ''
      offWorkbook = workbook.subscribe(() => {
        const next = snapshot()
        const sig = `${next.sheetId}:${next.range.r1},${next.range.c1},${next.range.r2},${next.range.c2}:${next.active.row},${next.active.column}`
        if (sig === last) return
        last = sig
        controller?.update(next)
      })
    })
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
      offWorkbook?.()
      controller?.stop()
      setPresence(null)
    }
  }, [loaded.record.id, workbook])
  const peers = useSheetPeers(presence?.peers ?? null)

  // A quiet "Updated by …" note for a few seconds after someone else's change lands.
  const noteUpdatedBy = useCallback((name: string | null) => {
    if (!name) return
    setUpdatedBy(name)
    setTimeout(() => setUpdatedBy(null), 4000)
  }, [])

  // ── Saving, with merge on a conflict ──────────────────────────────────────
  // Load the newer workbook, replay my unsaved work onto it, adopt the result,
  // and keep saving against the new revision. Nobody's work is lost — unless the
  // other person changed rows, columns or sheets I cannot move my edits around,
  // when we stop instead of guessing (the guard).

  // Stop saving and polling and keep my version on screen; the person copies
  // what they need and loads the latest.
  const enterGuard = useCallback((name: string | null) => {
    stopped.current = true
    setGuard({ name })
    setSave('saved')
  }, [])

  // The extras to save, with the structure log = the server's log as of my base
  // revision plus my unsaved structural edits, each stamped with that revision.
  const buildExtrasToSave = useCallback((): WorkbookExtras => {
    const entries = unsavedStructure.current
      .map((c) => structureEntryFromChange(c, revision.current))
      .filter((e): e is StructureEntry => e !== null)
    const { structure, structureFloor } = appendStructure(workbook.baseExtras.structure, workbook.baseExtras.structureFloor, entries)
    return { ...workbook.extras, structure, structureFloor }
  }, [workbook])

  const rebaseOntoLatest = useCallback(async (name: string | null): Promise<'merged' | 'stopped' | 'failed'> => {
    const latest = await fetchRecord(loaded.record.id)
    if (!latest) return 'failed'
    const theirs = await openModel(latest.workbook, latest.title)
    const theirExtras = readExtras(latest.extras)
    const result = rebaseWithLog({
      theirs,
      theirsExtras: theirExtras,
      myBaseRevision: revision.current,
      mySheets: workbook.sheets(),
      pending: workbook.pendingActions(),
    })
    if (result.status === 'stop') {
      theirs.free()
      enterGuard(name)
      return 'stopped'
    }
    workbook.adopt(theirs, workbook.extrasDirty ? mergeExtras(workbook.baseExtras, workbook.extras, theirExtras) : theirExtras, theirExtras)
    workbook.replacePending(result.pending)
    revision.current = latest.revision
    setRecord((prev) => ({ ...prev, revision: latest.revision, last_edited_by: latest.last_edited_by }))
    const note = droppedNote(result.dropped)
    if (note) onMessage(note)
    return 'merged'
  }, [workbook, loaded.record.id, onMessage, enterGuard])

  const saveNow = useCallback(async () => {
    if (saving.current || stopped.current || !workbook.dirty || workbook.readOnly) return
    saving.current = true
    setSave('saving')
    try {
      for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
        const snapshot = workbook.snapshot()
        const sendExtras = workbook.extrasDirty || unsavedStructure.current.length > 0
        const extras = sendExtras ? buildExtrasToSave() : undefined
        const res = await fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook, ...(extras ? { extras } : {}) }),
        })
        const json = (await res.json().catch(() => ({}))) as { spreadsheet?: SpreadsheetSummary; error?: string }
        if (res.status === 409) {
          const outcome = await rebaseOntoLatest(null)
          if (outcome === 'stopped') return
          if (outcome === 'failed') {
            giveUp.current = workbook.dataVersion
            setSave('failed')
            return
          }
          continue // save again, now against the newer revision (my structure entries re-stamped)
        }
        if (!res.ok || !json.spreadsheet) throw new Error(json.error || 'Could not save')
        revision.current = json.spreadsheet.revision
        giveUp.current = -1
        setRecord((prev) => ({ ...prev, ...json.spreadsheet }))
        workbook.markSaved(snapshot.version, extras ?? snapshot.extras, snapshot.pending)
        if (extras) unsavedStructure.current = []
        setSave(workbook.dirty ? 'unsaved' : 'saved')
        return
      }
      giveUp.current = workbook.dataVersion
      setSave('failed')
    } catch {
      giveUp.current = workbook.dataVersion
      setSave('failed')
    } finally {
      saving.current = false
    }
  }, [workbook, loaded.record.id, rebaseOntoLatest, buildExtrasToSave])

  const dataVersion = workbook.dataVersion
  useEffect(() => {
    if (!workbook.dirty || stopped.current) return
    // A save that gave up (merge retries exhausted, or the server is down) does
    // not auto-retry until a new edit lifts dataVersion past where it gave up.
    if (save === 'failed' && workbook.dataVersion <= giveUp.current) return
    setSave((s) => (s === 'saving' ? s : 'unsaved'))
    const timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [dataVersion, workbook, saveNow, save])

  // ── Polling: others' changes arrive within a few seconds ──────────────────
  // While the tab is visible, ask the cheap revision route whether someone else
  // saved. With nothing of my own pending, adopt their workbook (selection,
  // sheet and any open draft kept); with pending work, rebase and save it.
  const saveNowRef = useRef(saveNow)
  saveNowRef.current = saveNow
  useEffect(() => {
    if (workbook.readOnly) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      if (!cancelled && !document.hidden && !stopped.current && !saving.current) {
        try {
          const res = await fetch(`/api/account/spreadsheets/${loaded.record.id}/revision`)
          const json = (await res.json().catch(() => ({}))) as { revision?: number; last_edited_by?: string | null; editor_name?: string | null }
          // A save of my own may have started, or landed, while the question was out.
          if (!cancelled && !saving.current && typeof json.revision === 'number' && json.revision > revision.current) {
            const who = json.last_edited_by && json.last_edited_by === loaded.memberId ? null : (json.editor_name ?? null)
            if (!workbook.dirty && !workbook.hasPending()) {
              const latest = await fetchRecord(loaded.record.id)
              const theirs = latest ? await openModel(latest.workbook, latest.title) : null
              if (latest && theirs && !cancelled && !saving.current && latest.revision > revision.current) {
                // Anything I did while their workbook was loading is replayed onto it,
                // and stays pending for the next save.
                const minePending = workbook.pendingActions()
                const theirExtras = readExtras(latest.extras)
                const result = rebaseWithLog({
                  theirs,
                  theirsExtras: theirExtras,
                  myBaseRevision: revision.current,
                  mySheets: workbook.sheets(),
                  pending: minePending,
                })
                if (result.status === 'stop') {
                  theirs.free()
                  enterGuard(who)
                  return
                }
                workbook.adopt(theirs, workbook.extrasDirty ? mergeExtras(workbook.baseExtras, workbook.extras, theirExtras) : theirExtras, theirExtras)
                workbook.replacePending(result.pending)
                revision.current = latest.revision
                setRecord((prev) => ({ ...prev, revision: latest.revision, last_edited_by: latest.last_edited_by }))
                if (!minePending.length && !workbook.extrasDirty && unsavedStructure.current.length === 0) {
                  workbook.markSaved(workbook.dataVersion, theirExtras)
                  setSave('saved')
                }
                const note = droppedNote(result.dropped)
                if (note) onMessage(note)
                void comments.reload()
                noteUpdatedBy(who)
              } else if (theirs) {
                theirs.free()
              }
            } else {
              await saveNowRef.current()
              void comments.reload()
              noteUpdatedBy(who)
            }
          }
        } catch {
          // A failed poll is harmless; the next one tries again.
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS)
    }
    const onVisible = () => {
      if (!document.hidden && !cancelled) void poll()
    }
    timer = setTimeout(() => void poll(), POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [workbook, loaded.record.id, loaded.memberId, comments, noteUpdatedBy, onMessage, enterGuard])

  // Comment anchors follow structural edits (and move back on undo); the same
  // edits are logged (the inverse too, on undo) so the saved structure log lets
  // another editor move their late cell edits onto my new layout.
  useEffect(
    () =>
      workbook.onStructural((change) => {
        comments.shiftAnchors(change)
        unsavedStructure.current.push(change)
      }),
    [workbook, comments],
  )

  // Open a comment thread on the active cell, or start a new one there.
  const commentHere = useCallback(() => {
    if (workbook.readOnly) return
    if (workbook.editing) workbook.commitEdit()
    const sel = workbook.selection()
    const sheetId = workbook.sheetIdAt()
    const existing = comments.threads.find((t) => {
      if (t.resolved_at || t.sheet_id !== sheetId || !t.anchor) return false
      const r = parseRange(t.anchor)
      return !!r && r.r1 === sel.row && r.c1 === sel.column
    })
    if (existing) {
      setComposingAnchor(null)
      setOpenThreadId(existing.id)
    } else {
      setOpenThreadId(null)
      setComposingAnchor(rangeName(sel.range))
    }
  }, [workbook, comments.threads])

  const goToThread = useCallback(
    (threadId: string, sheetId: number | null, anchor: string | null) => {
      const sheets = workbook.sheets()
      const idx = sheetId === null ? -1 : sheets.findIndex((s) => s.id === sheetId)
      if (idx >= 0 && idx !== workbook.sheet) workbook.selectSheet(idx)
      const r = anchor ? parseRange(anchor) : null
      if (r) workbook.selectRange(r, { row: r.r1, column: r.c1 })
      setComposingAnchor(null)
      setOpenThreadId(threadId)
    },
    [workbook],
  )

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
        const extras = workbook.extrasDirty || unsavedStructure.current.length > 0 ? buildExtrasToSave() : undefined
        void fetch(`/api/account/spreadsheets/${loaded.record.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base_revision: revision.current, workbook: snapshot.workbook, ...(extras ? { extras } : {}) }),
        }).catch(() => undefined)
      }
    }
  }, [workbook, loaded.record.id, buildExtrasToSave])

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
    dropdown: () => setDialog('dropdown'),
    convertToTable: () => {
      const result = workbook.convertToTable()
      if (!result.ok) onMessage(result.message)
      focusGrid()
    },
    tableOptions: (id) => setTablePanel(id),
    comment: commentHere,
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

  // This workbook as the shared entity layer knows it: its ⋯ menu (Copy link,
  // Make a task, Archive) is the one every kind's card shows, and Links toggles
  // the references panel. Open and Rename are left out (this IS the record,
  // open, and its title is renamed in place — PANEL_OMIT).
  const entityRef = { type: 'spreadsheet', id: loaded.record.id, label: record.title }
  const entityState = { archived: record.status === 'archived', status: record.status }
  const linksButton = (standalone?: boolean) => (
    <button
      type="button"
      aria-label="Links"
      aria-pressed={showLinks}
      title="Links"
      onClick={() => setShowLinks((on) => !on)}
      className={
        standalone
          ? cn('flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground', showLinks && 'bg-accent text-foreground')
          : cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground', showLinks && 'bg-foreground/[0.08] text-foreground')
      }
    >
      <Link2 className={standalone ? 'size-4' : 'size-3.5'} strokeWidth={1.75} aria-hidden />
    </button>
  )

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
        // Ctrl/Cmd+Alt+M: comment on the selected cell(s), or open the thread there.
        if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === 'm') {
          event.preventDefault()
          commentHere()
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
            <PeerFaces peers={peers} />
            <CommentsButton count={comments.openCount} open={showComments} onClick={() => setShowComments((on) => !on)} />
            {linksButton()}
            <button
              type="button"
              aria-label="Version history"
              aria-pressed={history}
              title="Version history"
              onClick={() => setHistory((on) => !on)}
              className={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground', history && 'bg-foreground/[0.08] text-foreground')}
            >
              <History className="size-3.5" strokeWidth={1.75} aria-hidden />
            </button>
            <EntityActionsMenu entity={entityRef} state={entityState} omit={PANEL_OMIT} className="mr-1 size-6 p-0 text-muted-foreground hover:text-foreground" />
            <span className="mr-2 flex items-center gap-2 empty:hidden">
              {updatedBy && <span className="text-xs text-muted-foreground">Updated by {updatedBy}</span>}
              <SaveNote state={workbook.readOnly ? 'saved' : save} readOnly={workbook.readOnly} onRetry={() => void saveNow()} guard={guard} onReload={onReload} />
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
          <PeerFaces peers={peers} />
          <CommentsButton count={comments.openCount} open={showComments} onClick={() => setShowComments((on) => !on)} standalone />
          {linksButton(true)}
          <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label="Version history" aria-pressed={history} title="Version history" onClick={() => setHistory((on) => !on)}>
            <History className="h-4 w-4" />
          </Button>
          <EntityActionsMenu entity={entityRef} state={entityState} omit={PANEL_OMIT} className="h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground" />
          {updatedBy && <span className="shrink-0 text-xs text-muted-foreground">Updated by {updatedBy}</span>}
          <SaveNote state={workbook.readOnly ? 'saved' : save} readOnly={workbook.readOnly} onRetry={() => void saveNow()} guard={guard} onReload={onReload} />
        </div>
      )}

      {guard && (
        <div role="alert" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-amber-500/10 px-3 py-1.5 text-xs text-foreground">
          <span className="min-w-0 flex-1">
            {guard.name ?? 'Someone'} added or removed rows or columns while you were editing. Your unsaved changes are still here: copy what you need, then load the latest.
          </span>
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-xs" onClick={onReload}>Load the latest</Button>
        </div>
      )}
      <Toolbar
        workbook={workbook}
        view={view}
        onView={setView}
        onFind={() => setFinding(true)}
        onComment={commentHere}
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
          renderOverlay={({ sheet, layout }) => (
            <>
              <PresenceOverlay peers={peers} sheetId={workbook.sheetIdAt(sheet)} layout={layout} />
              <CommentOverlay
                workbook={workbook}
                sheet={sheet}
                layout={layout}
                comments={comments}
                memberId={loaded.memberId}
                openThreadId={openThreadId}
                composingAnchor={composingAnchor}
                onOpenThread={(threadId) => {
                  setComposingAnchor(null)
                  setOpenThreadId(threadId)
                }}
                onCloseComposer={() => {
                  setComposingAnchor(null)
                  focusGrid()
                }}
              />
            </>
          )}
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
        {showComments && (
          <CommentsPanel
            workbook={workbook}
            comments={comments}
            onClose={() => {
              setShowComments(false)
              focusGrid()
            }}
            onGoTo={(thread) => goToThread(thread.id, thread.sheet_id, thread.anchor)}
          />
        )}
        {showLinks && (
          <LinksPanel
            spreadsheetId={loaded.record.id}
            onClose={() => {
              setShowLinks(false)
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

function CommentsButton({ count, open, onClick, standalone }: { count: number; open: boolean; onClick: () => void; standalone?: boolean }) {
  const label = count > 0 ? `Comments (${count} open)` : 'Comments'
  if (standalone) {
    return (
      <Button size="icon" variant="ghost" className="relative h-7 w-7 shrink-0" aria-label={label} aria-pressed={open} title={label} onClick={onClick}>
        <MessageSquare className="h-4 w-4" />
        {count > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium text-primary-foreground">{count}</span>}
      </Button>
    )
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={onClick}
      className={cn('relative mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground', open && 'bg-foreground/[0.08] text-foreground')}
    >
      <MessageSquare className="size-3.5" strokeWidth={1.75} aria-hidden />
      {count > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-medium text-primary-foreground">{count}</span>}
    </button>
  )
}

function SaveNote({ state, readOnly, onRetry, guard, onReload }: { state: SaveState; readOnly: boolean; onRetry: () => void; guard: { name: string | null } | null; onReload: () => void }) {
  // The full notice, with its button, is a banner over the grid: the header has no room for it.
  if (guard) return <span className="shrink-0 text-xs text-destructive">Not saved</span>
  if (readOnly) return <span className="shrink-0 text-xs text-muted-foreground">Archived: view only</span>
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
