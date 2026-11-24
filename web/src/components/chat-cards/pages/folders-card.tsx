'use client'

/**
 * Folders as a card (Drive folders, migration 690; docs/plans/create-everything.md):
 * with no folder open, the top folders; with one open (`at.type === 'drive_folder'`),
 * its path, its subfolders and the docs, tables, spreadsheets, canvases and
 * files filed in it. The list is the views system's (docs/plans/views-everywhere.md):
 * the shared toolbar (saved views, Type / Name / Updated / Filed filters,
 * grouping, sort, properties), the shared list and rows (each kind's glyph),
 * search in the header, and J/K/Enter/O as in every list, M to move. The rows
 * are the view-only kind `drive_item`, read from the folder routes and
 * filtered here (lib/drive/folder-view.ts). New makes a folder or a record in
 * the open folder (the one Create composer, "Create in <folder>"); Add files a
 * record already made. A row's right-click renames, moves or deletes a folder,
 * or moves a record or takes it out.
 *
 * Opening a folder, and the path back up, move the CARD the way a tab moves,
 * through usePagePlace: nothing navigates. A record opens as the app opens it;
 * a file (a Drive upload, migration 709) in the in-app viewer.
 *
 * Files dropped on a folder's row, or on the open folder, are uploaded to
 * Drive and filed there (docs/plans/drive-files.md, phase 2): every non-guest
 * member reads them then.
 */
import * as React from 'react'
import { ChevronRight, FolderInput, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { CardHeaderSlot, useCardHeaderSlots } from '../card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
import { openCreateDialog } from '@/lib/create/open-create'
import type { CreateTypeId } from '@/lib/create/create-types'
import { openCard, openTarget } from '@/lib/chat-cards/open-card'
import {
  FOLDER_ITEM_LABEL,
  FOLDER_NAME_MAX,
  childFolders,
  folderAndDescendants,
  folderPath,
  type DriveFolder,
  type FolderItem,
  type FolderItemType,
} from '@/lib/drive/folders'
import { selectDriveRows, toDriveRows, type DriveItemRow } from '@/lib/drive/folder-view'
import { usePagePlace, type PageCardProps } from './page-card'
import { toast } from 'sonner'
import { openAttachmentById } from '@/components/files/global-file-viewer'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import { dragHasFiles, filesFromTransfer } from '@/lib/attachments/dropped-files'
import { cn } from '@/lib/utils'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import { EntityIcon } from '@/components/entities/entity-icon'
import { ViewToolbar } from '@/components/views/view-toolbar'
import { ViewList } from '@/components/views/view-list'
import { ExpandableSearch } from '@/components/views/expandable-search'
import { useView, useViewConfig, type CardConfigSource, type ViewConfig } from '@/components/views/hooks/use-view'
import { LIST_ROW_ATTR, ListFocusProvider, listOwnsKeys, scrollListRowIntoView, stepListFocus } from '@/components/views/list-keyboard'
import { RowMenuItemsProvider, type RowMenuItemsOf } from '@/components/views/list/row-menu-items'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const FROM = 'folders'

/** What New makes in a folder, in the Create menu's words. */
const NEW_TYPES: ReadonlyArray<{ type: CreateTypeId; label: string }> = [
  { type: 'folder', label: 'Folder' },
  { type: 'document', label: 'Doc' },
  { type: 'table', label: 'Table' },
  { type: 'spreadsheet', label: 'Spreadsheet' },
  { type: 'canvas', label: 'Canvas' },
]

/** Open a filed record as the app opens it. */
export function openFolderItem(item: Pick<FolderItem, 'type' | 'id' | 'title'>): void {
  switch (item.type) {
    case 'document':
      openTarget({ type: 'document', id: item.id, title: item.title }, { from: FROM })
      return
    case 'canvas':
      openTarget({ type: 'canvas', id: item.id, title: item.title }, { from: FROM })
      return
    case 'spreadsheet':
      openCard({ kind: 'spreadsheets', title: 'Spreadsheets', target: { type: 'spreadsheet', id: item.id, label: item.title } }, { from: FROM })
      return
    case 'data_table':
      openCard({ kind: 'tables', title: 'Tables', target: { type: 'data_table', id: item.id, label: item.title } }, { from: FROM })
      return
    case 'attachment':
      void openAttachmentById(item.id)
      return
  }
}

/** Upload files to Drive and file them in a folder: the folder's readers (every non-guest member) see them then. */
export async function uploadToFolder(files: File[], folder: Pick<DriveFolder, 'id' | 'name'>): Promise<number> {
  if (!files.length) return 0
  const { uploaded, firstError } = await uploadAttachments(files, { drive: { folderId: folder.id } })
  if (uploaded) toast.success(`${uploaded === 1 ? '1 file' : `${uploaded} files`} added to ${folder.name}`)
  if (firstError) toast.error(firstError)
  return uploaded
}

/** Drag-and-drop of files onto one element: highlighted while files are over it. */
function useFolderDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = React.useState(false)
  const depth = React.useRef(0)
  const props = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current++
      setOver(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setOver(false)
      onFiles(filesFromTransfer(e.dataTransfer))
    },
  }
  return { over, props }
}

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (res.ok) return null
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    return data.error || 'That didn’t work.'
  } catch {
    return 'That didn’t work.'
  }
}

