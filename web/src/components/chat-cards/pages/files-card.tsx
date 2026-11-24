'use client'

/**
 * Drive's files as a card (Liam, 11-11: "a new page that shows all available
 * files that were uploaded anywhere in the app"; owner, 11-23: the
 * reference product's Drive, docs/plans/drive-files.md, phase 2): every file
 * the person may see, from where it lives, each read through its own rule
 * (drive-files-data.ts).
 *
 *   Tabs      All; My files (uploaded or sent by them); Recent (what they
 *             opened last); Shared with me (others' files they can read).
 *   Sources   Uploads (to records, and to Drive itself) and Team chat, on by
 *             default; Email attachments, its own filter, off by default:
 *             read live from their own mailboxes, never kept.
 *   The list  the views system's (docs/plans/views-everywhere.md), through
 *             LocalViewList: the shared toolbar's filters (type, who made
 *             it, modified / added / opened, name), its display settings
 *             (grouping, sort, properties), search in the header (run on
 *             the server, as before), the shared rows (the file's glyph,
 *             where it lives, who made it, its size, a time) and J/K/Enter.
 *             No saved views yet: the view enum has no `file`.
 *   A row     opens the in-app viewer (components/files); its right-click
 *             opens the record an upload lives on, over the page, inside
 *             the card, or moves one's own Drive upload (M too).
 *   Upload    drop files on the card (or Upload): a Drive upload, the
 *             uploader's alone until they file it in a folder (709).
 *   M         on a focused row of their own Drive upload: move it to a
 *             folder, or take it out of one.
 */
import * as React from 'react'
import { ChevronDown, ExternalLink, Eye, File as FileIcon, FileCode, FileImage, FileSpreadsheet, FileText, Film, FolderInput, Music, Paperclip, Presentation, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { LocalViewList } from '@/components/views/local-view-list'
import type { RowMenuItemsOf } from '@/components/views/list/row-menu-items'
import type { SortConfig } from '@/lib/views/types'
import { useFileViewer } from '@/components/files/file-viewer'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { formatFileSize, type WorkspaceFile } from '@/lib/attachments/workspace-files-model'
import { uploadAttachments } from '@/lib/attachments/upload-client'
import { useElementFileDrop } from '@/lib/attachments/use-element-file-drop'
import { ATTACHMENT_ACCEPT_ATTR } from '@/lib/attachments/constants'
import {
  DRIVE_SORT_LABELS,
  DRIVE_SORTS,
  DRIVE_SOURCE_LABELS,
  DRIVE_TYPE_LABELS,
  DRIVE_TYPES,
  driveItemTime,
  sortDriveItems,
  PARENT_NOUN,
  type DriveItem,
  type DriveSort,
  type DriveType,
} from '@/lib/drive/drive-items'
import { folderPath, type DriveFolder } from '@/lib/drive/folders'
import { emailViewerFile, teamChatFileLink, teamChatViewerFile, uploadFileLink, uploadViewerFile } from '@/lib/files/sources'
import { cn } from '@/lib/utils'
import { CardCovered } from '../card-covered'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
import { PAGE_TAB_INSET, pageTabClass } from '@/components/views/page-tabs'
import { CardHeaderSlot, useCardHeaderSlots } from '../card-header-slot'
import { RecordOverlay, usePageRecords } from './record-overlay'
import type { PageCardProps } from './page-card'
import { recordDriveOpen, useDriveFiles, useDriveMembers, useMailFiles, useRecentFiles, type DriveMember, type DriveTab } from './drive-files-data'

const SHEETS = new Set(['xls', 'xlsx', 'csv'])
const TEXTS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'ppt', 'pptx'])

/** A file's icon: an image's, else a document's by its kind (a sheet, code, text). */
export function fileIconOf(file: Pick<WorkspaceFile, 'file_category' | 'file_extension'>): typeof FileIcon {
  if (file.file_category === 'image') return FileImage
  const ext = (file.file_extension ?? '').toLowerCase()
  if (SHEETS.has(ext)) return FileSpreadsheet
  if (TEXTS.has(ext)) return FileText
  return ext ? FileCode : FileIcon
}

const TYPE_ICON: Record<DriveType, typeof FileIcon> = {
  pdf: FileText,
  document: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  image: FileImage,
  video: Film,
  audio: Music,
  other: FileIcon,
}

