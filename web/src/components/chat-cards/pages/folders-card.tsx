'use client'

/**
 * Folders as a card (Drive folders, migration 690; docs/plans/create-everything.md):
 * with no folder open, the top folders; with one open (`at.type === 'drive_folder'`),
 * its path, its subfolders and the docs, tables, spreadsheets and canvases
 * filed in it, newest first. New makes a folder or a record in the open
 * folder (the one Create composer, "Create in <folder>"); Add files a record
 * already made. A row's menu renames, moves or deletes a folder, or moves a
 * record or takes it out.
 *
 * Opening a folder, and the path back up, move the CARD the way a tab moves,
 * through usePagePlace: nothing navigates. A record opens as the app opens it;
 * a file (a Drive upload, migration 709) in the in-app viewer.
 *
 * Files dropped on a folder's row, or on the open folder, are uploaded to
 * Drive and filed there (docs/plans/drive-files.md, phase 2): every non-guest
 * member reads them then. M on a focused row moves it (Move to…).
 */
import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ChevronRight, File as FileIcon, FileText, Folder, FolderInput, FolderPlus, MoreHorizontal, Pencil, Plus, Shapes, Sheet, Table2, Trash2, X } from 'lucide-react'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { CardHeaderSlot } from '../card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
import { openCreateDialog } from '@/lib/create/open-create'
import type { CreateTypeId } from '@/lib/create/create-types'
import { openCard, openTarget } from '@/lib/chat-cards/open-card'
import {
  FOLDER_ITEM_LABEL,
  childFolders,
  folderAndDescendants,
  folderPath,
  type DriveFolder,
  type FolderItem,
  type FolderItemType,
} from '@/lib/drive/folders'
import { usePagePlace, type PageCardProps } from './page-card'
import { toast } from 'sonner'
import { openAttachmentById } from '@/components/files/global-file-viewer'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import { dragHasFiles, filesFromTransfer } from '@/lib/attachments/dropped-files'
import { cn } from '@/lib/utils'

const FROM = 'folders'

const ITEM_ICON: Record<FolderItemType, React.ComponentType<{ className?: string }>> = {
  document: FileText,
  data_table: Table2,
  spreadsheet: Sheet,
  canvas: Shapes,
  attachment: FileIcon,
}

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