/** The card keeps its list's changes here, as every page card's list (page-card.tsx). */
const LIST_KEY = 'drive_item'

export function FoldersPageCard(props: PageCardProps) {
  const { toolCallId, store, onCount } = props
  const place = usePagePlace(props)
  const openId = place.at?.type === 'drive_folder' ? place.at.id : null
  const inCard = useCardHeaderSlots() !== null

  const [folders, setFolders] = React.useState<DriveFolder[] | null>(null)
  const [items, setItems] = React.useState<FolderItem[] | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [moving, setMoving] = React.useState<DriveItemRow | null>(null)
  const [renaming, setRenaming] = React.useState<DriveFolder | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/account/folders')
      const json = (await res.json().catch(() => null)) as { folders?: DriveFolder[]; error?: string } | null
      setFolders(res.ok ? (json?.folders ?? []) : [])
      if (!res.ok) setError('Folders couldn’t be loaded. Try again in a moment.')
    } catch {
      setFolders([])
      setError('Folders couldn’t be loaded. Try again in a moment.')
    }
    if (!openId) {
      setItems(null)
      setMissing(false)
      return
    }
    try {
      const res = await fetch(`/api/account/folders/${openId}`)
      if (res.status === 404) {
        setMissing(true)
        setItems([])
        return
      }
      const json = (res.ok ? await res.json() : null) as { items?: FolderItem[] } | null
      setMissing(false)
      setItems(json?.items ?? [])
    } catch {
      setItems([])
    }
  }, [openId])

  React.useEffect(() => {
    void load()
  }, [load])

  // What the composer makes (in this folder or anywhere) shows here at once.
  React.useEffect(() => {
    const onCreated = () => void load()
    window.addEventListener('ni:entity-created', onCreated)
    return () => window.removeEventListener('ni:entity-created', onCreated)
  }, [load])

  const subfolders = React.useMemo(() => (folders ? childFolders(folders, openId) : []), [folders, openId])
  const path = React.useMemo(() => (folders && openId ? folderPath(folders, openId) : []), [folders, openId])
  const current = path[path.length - 1] ?? null

  React.useEffect(() => {
    if (folders === null || (openId && items === null)) return
    onCount?.(subfolders.length + (items?.length ?? 0))
  }, [folders, items, openId, subfolders.length, onCount])

  // The view (saved views, filters, grouping, sort, properties): the shared
  // ones. Picking a saved view stays with the card (standalone); the changes
  // made on top of it are the card's own.
  const { views, activeViewId, activeView, setActiveViewId, createView, updateView, duplicateView, deleteView } = useView('drive_item', undefined, undefined, { standalone: true })
  const cardSource = React.useMemo<CardConfigSource>(
    () => ({
      baseline: {},
      overrides: store.state(toolCallId).lists?.[LIST_KEY] as Partial<ViewConfig> | undefined,
      onOverridesChange: (overrides) => {
        const lists = { ...(store.state(toolCallId).lists ?? {}), [LIST_KEY]: overrides as Record<string, unknown> }
        store.update(toolCallId, { lists }, { touch: true })
      },
    }),
    // Read once, at mount (CardConfigSource).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolCallId],
  )
  const { config, updateConfig, resetConfig, isDirty, overrides, saveOverrides, discardOverrides } = useViewConfig(activeView, 'drive_item', updateView, false, undefined, 'workspace', cardSource, 'memory')

  const rows = React.useMemo(() => toDriveRows(subfolders, items ?? []), [subfolders, items])
  const { data, flat } = React.useMemo(() => selectDriveRows(rows, config, search), [rows, config, search])

  const go = React.useCallback(
    (f: DriveFolder | null) => {
      setMoving(null)
      setAdding(false)
      setSearch('')
      place.go(f ? { type: 'drive_folder', id: f.id, label: f.name } : null)
    },
    [place],
  )

  const createHere = (type: CreateTypeId) => {
    openCreateDialog({ type, ...(current ? { context: { container: { kind: 'folder', id: current.id, name: current.name } } } : {}) })
  }

  const act = React.useCallback(
    async (p: Promise<string | null>) => {
      setMoving(null)
      const err = await p
      setError(err)
      void load()
    },
    [load],
  )

  const openRow = React.useCallback(
    (row: DriveItemRow) => {
      if (row.folder) go(row.folder)
      else if (row.item) openFolderItem(row.item)
    },
    [go],
  )

  // ── The row's right-click: the page's verbs (row-menu-items.tsx). ──
  const menuItemsOf = React.useCallback<RowMenuItemsOf>(
    (item) => {
      const row = item as DriveItemRow
      if (row.folder) {
        const f = row.folder
        return [
          { key: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setRenaming(f) },
          { key: 'move', label: 'Move to…', icon: FolderInput, shortcut: 'M', onSelect: () => setMoving(row) },
          { key: 'delete', label: 'Delete folder', icon: Trash2, destructive: true, onSelect: () => void act(send(`/api/account/folders/${f.id}`, 'DELETE')) },
        ]
      }
      return [
        { key: 'move', label: 'Move to…', icon: FolderInput, shortcut: 'M', onSelect: () => setMoving(row) },
        ...(current && row.item
          ? [{ key: 'take_out', label: 'Take out of folder', icon: X, onSelect: () => void act(send(`/api/account/folders/${current.id}/items`, 'DELETE', { type: row.item!.type, id: row.item!.id })) }]
          : []),
      ]
    },
    [act, current],
  )

  // ── The keyboard, as in every list (list-keyboard.tsx): J/K and the arrows move, Enter or O opens, M moves. ──
  const listRootRef = React.useRef<HTMLDivElement>(null)
  const ids = React.useMemo(() => flat.map((r) => r.id), [flat])
  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  const liveFocusedId = focusedId && ids.includes(focusedId) ? focusedId : null
  const keysOn = !moving && !renaming && !adding
  const ownsKeys = React.useCallback((e: KeyboardEvent) => listOwnsKeys(listRootRef.current, e), [])
  const moveFocus = React.useCallback(
    (step: number) => {
      const next = stepListFocus(ids, liveFocusedId, step)
      if (!next) return
      setFocusedId(next)
      requestAnimationFrame(() => scrollListRowIntoView(listRootRef.current, next))
    },
    [ids, liveFocusedId],
  )
  const focusedRow = flat.find((r) => r.id === liveFocusedId) ?? null
  const listKeys = React.useMemo<HotkeyDefinition[]>(() => {
    const base = { globalGuard: true, when: ownsKeys, disabled: !keysOn }
    const onRow = { ...base, disabled: !keysOn || !focusedRow }
    return [
      { ...base, key: 'j', handler: () => moveFocus(1) },
      { ...base, key: 'ArrowDown', handler: () => moveFocus(1) },
      { ...base, key: 'k', handler: () => moveFocus(-1) },
      { ...base, key: 'ArrowUp', handler: () => moveFocus(-1) },
      { ...onRow, key: 'Enter', handler: () => focusedRow && openRow(focusedRow) },
      { ...onRow, key: 'o', handler: () => focusedRow && openRow(focusedRow) },
      { ...onRow, key: 'm', handler: () => focusedRow && setMoving(focusedRow) },
    ]
  }, [ownsKeys, keysOn, moveFocus, focusedRow, openRow])
  useHotkeys(listKeys)

  const onItemSelect = React.useCallback(
    (id: string) => {
      setFocusedId(id)
      const row = flat.find((r) => r.id === id)
      if (row) openRow(row)
    },
    [flat, openRow],
  )

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <EntityIcon kind="drive_folder" size="lg" muted />
        <p>This folder is gone, or isn’t one you can open.</p>
        <button type="button" onClick={() => go(null)} className="text-xs font-medium text-primary hover:underline">
          All folders
        </button>
      </div>
    )
  }

  const loading = folders === null || (openId !== null && items === null)
  const empty = !loading && rows.length === 0
  const searchBox = <ExpandableSearch value={search} onChange={setSearch} label="Search this folder" placeholder={current ? `Search ${current.name}…` : 'Search folders…'} />

  return (
    <FolderDropZone folder={current} onUploaded={() => void load()}>
      {inCard && (
        <CardHeaderSlot side="right">
          <div className="flex items-center gap-1.5">
            {searchBox}
            {current && (
              <button type="button" onClick={() => setAdding((v) => !v)} data-folder-add="" className={CARD_HEADER_PILL_BUTTON}>
                <FolderInput className="size-3.5" strokeWidth={1.75} aria-hidden />
                Add
              </button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" data-folder-new="" className={CARD_HEADER_PILL_BUTTON}>
                  <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
                  New
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40" data-folder-new-menu="">
                {(current ? NEW_TYPES : NEW_TYPES.slice(0, 1)).map((t) => (
                  <DropdownMenuItem key={t.type} data-folder-new-type={t.type} onSelect={() => createHere(t.type)}>
                    <EntityIcon kind={t.type === 'folder' ? 'drive_folder' : t.type} size="sm" className="mr-2" />
                    {t.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeaderSlot>
      )}
      <div ref={listRootRef} data-list-keyboard-root="" data-folders-card="" className="relative isolate flex h-full min-h-0 flex-col">
        {/* The path, inside a folder: Folders › Clients › Acme (the card's header names the page itself). */}
        {current && (
          <nav className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 px-[18px] pt-2 text-sm" aria-label="Folder path" data-folder-path="">
            <button type="button" onClick={() => go(null)} className="text-muted-foreground hover:text-foreground">
              Folders
            </button>
            {path.map((f, i) => (
              <React.Fragment key={f.id}>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => go(f)}
                  className={i === path.length - 1 ? 'truncate font-medium text-foreground' : 'truncate text-muted-foreground hover:text-foreground'}
                >
                  {f.name}
                </button>
              </React.Fragment>
            ))}
          </nav>
        )}
        <ViewToolbar
          embedded
          alignToContent
          layoutInHeader={inCard}
          entityType="drive_item"
          views={views}
          activeViewId={activeViewId}
          onViewChange={setActiveViewId}
          onCreateView={createView}
          onUpdateView={updateView}
          onDuplicateView={duplicateView}
          onDeleteView={deleteView}
          config={config}
          onConfigChange={updateConfig}
          onScopeReset={resetConfig}
          isDirty={isDirty}
          overrides={overrides}
          onSaveDraft={saveOverrides}
          onDiscardDraft={discardOverrides}
          actions={!inCard ? searchBox : undefined}
        />
        {error && (
          <div className="mx-[18px] mb-2 flex items-center justify-between gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive" data-folder-error="">
            <span>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {adding && current && (
          <div className="px-[18px] pb-2">
            <AddPicker
              folderName={current.name}
              onPick={(r) => void act(send(`/api/account/folders/${current.id}/items`, 'POST', { type: r.type, id: r.id }))}
              onClose={() => setAdding(false)}
            />
          </div>
        )}
        <div data-view-body="" className="relative min-h-0 flex-1 overflow-hidden">
          {empty && !search ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground" data-folder-empty="">
              <EntityIcon kind="drive_folder" size="lg" muted />
              <p>{current ? 'Nothing in this folder yet.' : 'No folders yet.'}</p>
              <button type="button" onClick={() => createHere(current ? 'document' : 'folder')} className="text-xs font-medium text-primary hover:underline">
                {current ? 'Make a doc here' : 'Make your first folder'}
              </button>
            </div>
          ) : (
            <RowMenuItemsProvider value={menuItemsOf}>
              <ListFocusProvider value={liveFocusedId}>
                <RowDrops onUploaded={() => void load()} rows={flat}>
                  <ViewList entityType="drive_item" data={data} loading={loading} config={config} selectedItemId={null} onItemSelect={onItemSelect} />
                </RowDrops>
              </ListFocusProvider>
            </RowMenuItemsProvider>
          )}
        </div>
      </div>
      {moving && folders && (
        <MoveDialog
          row={moving}
          folders={
            moving.folder
              ? folders.filter((o) => !folderAndDescendants(folders, moving.folder!.id).has(o.id))
              : folders.filter((o) => o.id !== openId)
          }
          allowTop={!!moving.folder && moving.folder.parent_id !== null}
          onPick={(to) => {
            if (moving.folder) void act(send(`/api/account/folders/${moving.folder.id}`, 'PATCH', { parent_id: to }))
            else if (to && moving.item) void act(send(`/api/account/folders/${to}/items`, 'POST', { type: moving.item.type, id: moving.item.id }))
          }}
          onClose={() => setMoving(null)}
        />
      )}
      {renaming && (
        <RenameDialog
          folder={renaming}
          onRename={(name) => {
            const f = renaming
            setRenaming(null)
            const next = name.trim()
            if (next && next !== f.name) void act(send(`/api/account/folders/${f.id}`, 'PATCH', { name: next }))
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </FolderDropZone>
  )
}

/**
 * Files dropped on a subfolder's row are uploaded and filed there; the rows
 * are the shared list's, so the drop is read off the row under the pointer
 * (its LIST_ROW_ATTR id). Anywhere else, the open folder takes them (FolderDropZone).
 */
function RowDrops({ rows, onUploaded, children }: { rows: readonly DriveItemRow[]; onUploaded: () => void; children: React.ReactNode }) {
  const [over, setOver] = React.useState<string | null>(null)
  const folderAt = (e: React.DragEvent): DriveFolder | null => {
    const id = (e.target as HTMLElement | null)?.closest?.(`[${LIST_ROW_ATTR}]`)?.getAttribute(LIST_ROW_ATTR) ?? null
    return rows.find((r) => r.id === id)?.folder ?? null
  }
  return (
    <div
      className="h-full"
      data-folder-row-drops=""
      onDragOver={(e) => {
        if (!dragHasFiles(e.dataTransfer)) return
        const f = folderAt(e)
        setOver(f?.id ?? null)
        if (!f) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => {
        setOver(null)
        if (!dragHasFiles(e.dataTransfer)) return
        const f = folderAt(e)
        if (!f) return
        e.preventDefault()
        e.stopPropagation()
        void uploadToFolder(filesFromTransfer(e.dataTransfer), f).then((n) => n && onUploaded())
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-lg bg-background/90 px-3 py-2 text-center text-xs text-foreground shadow" data-folder-drop-hint="">
          Drop to add to {rows.find((r) => r.folder?.id === over)?.title}. Everyone in the workspace will see it.
        </div>
      )}
    </div>
  )
}

/** Move to…: any folder it may go in (by its path), or the top. */
function MoveDialog({ row, folders, allowTop, onPick, onClose }: { row: DriveItemRow; folders: DriveFolder[]; allowTop: boolean; onPick: (to: string | null) => void; onClose: () => void }) {
  const label = (f: DriveFolder) => folderPath(folders, f.id).map((p) => p.name).join(' › ') || f.name
  const sorted = [...folders].sort((a, b) => label(a).localeCompare(label(b)))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" data-folder-move="">
        <DialogHeader>
          <DialogTitle>Move {row.title}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {allowTop && (
            <button type="button" onClick={() => onPick(null)} className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
              The top (no folder)
            </button>
          )}
          {sorted.length === 0 && !allowTop && <p className="px-2 py-1.5 text-sm text-muted-foreground">No other folder.</p>}
          {sorted.map((f) => (
            <button key={f.id} type="button" data-folder-move-to={f.id} onClick={() => onPick(f.id)} className="flex items-center gap-2 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-muted">
              <EntityIcon kind="drive_folder" size="sm" />
              <span className="truncate">{label(f)}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RenameDialog({ folder, onRename, onClose }: { folder: DriveFolder; onRename: (name: string) => void; onClose: () => void }) {
  const [name, setName] = React.useState(folder.name)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm" data-folder-rename="">
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onRename(name)
          }}
          className="flex flex-col gap-3"
        >
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={FOLDER_NAME_MAX} aria-label="Folder name" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!name.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The open folder takes files dropped anywhere on it (a subfolder's row takes its own). */
function FolderDropZone({ folder, onUploaded, children }: { folder: DriveFolder | null; onUploaded: () => void; children: React.ReactNode }) {
  const drop = useFolderDrop((files) => {
    if (folder) void uploadToFolder(files, folder).then((n) => n && onUploaded())
  })
  if (!folder) return <>{children}</>
  return (
    <div {...drop.props} data-folder-drop={folder.id} data-file-drop-zone="" className={cn('relative h-full min-h-0', drop.over && 'rounded-xl ring-2 ring-foreground/20')}>
      {children}
      {drop.over && (
        <div className="pointer-events-none absolute inset-x-4 bottom-4 rounded-lg bg-background/90 px-3 py-2 text-center text-xs text-foreground shadow" data-folder-drop-hint="">
          Drop to add to {folder.name}. Everyone in the workspace will see it.
        </div>
      )}
    </div>
  )
}

/** Add: the records the person can open that sit in no folder, searchable. */
function AddPicker({ folderName, onPick, onClose }: { folderName: string; onPick: (r: { type: FolderItemType; id: string }) => void; onClose: () => void }) {
  const [q, setQ] = React.useState('')
  const [records, setRecords] = React.useState<Array<Omit<FolderItem, 'filed_at'>> | null>(null)
  React.useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/account/folders/candidates?q=${encodeURIComponent(q)}`)
        const json = (res.ok ? await res.json() : null) as { records?: Array<Omit<FolderItem, 'filed_at'>> } | null
        if (live) setRecords(json?.records ?? [])
      } catch {
        if (live) setRecords([])
      }
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])
  return (
    <div className={`flex max-h-72 flex-col gap-1 p-2 ${FLOATING_CARD_CLASS}`} data-folder-add-picker="">
      <div className="flex items-center gap-2">
        <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Add to ${folderName}: search docs, tables, sheets, canvases…`}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
        />
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <ul className="flex min-h-0 flex-col overflow-y-auto">
        {records === null ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</li>
        ) : records.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Nothing unfiled matches.</li>
        ) : (
          records.map((r) => {
            return (
              <li key={`${r.type}:${r.id}`}>
                <button
                  type="button"
                  data-folder-candidate={`${r.type}:${r.id}`}
                  onClick={() => onPick({ type: r.type, id: r.id })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-background"
                >
                  <EntityIcon kind={r.type} size="sm" />
                  <span className="truncate">{r.title}</span>
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{FOLDER_ITEM_LABEL[r.type]}</span>
                </button>
              </li>
            )
          })
        )}
      </ul>
    </div>
  )
}

export default function FoldersCard(props: PageCardProps) {
  return <FoldersPageCard {...props} />
}