const TABS: ReadonlyArray<{ id: DriveTab; label: string }> = [
  { id: 'all', label: 'All files' },
  { id: 'mine', label: 'My files' },
  { id: 'recent', label: 'Recent' },
  { id: 'shared', label: 'Shared with me' },
]

function shortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The page's controls' state. */
interface DriveView {
  tab: DriveTab
  uploads: boolean
  chat: boolean
  email: boolean
}

const DEFAULT_VIEW: DriveView = { tab: 'all', uploads: true, chat: true, email: false }

/** A file as the shared list reads it (the view-only kind `file`). */
type FileRowData = { [key: string]: unknown; id: string; title: string; item: DriveItem }
const FILE_DATE_FIELDS: ReadonlySet<string> = new Set(['updated_at', 'created_at', 'opened_at'])
const FILE_SEARCH_FIELDS = ['title'] as const
/** Recent opens on the last opened; mail's attachments on the newest arrived (they never change). */
const OPENED_FIRST: readonly SortConfig[] = [{ field: 'opened_at', direction: 'desc' }]
const ADDED_FIRST: readonly SortConfig[] = [{ field: 'created_at', direction: 'desc' }]
const FILE_GROUP_LABELS = { file_type: DRIVE_TYPE_LABELS as Readonly<Record<string, string>> }

/** A Drive item as a row: its kind, who made it (a member, else the sender's words), where it lives, its times. */
export function fileRowOf(item: DriveItem, members: readonly DriveMember[]): FileRowData {
  const creator = creatorOf(item, members)
  return {
    id: item.key,
    title: item.name,
    file_type: item.type,
    source: item.source,
    created_by: creator?.id ?? null,
    ...(creator ? { creator: { id: creator.id, display_name: creator.display_name } } : item.creator.label ? { created_by_name: item.creator.label } : {}),
    file_where: item.where,
    file_size: item.size,
    updated_at: item.modifiedAt,
    created_at: item.createdAt,
    opened_at: item.openedAt ?? null,
    item,
  }
}

/** Who made an item, as a member (uploads carry a user, chat files a member). */
function creatorOf(item: DriveItem, members: readonly DriveMember[]): DriveMember | null {
  if (item.creator.memberId) return members.find((m) => m.id === item.creator.memberId) ?? null
  if (item.creator.userId) return members.find((m) => m.user_id === item.creator.userId) ?? null
  return null
}

/** A source toggle: on its own it turns the other source back on, so one is always shown. */
export function toggleSource(v: DriveView, source: 'uploads' | 'chat'): DriveView {
  if (v.email) return { ...v, email: false, uploads: source === 'uploads', chat: source === 'chat' }
  const other = source === 'uploads' ? 'chat' : 'uploads'
  const next = { ...v, [source]: !v[source] }
  if (!next.uploads && !next.chat) next[other] = true
  return next
}

