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
 *   Filters   type, who made it; Sort by last modified, date added, last
 *             opened, name or size.
 *   A row     the file's icon, name, where it lives, who made it, its size
 *             and a time (the sort's). The name opens the in-app viewer
 *             (components/files); an upload's record opens over the page,
 *             inside the card, as before.
 *   Upload    drop files on the card (or Upload): a Drive upload, the
 *             uploader's alone until they file it in a folder (709).
 *   M         on a focused row of their own Drive upload: move it to a
 *             folder, or take it out of one.
 */
import * as React from 'react'
import { File as FileIcon, FileCode, FileImage, FileSpreadsheet, FileText, Film, Music, Paperclip, Presentation, Search, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { ExpandableSearch } from '@/components/views/expandable-search'
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
  type DriveItem,
  type DriveSort,
  type DriveType,
} from '@/lib/drive/drive-items'
import { folderPath, type DriveFolder } from '@/lib/drive/folders'
import { emailViewerFile, teamChatFileLink, teamChatViewerFile, uploadFileLink, uploadViewerFile } from '@/lib/files/sources'
import { cn } from '@/lib/utils'
import { CardCovered } from '../card-covered'
import { CARD_HEADER_PILL_BUTTON } from '../card-header-button'
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
  { id: 'all', label: 'All' },
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
  type: DriveType | null
  creator: string | null
  sort: DriveSort
}

const DEFAULT_VIEW: DriveView = { tab: 'all', uploads: true, chat: true, email: false, type: null, creator: null, sort: 'modified' }

/** Who made an item, as a member (uploads carry a user, chat files a member). */
function creatorOf(item: DriveItem, members: readonly DriveMember[]): DriveMember | null {
  if (item.creator.memberId) return members.find((m) => m.id === item.creator.memberId) ?? null
  if (item.creator.userId) return members.find((m) => m.user_id === item.creator.userId) ?? null
  return null
}

