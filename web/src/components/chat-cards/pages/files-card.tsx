'use client'

/**
 * Files as a card (Liam, 11-11: "Drive: Docs, Knowledge, and a new page that
 * shows all available files that were uploaded anywhere in the app, uploaded
 * to captures or action items or projects"): every file in the workspace the
 * person may see, newest first (GET /api/account/files, fenced twice: see
 * lib/attachments/workspace-files.ts).
 *
 *   A row     the file's icon (by its category, a document's by its kind),
 *             its name, where it is attached, its size and when it came.
 *   The file  opens in the in-app viewer (components/files/file-viewer.tsx:
 *             PDF, images, video, audio, text, Word, sheets, slides), from a
 *             short signed URL from the attachments bucket (its own read
 *             policy fences it); a kind it can't show is offered as a download.
 *   Its place the capture, action or project opens over the page, inside the
 *             card (a step the header's Back walks), so Drive stays selected.
 *             A table's row (a form's upload, migration 663) is named with
 *             its table, as text: a row opens from its table.
 *   A form's  file a stranger sent: never rendered but as an image; the
 *             viewer offers it as a download (its signed URL asks storage
 *             for an attachment download).
 *   Filter    All, Images, Documents (the categories files are filed under),
 *             the page's own tab row, and a search on the name, in the card's
 *             header with every page's search (Liam, 11-22: a page's controls
 *             live in its card's header); more pages on request.
 *
 * Flat cost: one read per page shown, none of its own afterwards.
 */