export default function FilesCard(props: PageCardProps) {
  const { toolCallId, store, onCount } = props
  const records = usePageRecords(toolCallId, store)
  const inCard = useCardHeaderSlots() !== null
  const [view, setView] = React.useState<DriveView>(DEFAULT_VIEW)
  const [typed, setTyped] = React.useState('')
  const [q, setQ] = React.useState('')
  const [reload, setReload] = React.useState(0)
  React.useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const members = useDriveMembers()

  const files = useDriveFiles({ tab: view.tab === 'recent' ? 'all' : view.tab, uploads: view.uploads, chat: view.chat, q, enabled: !view.email && view.tab !== 'recent', reload })
  const recent = useRecentFiles(reload)
  const mail = useMailFiles(q, view.email)

  // What shows: the source's items, opened times added, filtered and sorted.
  const shown = React.useMemo(() => {
    const base = view.email ? mail.items : view.tab === 'recent' ? recent.items : files.items
    const needle = q.toLowerCase()
    const list = base
      .filter((i) => (i.source === 'upload' ? view.uploads : i.source === 'team_chat' ? view.chat : view.email))
      .filter((i) => view.tab !== 'recent' || !needle || i.name.toLowerCase().includes(needle))
      .map((i) => ({ ...i, openedAt: recent.opened.get(i.key) ?? i.openedAt ?? null }))
    // In the sources' own order; the view's sort and filters are the shared list's.
    return sortDriveItems(list, view.tab === 'recent' ? 'opened' : 'modified').map((i) => fileRowOf(i, members))
  }, [view, q, files.items, recent.items, recent.opened, mail.items, members])

  const loading = view.email ? mail.loading : view.tab === 'recent' ? recent.loading : files.loading
  const error = view.email ? mail.error : view.tab === 'recent' ? recent.error : files.error
  const more = view.email ? mail.more : view.tab === 'recent' ? false : files.more
  const loadMore = view.email ? mail.loadMore : files.loadMore

  React.useEffect(() => {
    onCount?.(loading || more ? null : shown.length)
  }, [onCount, loading, more, shown.length])

  // Open a file in the viewer, as its own place reads it.
  const viewer = useFileViewer()
  const openViewer = viewer.open
  const openItem = React.useCallback(
    async (item: DriveItem) => {
      try {
        if (item.upload?.storage_path) {
          const url = await uploadFileLink(item.upload.storage_path)
          if (!url) throw new Error('Could not open the file')
          openViewer(uploadViewerFile({ ...item.upload, storage_path: item.upload.storage_path }, url, item.where))
        } else if (item.chat) {
          const url = await teamChatFileLink(item.chat.key)
          if (!url) throw new Error('Could not open the file')
          openViewer(teamChatViewerFile({ path: item.chat.key, name: item.chat.name, size: item.chat.size, type: item.chat.mimeType }, url, item.where, item.chat.messageId))
        } else if (item.mail) {
          openViewer(emailViewerFile({ name: item.mail.name, size: item.mail.size, mimeType: item.mail.mimeType }, item.mail.href, item.where))
        } else return
        recordDriveOpen(item)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not open the file')
      }
    },
    [openViewer],
  )

  // Upload: dropped on the card, or picked. A Drive upload, the uploader's until it is filed.
  const [dropEl, setDropEl] = React.useState<HTMLDivElement | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const upload = React.useCallback(async (picked: File[]) => {
    if (!picked.length) return
    setUploading(true)
    const { uploaded, firstError } = await uploadAttachments(picked, { drive: {} })
    setUploading(false)
    if (uploaded) toast.success(`${uploaded === 1 ? 'Uploaded to Drive' : `${uploaded} files uploaded to Drive`}. Only you see ${uploaded === 1 ? 'it' : 'them'} until you put ${uploaded === 1 ? 'it' : 'them'} in a folder.`)
    if (firstError) toast.error(firstError)
    setReload((n) => n + 1)
  }, [])
  useElementFileDrop(dropEl, (f) => void upload(f), setDragging, { paste: false })
  const picker = React.useRef<HTMLInputElement>(null)

  // M: move one's own Drive upload to a folder.
  const [moving, setMoving] = React.useState<DriveItem | null>(null)

  const filtered = !!q || !view.uploads || !view.chat

  // Which files: All files (the start), My files, Recent, Shared with me. A dropdown beside the others, not a
  // row of its own (Liam, 11-23: "can't this also be a dropdown and we show all by default").
  const chooseTab = (tab: DriveTab) => setView((v) => ({ ...v, tab }))

  // A row's right-click: open it, open the record it lives on, or move one's own Drive upload (M too).
  const openParent = React.useCallback(
    (item: DriveItem) => {
      const p = item.upload?.parent
      if (p && p.type !== 'row' && p.type !== 'drive') records.open({ type: p.type, id: p.id, label: p.label })
    },
    [records],
  )
  const menuItemsOf = React.useCallback<RowMenuItemsOf>(
    (row) => {
      const item = (row as FileRowData).item
      const p = item.upload?.parent
      return [
        { key: 'open', label: 'Open', icon: Eye, onSelect: () => void openItem(item) },
        ...(p && p.type !== 'row' && p.type !== 'drive' ? [{ key: 'open_parent', label: `Open ${PARENT_NOUN[p.type].toLowerCase()}`, icon: ExternalLink, onSelect: () => openParent(item) }] : []),
        ...(p?.type === 'drive' ? [{ key: 'move', label: 'Move to a folder…', icon: FolderInput, shortcut: 'M', onSelect: () => setMoving(item) }] : []),
      ]
    },
    [openItem, openParent],
  )
  const rowKeys = React.useMemo(
    () => [{ key: 'm', on: (row: FileRowData) => row.item.upload?.parent.type === 'drive', run: (row: FileRowData) => setMoving(row.item) }],
    [],
  )

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
        <input
          ref={picker}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT_ATTR}
          className="hidden"
          data-drive-upload-input=""
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? [])
            e.target.value = ''
            void upload(picked)
          }}
        />
        <div ref={setDropEl} data-file-drop-zone="" className="relative flex h-full min-h-0 flex-col">
          {dragging && (
            <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/30 bg-background/80 text-sm text-foreground" data-drive-drop-hint="">
              Drop to upload to Drive. Only you see it until you put it in a folder.
            </div>
          )}
          {/* The page's first row, from the card's corner as the projects page's tabs (components/views/page-tabs.tsx):
              the sources, then the choices. */}
          <div className={cn('flex shrink-0 flex-col gap-2 pb-2 pt-2.5', PAGE_TAB_INSET)}>
            <div className="flex flex-wrap items-center gap-1">
              <SourceToggle label={DRIVE_SOURCE_LABELS.upload} on={!view.email && view.uploads} id="upload" onClick={() => setView((v) => toggleSource(v, 'uploads'))} />
              <SourceToggle label={DRIVE_SOURCE_LABELS.team_chat} on={!view.email && view.chat} id="team_chat" onClick={() => setView((v) => toggleSource(v, 'chat'))} />
              <SourceToggle
                label={DRIVE_SOURCE_LABELS.email}
                on={view.email}
                id="email"
                onClick={() =>
                  setView((v) => (v.email ? { ...v, email: false } : { ...v, email: true, tab: 'all' }))
                }
              />
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              {/* Not for mail's attachments: those are the mailbox's, not anyone's in Drive. */}
              {!view.email && (
                <Select label="Which files" value={view.tab} onChange={(t) => chooseTab(t as DriveTab)} data="tab">
                  {TABS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              )}
              {/* Type, who made it and the sort are the list's own (the shared toolbar's filters and display). */}
            </div>
            {view.email && (
              <p className="text-xs text-muted-foreground" data-drive-email-note="">
                Files attached to mail in your own mailboxes, read from your mail provider when you look. Nothing is copied.
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1" data-drive-list="">
            {error ? (
              <p className="py-10 text-center text-sm text-destructive">{error}</p>
            ) : (
              <LocalViewList<FileRowData>
                entityType="file"
                rows={shown}
                loading={loading && shown.length === 0}
                dateFields={FILE_DATE_FIELDS}
                searchFields={FILE_SEARCH_FIELDS}
                search={typed}
                onSearchChange={setTyped}
                searchPlaceholder={view.email ? 'Search your mail' : 'Search files'}
                canSaveViews={false}
                headerExtra={<UploadButton inHeader={inCard} uploading={uploading} onClick={() => picker.current?.click()} />}
                onOpen={(row) => void openItem(row.item)}
                menuItemsOf={menuItemsOf}
                rowKeys={rowKeys}
                fallbackOrdering={view.tab === 'recent' ? OPENED_FIRST : view.email ? ADDED_FIRST : undefined}
                groupLabels={FILE_GROUP_LABELS}
                empty={<EmptyState view={view} filtered={filtered} mailboxes={mail.mailboxes} />}
                footer={
                  more ? (
                    <div className="flex shrink-0 justify-center py-3">
                      <button
                        type="button"
                        data-files-more=""
                        disabled={loading}
                        onClick={() => loadMore()}
                        className="h-7 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
                      >
                        {loading ? 'Loading…' : 'Show more'}
                      </button>
                    </div>
                  ) : null
                }
              />
            )}
          </div>
        </div>
      </CardCovered>
      <RecordOverlay records={records} page={props} />
      {moving && (
        <MoveToFolder
          item={moving}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null)
            setReload((n) => n + 1)
          }}
        />
      )}
      {viewer.viewer}
    </div>
  )
}