/** A source toggle: on its own it turns the other source back on, so one is always shown. */
export function toggleSource(v: DriveView, source: 'uploads' | 'chat'): DriveView {
  if (v.email) return { ...v, email: false, uploads: source === 'uploads', chat: source === 'chat', sort: v.sort === 'created' ? 'modified' : v.sort }
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
      .filter((i) => !view.type || i.type === view.type)
      .filter((i) => !view.creator || creatorOf(i, members)?.id === view.creator)
      .filter((i) => view.tab !== 'recent' || !needle || i.name.toLowerCase().includes(needle))
      .map((i) => ({ ...i, openedAt: recent.opened.get(i.key) ?? i.openedAt ?? null }))
    return sortDriveItems(list, view.sort)
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

  const filtered = view.type !== null || view.creator !== null || !!q || !view.uploads || !view.chat

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
        {inCard && (
          <CardHeaderSlot side="right">
            <div data-files-search-control="" className="flex items-center gap-1.5">
              <ExpandableSearch value={typed} onChange={setTyped} label="Search files" placeholder={view.email ? 'Search your mail' : 'Search files'} />
              <UploadButton inHeader uploading={uploading} onClick={() => picker.current?.click()} />
            </div>
          </CardHeaderSlot>
        )}
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
          <div className="flex shrink-0 flex-col gap-2 px-5 pb-2 pt-3">
            {!view.email && (
              <div role="radiogroup" aria-label="Which files" className="flex flex-wrap items-center gap-1">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={view.tab === t.id}
                    data-drive-tab={t.id}
                    onClick={() => setView((v) => ({ ...v, tab: t.id, sort: t.id === 'recent' ? 'opened' : v.sort === 'opened' ? 'modified' : v.sort }))}
                    className={cn(
                      'h-7 rounded-lg px-2.5 text-xs transition-colors',
                      view.tab === t.id ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <SourceToggle label={DRIVE_SOURCE_LABELS.upload} on={!view.email && view.uploads} id="upload" onClick={() => setView((v) => toggleSource(v, 'uploads'))} />
              <SourceToggle label={DRIVE_SOURCE_LABELS.team_chat} on={!view.email && view.chat} id="team_chat" onClick={() => setView((v) => toggleSource(v, 'chat'))} />
              <SourceToggle
                label={DRIVE_SOURCE_LABELS.email}
                on={view.email}
                id="email"
                onClick={() =>
                  setView((v) => (v.email ? { ...v, email: false, sort: 'modified' } : { ...v, email: true, tab: 'all', creator: null, sort: v.sort === 'name' || v.sort === 'size' ? v.sort : 'created' }))
                }
              />
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
              <Select label="Type" value={view.type ?? ''} onChange={(t) => setView((v) => ({ ...v, type: (t || null) as DriveType | null }))} data="type">
                <option value="">All types</option>
                {DRIVE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {DRIVE_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
              {!view.email && (
                <Select label="Created by" value={view.creator ?? ''} onChange={(c) => setView((v) => ({ ...v, creator: c || null }))} data="creator">
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name?.trim() || 'A teammate'}
                    </option>
                  ))}
                </Select>
              )}
              <Select label="Sort" value={view.sort} onChange={(s) => setView((v) => ({ ...v, sort: s as DriveSort }))} data="sort">
                {DRIVE_SORTS.filter((s) => !view.email || (s !== 'opened' && s !== 'modified')).map((s) => (
                  <option key={s} value={s}>
                    {DRIVE_SORT_LABELS[s]}
                  </option>
                ))}
              </Select>
              {!inCard && (
                <>
                  <div className="relative ml-auto w-48 min-w-0">
                    <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search files" aria-label="Search files" data-files-search="" className="h-7 pl-7 text-xs" />
                  </div>
                  <UploadButton uploading={uploading} onClick={() => picker.current?.click()} />
                </>
              )}
            </div>
            {view.email && (
              <p className="text-xs text-muted-foreground" data-drive-email-note="">
                Files attached to mail in your own mailboxes, read from your mail provider when you look. Nothing is copied.
              </p>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            {error ? (
              <p className="py-10 text-center text-sm text-destructive">{error}</p>
            ) : shown.length === 0 && loading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : shown.length === 0 && !more ? (
              <EmptyState view={view} filtered={filtered} mailboxes={mail.mailboxes} />
            ) : (
              <>
                {shown.length > 0 && (
                  <ul className="divide-y divide-border" data-drive-list="">
                    {shown.map((item) => (
                      <FileRow
                        key={item.key}
                        item={item}
                        sort={view.sort}
                        creator={creatorOf(item, members)}
                        onOpen={() => void openItem(item)}
                        onOpenParent={() => {
                          const p = item.upload?.parent
                          if (p && p.type !== 'row' && p.type !== 'drive') records.open({ type: p.type, id: p.id, label: p.label })
                        }}
                        onMove={item.upload?.parent.type === 'drive' ? () => setMoving(item) : undefined}
                      />
                    ))}
                  </ul>
                )}
                {more && (
                  <div className="flex justify-center pt-3">
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
                )}
              </>
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
      className={cn('h-7 rounded-full border px-2.5 transition-colors', on ? 'border-foreground/20 bg-foreground/[0.08] text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
    >
      {label}
    </button>
  )
}

function Select({ label, value, onChange, data, children }: { label: string; value: string; onChange: (v: string) => void; data: string; children: React.ReactNode }) {
  return (
    <select
      aria-label={label}
      value={value}
      data-drive-filter={data}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-foreground/30"
    >
      {children}
    </select>
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

function FileRow({
  item,
  sort,
  creator,
  onOpen,
  onOpenParent,
  onMove,
}: {
  item: DriveItem
  sort: DriveSort
  creator: DriveMember | null
  onOpen: () => void
  onOpenParent: () => void
  onMove?: () => void
}) {
  const size = formatFileSize(item.size)
  const Icon = TYPE_ICON[item.type]
  const parent = item.upload?.parent
  const opensParent = !!parent && parent.type !== 'row' && parent.type !== 'drive'
  const by = creator?.display_name?.trim() || item.creator.label || null
  return (
    <li
      data-files-row={item.upload?.id ?? item.key}
      data-drive-row={item.key}
      onKeyDown={(e) => {
        if (onMove && (e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault()
          e.stopPropagation()
          onMove()
        }
      }}
      className="flex items-center gap-3 py-2"
    >
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <button
          type="button"
          data-files-open={item.upload?.id ?? item.key}
          onClick={onOpen}
          title={onMove ? `Open ${item.name} (M to move it to a folder)` : `Open ${item.name}`}
          className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:underline"
        >
          {item.name}
        </button>
        {opensParent ? (
          <button
            type="button"
            data-files-parent={`${parent!.type}:${parent!.id}`}
            onClick={onOpenParent}
            className="block max-w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {item.where}
          </button>
        ) : (
          <span data-files-parent={parent ? `${parent.type}:${parent.id}` : item.source} className="block max-w-full truncate text-left text-xs text-muted-foreground">
            {item.where}
          </span>
        )}
      </span>
      {by && <span className="hidden w-28 shrink-0 truncate text-xs text-muted-foreground md:block">{by}</span>}
      {size && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">{size}</span>}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{shortDate(driveItemTime(item, sort))}</span>
    </li>
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