export function FoldersPageCard(props: PageCardProps) {
  const place = usePagePlace(props)
  const openId = place.at?.type === 'drive_folder' ? place.at.id : null
  const { onCount } = props

  const [folders, setFolders] = React.useState<DriveFolder[] | null>(null)
  const [items, setItems] = React.useState<FolderItem[] | null>(null)
  const [missing, setMissing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [movingFor, setMovingFor] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [newOpen, setNewOpen] = React.useState(false)
  const [adding, setAdding] = React.useState(false)

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

  const go = (f: DriveFolder | null) => {
    setMenuFor(null)
    setMovingFor(null)
    setAdding(false)
    place.go(f ? { type: 'drive_folder', id: f.id, label: f.name } : null)
  }

  const createHere = (type: CreateTypeId) => {
    setNewOpen(false)
    openCreateDialog({ type, ...(current ? { context: { container: { kind: 'folder', id: current.id, name: current.name } } } : {}) })
  }

  const act = async (p: Promise<string | null>) => {
    setMenuFor(null)
    setMovingFor(null)
    const err = await p
    setError(err)
    void load()
  }

  const renameFolder = (f: DriveFolder, name: string) => {
    setRenaming(null)
    const next = name.trim()
    if (!next || next === f.name) return
    void act(send(`/api/account/folders/${f.id}`, 'PATCH', { name: next }))
  }

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <Folder className="h-8 w-8 opacity-50" />
        <p>This folder is gone, or isn’t one you can open.</p>
        <button type="button" onClick={() => go(null)} className="text-xs font-medium text-primary hover:underline">
          All folders
        </button>
      </div>
    )
  }

  const loading = folders === null || (openId !== null && items === null)
  const empty = !loading && subfolders.length === 0 && (items?.length ?? 0) === 0

  return (
    <FolderDropZone folder={current} onUploaded={() => void load()}>
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-folders-card="">
      <CardHeaderSlot side="right">
        <div className="relative flex items-center gap-1.5">
          {current && (
            <button type="button" onClick={() => setAdding((v) => !v)} data-folder-add="" className={CARD_HEADER_PILL_BUTTON}>
              <FolderInput className="size-3.5" strokeWidth={1.75} aria-hidden />
              Add
            </button>
          )}
          <button type="button" onClick={() => setNewOpen((v) => !v)} data-folder-new="" className={CARD_HEADER_PILL_BUTTON}>
            <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
            New
          </button>
          {newOpen && (
            <div className={`absolute right-0 top-9 z-20 flex w-40 flex-col py-1 ${FLOATING_CARD_CLASS}`} data-folder-new-menu="">
              {(current ? NEW_TYPES : NEW_TYPES.slice(0, 1)).map((t) => (
                <button
                  key={t.type}
                  type="button"
                  data-folder-new-type={t.type}
                  onClick={() => createHere(t.type)}
                  className="px-3 py-1.5 text-left text-xs text-foreground hover:bg-background"
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardHeaderSlot>

      {/* The path, inside a folder: Folders › Clients › Acme (the card's header names the page itself). */}
      {current && <nav className="flex min-w-0 flex-wrap items-center gap-1 text-sm" aria-label="Folder path" data-folder-path="">
        <button type="button" onClick={() => go(null)} className={current ? 'text-muted-foreground hover:text-foreground' : 'font-medium text-foreground'}>
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
      </nav>}

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {adding && current && (
        <AddPicker
          folderName={current.name}
          onPick={(r) => void act(send(`/api/account/folders/${current.id}/items`, 'POST', { type: r.type, id: r.id }))}
          onClose={() => setAdding(false)}
        />
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
          <Folder className="h-8 w-8 opacity-50" />
          <p>{current ? 'Nothing in this folder yet.' : 'No folders yet.'}</p>
          <button type="button" onClick={() => createHere(current ? 'document' : 'folder')} className="text-xs font-medium text-primary hover:underline">
            {current ? 'Make a doc here' : 'Make your first folder'}
          </button>
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto" data-folder-list="">
          {subfolders.map((f) => (
            <FolderRowDrop
              key={f.id}
              folder={f}
              onUploaded={() => void load()}
              data-folder-row={f.id}
              onKeyDown={(e) => {
                if (renaming !== f.id && (e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && (e.target as HTMLElement).tagName !== 'INPUT') {
                  e.preventDefault()
                  setMovingFor(`folder:${f.id}`)
                }
              }}
              className={`group flex items-center gap-2 px-3 py-2 ${FLOATING_CARD_CLASS}`}
            >
              {renaming === f.id ? (
                <input
                  autoFocus
                  defaultValue={f.name}
                  aria-label="Folder name"
                  onBlur={(e) => renameFolder(f, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') renameFolder(f, e.currentTarget.value)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
              ) : (
                <button type="button" onClick={() => go(f)} title={`Open ${f.name} (M to move; drop files here to add them)`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium text-foreground">{f.name}</span>
                </button>
              )}
              <RowMenu
                label="Folder actions"
                open={menuFor === f.id}
                onToggle={() => setMenuFor(menuFor === f.id ? null : f.id)}
              >
                <MenuButton icon={Pencil} onClick={() => { setMenuFor(null); setRenaming(f.id) }}>Rename</MenuButton>
                <MenuButton icon={FolderInput} onClick={() => setMovingFor(`folder:${f.id}`)}>Move to…</MenuButton>
                <MenuButton icon={Trash2} onClick={() => void act(send(`/api/account/folders/${f.id}`, 'DELETE'))}>Delete folder</MenuButton>
              </RowMenu>
              {movingFor === `folder:${f.id}` && folders && (
                <MovePicker
                  folders={folders.filter((o) => !folderAndDescendants(folders, f.id).has(o.id))}
                  allowTop={f.parent_id !== null}
                  onPick={(to) => void act(send(`/api/account/folders/${f.id}`, 'PATCH', { parent_id: to }))}
                  onClose={() => setMovingFor(null)}
                />
              )}
            </FolderRowDrop>
          ))}
          {(items ?? []).map((it) => {
            const Icon = ITEM_ICON[it.type]
            const key = `${it.type}:${it.id}`
            return (
              <li
                key={key}
                data-folder-item={key}
                onKeyDown={(e) => {
                  if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault()
                    setMovingFor(key)
                  }
                }}
                className={`group flex items-center gap-2 px-3 py-2 ${FLOATING_CARD_CLASS}`}
              >
                <button type="button" onClick={() => openFolderItem(it)} title={`Open ${it.title} (M to move)`} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm text-foreground">{it.title}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{FOLDER_ITEM_LABEL[it.type]}</span>
                </button>
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{updatedLabel(it.updated_at)}</span>
                <RowMenu label="Record actions" open={menuFor === key} onToggle={() => setMenuFor(menuFor === key ? null : key)}>
                  <MenuButton icon={FolderInput} onClick={() => setMovingFor(key)}>Move to…</MenuButton>
                  {current && (
                    <MenuButton icon={X} onClick={() => void act(send(`/api/account/folders/${current.id}/items`, 'DELETE', { type: it.type, id: it.id }))}>
                      Take out of folder
                    </MenuButton>
                  )}
                </RowMenu>
                {movingFor === key && folders && (
                  <MovePicker
                    folders={folders.filter((o) => o.id !== openId)}
                    allowTop={false}
                    onPick={(to) => to && void act(send(`/api/account/folders/${to}/items`, 'POST', { type: it.type, id: it.id }))}
                    onClose={() => setMovingFor(null)}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
    </FolderDropZone>
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

/** A subfolder's row: files dropped on it are uploaded and filed there. */
function FolderRowDrop({ folder, onUploaded, children, className, ...rest }: { folder: DriveFolder; onUploaded: () => void; children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLLIElement>) {
  const drop = useFolderDrop((files) => void uploadToFolder(files, folder).then((n) => n && onUploaded()))
  return (
    <li {...rest} {...drop.props} data-file-drop-zone="" className={cn(className, drop.over && 'ring-2 ring-foreground/30')}>
      {children}
    </li>
  )
}

function RowMenu({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={label}
        onClick={onToggle}
        className="rounded-md p-1 text-muted-foreground opacity-0 hover:bg-background focus:opacity-100 group-hover:opacity-100"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && <div className={`absolute right-0 top-8 z-10 flex w-44 flex-col py-1 ${FLOATING_CARD_CLASS}`}>{children}</div>}
    </div>
  )
}

function MenuButton({ icon: Icon, onClick, children }: { icon: React.ComponentType<{ className?: string }>; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-background">
      <Icon className="h-3.5 w-3.5" /> {children}
    </button>
  )
}

/** Where to move a folder or a record: any folder it may go in (by its path), or the top. */
function MovePicker({ folders, allowTop, onPick, onClose }: { folders: DriveFolder[]; allowTop: boolean; onPick: (to: string | null) => void; onClose: () => void }) {
  const all = folders
  const label = (f: DriveFolder) => folderPath(all, f.id).map((p) => p.name).join(' › ') || f.name
  const sorted = [...folders].sort((a, b) => label(a).localeCompare(label(b)))
  return (
    <div className={`absolute right-3 top-10 z-20 flex max-h-64 w-60 flex-col overflow-y-auto py-1 ${FLOATING_CARD_CLASS}`} data-folder-move="">
      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground">
        Move to
        <button type="button" aria-label="Close" onClick={onClose}>
          <X className="h-3 w-3" />
        </button>
      </div>
      {allowTop && (
        <button type="button" onClick={() => onPick(null)} className="px-3 py-1.5 text-left text-xs text-foreground hover:bg-background">
          The top (no folder)
        </button>
      )}
      {sorted.length === 0 && !allowTop && <p className="px-3 py-1.5 text-xs text-muted-foreground">No other folder.</p>}
      {sorted.map((f) => (
        <button key={f.id} type="button" onClick={() => onPick(f.id)} className="truncate px-3 py-1.5 text-left text-xs text-foreground hover:bg-background">
          {label(f)}
        </button>
      ))}
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
            const Icon = ITEM_ICON[r.type]
            return (
              <li key={`${r.type}:${r.id}`}>
                <button
                  type="button"
                  data-folder-candidate={`${r.type}:${r.id}`}
                  onClick={() => onPick({ type: r.type, id: r.id })}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-background"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
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

function updatedLabel(iso: string | null): string {
  const t = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(t)) return ''
  try {
    return formatDistanceToNow(new Date(t), { addSuffix: true })
  } catch {
    return ''
  }
}

export default function FoldersCard(props: PageCardProps) {
  return <FoldersPageCard {...props} />
}