/** Upload: in the card's header, the header's 24px pill (as New spreadsheet, New canvas); outside a card, the row's own. */
function UploadButton({ uploading, onClick, inHeader = false }: { uploading: boolean; onClick: () => void; inHeader?: boolean }) {
  return (
    <button
      type="button"
      data-drive-upload=""
      onClick={onClick}
      disabled={uploading}
      className={
        inHeader
          ? CARD_HEADER_PILL_BUTTON
          : 'inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50'
      }
    >
      <Upload className="size-3.5" aria-hidden strokeWidth={inHeader ? 1.75 : undefined} />
      {uploading ? 'Uploading…' : 'Upload'}
    </button>
  )
}

function SourceToggle({ label, on, id, onClick }: { label: string; on: boolean; id: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-drive-source={id}
      onClick={onClick}
      className={pageTabClass(on)}
    >
      {label}
    </button>
  )
}

/**
 * A choice in the tabs' pill: the browser's own arrow drawn away, ours in its
 * place, so the words and the chevron sit 12px and 10px from the round ends
 * (Liam, 11-23: "can you fix these too the spacing is wrong").
 */
function Select({ label, value, onChange, data, children }: { label: string; value: string; onChange: (v: string) => void; data: string; children: React.ReactNode }) {
  return (
    <span className="relative inline-flex shrink-0">
      <select
        aria-label={label}
        value={value}
        data-drive-filter={data}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 cursor-pointer appearance-none rounded-full border border-foreground/[0.06] bg-foreground/[0.03] pl-3 pr-7 text-[13px] text-foreground outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:border-foreground/30"
      >
        {children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
    </span>
  )
}

function EmptyState({ view, filtered, mailboxes }: { view: DriveView; filtered: boolean; mailboxes: number | null }) {
  const [title, line] = view.email
    ? mailboxes === 0
      ? ['No mailbox here', 'Connect your mail to this workspace to see the files attached to it.']
      : ['No email attachments', filtered ? 'Nothing matches.' : 'No mail with files came back.']
    : view.tab === 'recent'
      ? ['Nothing opened yet', 'The files you open in Drive show here.']
      : filtered
        ? ['No files match', '']
        : ['No files yet', 'Files you upload, files on captures, actions, projects and table rows, and files sent in team chat show here.']
  return (
    <div data-files-empty="" className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Paperclip className="h-7 w-7 text-muted-foreground/60" aria-hidden />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {line && <p className="mt-1 text-sm text-muted-foreground">{line}</p>}
      </div>
    </div>
  )
}

/** M on one's own Drive upload: a folder to put it in, or out of its folder. Filing shares it with the folder's readers. */
function MoveToFolder({ item, onClose, onMoved }: { item: DriveItem; onClose: () => void; onMoved: () => void }) {
  const [folders, setFolders] = React.useState<DriveFolder[] | null>(null)
  const current = item.upload?.parent.folder ?? null
  React.useEffect(() => {
    void fetch('/api/account/folders')
      .then((r) => r.json())
      .then((b: { folders?: DriveFolder[] }) => setFolders(b.folders ?? []))
      .catch(() => setFolders([]))
  }, [])
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const send = async (url: string, method: 'POST' | 'DELETE') => {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'attachment', id: item.upload!.id }) })
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string }
      toast.error(b.error || 'That didn’t work.')
      return
    }
    onMoved()
  }
  const label = (f: DriveFolder) => (folders ? folderPath(folders, f.id).map((p) => p.name).join(' › ') : f.name) || f.name
  return (
    <div className={`absolute right-5 top-24 z-30 flex max-h-72 w-72 flex-col overflow-y-auto py-1 ${FLOATING_CARD_CLASS}`} data-drive-move="" role="dialog" aria-label={`Move ${item.name}`}>
      <div className="flex items-center justify-between px-3 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">Move {item.name}</span>
        <button type="button" aria-label="Close" onClick={onClose}>
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="px-3 pb-1 text-[11px] text-muted-foreground">Everyone in the workspace can see a file in a folder.</p>
      {current && (
        <button type="button" autoFocus onClick={() => void send(`/api/account/folders/${current.id}/items`, 'DELETE')} className="px-3 py-1.5 text-left text-xs text-foreground hover:bg-background" data-drive-move-out="">
          Take it out of {current.name} (only you)
        </button>
      )}
      {folders === null ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">Loading…</p>
      ) : folders.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">No folders yet. Make one from Folders.</p>
      ) : (
        [...folders]
          .filter((f) => f.id !== current?.id)
          .sort((a, b) => label(a).localeCompare(label(b)))
          .map((f, i) => (
            <button
              key={f.id}
              type="button"
              autoFocus={!current && i === 0}
              data-drive-move-to={f.id}
              onClick={() => void send(`/api/account/folders/${f.id}/items`, 'POST')}
              className="truncate px-3 py-1.5 text-left text-xs text-foreground hover:bg-background"
            >
              {label(f)}
            </button>
          ))
      )}
    </div>
  )
}