import * as React from 'react'
import { File as FileIcon, FileCode, FileImage, FileSpreadsheet, FileText, Paperclip, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { ExpandableSearch } from '@/components/views/expandable-search'
import { useFileViewer } from '@/components/files/file-viewer'
import { createClient } from '@/lib/supabase/client'
import { downloadFile } from '@/lib/download'
import type { ViewerFile } from '@/lib/files/viewer-file'
import { cn } from '@/lib/utils'
import {
  FILE_CATEGORIES,
  FILE_CATEGORY_LABELS,
  FILES_OFFSET_MAX,
  FILES_PAGE_SIZE,
  filesUrl,
  formatFileSize,
  type FileCategory,
  type WorkspaceFile,
  type WorkspaceFilesPage,
} from '@/lib/attachments/workspace-files-model'
import { CardCovered } from '../card-covered'
import { CardHeaderSlot, useCardHeaderSlots } from '../card-header-slot'
import { RecordOverlay, usePageRecords } from './record-overlay'
import type { PageCardProps } from './page-card'

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

const PARENT_NOUN: Record<WorkspaceFile['parent']['type'], string> = { capture: 'Capture', action: 'Action', row: 'Row', project: 'Project' }

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The file as the in-app viewer takes it: its bytes through a short signed URL (re-signed for a download). */
export function viewerFileOf(file: WorkspaceFile, url: string): ViewerFile {
  return {
    key: `attachment:${file.id}`,
    name: file.file_name,
    mimeType: file.mime_type,
    size: file.file_size_bytes,
    url,
    sourceLabel: `${PARENT_NOUN[file.parent.type]} · ${file.parent.label}`,
    // A stranger's file (a form's upload) is never rendered in place, an image aside.
    downloadOnly: !!file.from_form && file.file_category !== 'image',
    download: async () => {
      if (!file.storage_path) return
      const fresh = await signedUrlOf(file.storage_path, file.from_form ? file.file_name : undefined)
      if (!fresh) throw new Error('Could not download the file')
      await downloadFile(fresh, file.file_name)
    },
  }
}

/** A short signed URL to a file in the attachments bucket, or null; `download` names the file storage sends as an attachment. */
async function signedUrlOf(path: string, download?: string): Promise<string | null> {
  const { data } = await createClient().storage.from('attachments').createSignedUrl(path, 60, download ? { download } : undefined)
  return data?.signedUrl ?? null
}

interface Listing {
  files: WorkspaceFile[]
  next: number | null
  loading: boolean
  error: string | null
}

/**
 * The most pages one load reads on its own while each comes back empty (every
 * file on it on a record the person can't read, dropped by the server's
 * second fence) and there are more: past them, "Show more" asks for the rest.
 */
export const FILES_EMPTY_PAGES_MAX = 5

/** Where the next page starts, or null: none, or past the offsets the server takes (FILES_OFFSET_MAX). */
function nextOffsetOf(next: number | null | undefined): number | null {
  return typeof next === 'number' && next <= FILES_OFFSET_MAX ? next : null
}

/**
 * The files for a category and a search, a page at a time. A page the server
 * emptied (its files all on records the person can't read) with more after
 * it is read past at once, up to FILES_EMPTY_PAGES_MAX, so "No files yet"
 * shows only when there is truly nothing more.
 */
function useFiles(category: FileCategory | null, q: string) {
  const [listing, setListing] = React.useState<Listing>({ files: [], next: null, loading: true, error: null })
  const asked = React.useRef(0)
  const load = React.useCallback(
    async (offset: number) => {
      const ask = ++asked.current
      setListing((l) => ({ ...(offset ? l : { files: [], next: null }), loading: true, error: null }))
      try {
        let at = offset
        let body: (WorkspaceFilesPage & { error?: string }) | null = null
        for (let read = 0; ; read++) {
          const res = await fetch(filesUrl({ limit: FILES_PAGE_SIZE, offset: at, ...(category ? { category } : {}), ...(q ? { q } : {}) }))
          body = (await res.json().catch(() => null)) as (WorkspaceFilesPage & { error?: string }) | null
          if (ask !== asked.current) return
          if (!res.ok || !body || !Array.isArray(body.files)) {
            setListing((l) => ({ ...l, loading: false, error: body?.error ?? 'Could not load the files' }))
            return
          }
          const next = nextOffsetOf(body.next_offset)
          if (body.files.length > 0 || next === null || read + 1 >= FILES_EMPTY_PAGES_MAX) break
          at = next
        }
        const page = body
        setListing((l) => ({ files: offset ? [...l.files, ...page.files] : page.files, next: nextOffsetOf(page.next_offset), loading: false, error: null }))
      } catch {
        if (ask === asked.current) setListing((l) => ({ ...l, loading: false, error: 'Could not load the files' }))
      }
    },
    [category, q],
  )
  React.useEffect(() => {
    void load(0)
  }, [load])
  return { ...listing, more: () => (listing.next !== null ? load(listing.next) : undefined) }
}

export default function FilesCard(props: PageCardProps) {
  const { toolCallId, store, onCount } = props
  const records = usePageRecords(toolCallId, store)
  // In a card the search is the header's (outside one, the row's, as before).
  const inCard = useCardHeaderSlots() !== null
  const [category, setCategory] = React.useState<FileCategory | null>(null)
  const [typed, setTyped] = React.useState('')
  const [q, setQ] = React.useState('')
  React.useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 250)
    return () => clearTimeout(t)
  }, [typed])
  const { files, next, loading, error, more } = useFiles(category, q)
  const filtered = !!category || !!q

  // The header's count: the files there are, once every page is in.
  React.useEffect(() => {
    onCount?.(loading || next !== null ? null : files.length)
  }, [onCount, loading, next, files.length])

  const fileViewer = useFileViewer()
  const openViewer = fileViewer.open
  const openFile = React.useCallback(
    async (file: WorkspaceFile) => {
      if (!file.storage_path) return
      // Signed for a few minutes: long enough for a video to stream.
      const { data } = await createClient().storage.from('attachments').createSignedUrl(file.storage_path, 600)
      if (!data?.signedUrl) {
        toast.error('Could not open the file')
        return
      }
      openViewer(viewerFileOf(file, data.signedUrl))
    },
    [openViewer],
  )

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
        {/* The name search, in the header as every page's search is (Liam,
            11-22); a record open over the list has the header then
            (CardCovered). The tabs stay the page's own row. */}
        {inCard && (
          <CardHeaderSlot side="right">
            <div data-files-search-control="" className="flex items-center">
              <ExpandableSearch value={typed} onChange={setTyped} label="Search files" placeholder="Search files" />
            </div>
          </CardHeaderSlot>
        )}
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-2 pt-3">
            <div role="radiogroup" aria-label="File type" className="flex items-center gap-1">
              {([null, ...FILE_CATEGORIES] as const).map((c) => (
                <button
                  key={c ?? 'all'}
                  type="button"
                  role="radio"
                  aria-checked={category === c}
                  data-files-filter={c ?? 'all'}
                  onClick={() => setCategory(c)}
                  className={cn(
                    'h-7 rounded-lg px-2.5 text-xs transition-colors',
                    category === c ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {c ? FILE_CATEGORY_LABELS[c] : 'All'}
                </button>
              ))}
            </div>
            {!inCard && (
              <div className="relative ml-auto w-48 min-w-0">
                <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="Search files"
                  aria-label="Search files"
                  data-files-search=""
                  className="h-7 pl-7 text-xs"
                />
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            {error ? (
              <p className="py-10 text-center text-sm text-destructive">{error}</p>
            ) : files.length === 0 && loading ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
            ) : files.length === 0 && next === null ? (
              <div data-files-empty="" className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <Paperclip className="h-7 w-7 text-muted-foreground/60" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-foreground">{filtered ? 'No files match' : 'No files yet'}</p>
                  {!filtered && <p className="mt-1 text-sm text-muted-foreground">Files attached to a capture, an action, a project or a table’s row show here.</p>}
                </div>
              </div>
            ) : (
              <>
                {files.length > 0 && (
                  <ul className="divide-y divide-border">
                    {files.map((file) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        onOpen={() => void openFile(file)}
                        onOpenParent={() => file.parent.type !== 'row' && records.open({ type: file.parent.type, id: file.parent.id, label: file.parent.label })}
                      />
                    ))}
                  </ul>
                )}
                {next !== null && (
                  <div className="flex justify-center pt-3">
                    <button
                      type="button"
                      data-files-more=""
                      disabled={loading}
                      onClick={() => void more()}
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
      {fileViewer.viewer}
    </div>
  )
}

function FileRow({ file, onOpen, onOpenParent }: { file: WorkspaceFile; onOpen: () => void; onOpenParent: () => void }) {
  const size = formatFileSize(file.file_size_bytes)
  return (
    <li data-files-row={file.id} className="flex items-center gap-3 py-2">
      <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
        {React.createElement(fileIconOf(file), { className: 'size-4', strokeWidth: 1.75 })}
      </span>
      <span className="min-w-0 flex-1">
        <button
          type="button"
          data-files-open={file.id}
          onClick={onOpen}
          title={`Open ${file.file_name}`}
          className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:underline"
        >
          {file.file_name}
        </button>
        {file.parent.type === 'row' ? (
          <span data-files-parent={`row:${file.parent.id}`} className="block max-w-full truncate text-left text-xs text-muted-foreground">
            {PARENT_NOUN.row} · {file.parent.label}
            {file.parent.table ? ` in ${file.parent.table.name}` : ''}
          </span>
        ) : (
          <button
            type="button"
            data-files-parent={`${file.parent.type}:${file.parent.id}`}
            onClick={onOpenParent}
            title={`Open ${PARENT_NOUN[file.parent.type].toLowerCase()}`}
            className="block max-w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {PARENT_NOUN[file.parent.type]} · {file.parent.label}
          </button>
        )}
      </span>
      {size && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">{size}</span>}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{shortDate(file.created_at)}</span>
    </li>
  )
}
