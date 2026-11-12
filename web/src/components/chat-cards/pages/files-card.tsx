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
 *   The file  opens as a record's attachments open it (capture/
 *             attachments-carousel.tsx): an image in the same viewer
 *             (Lightbox), any other file downloaded, through a short signed
 *             URL from the attachments bucket (its own read policy fences it).
 *   Its place the capture, action or project opens over the page, inside the
 *             card (a step the header's Back walks), so Drive stays selected.
 *   Filter    All, Images, Documents (the categories files are filed under),
 *             and a search on the name; more pages on request.
 *
 * Flat cost: one read per page shown, none of its own afterwards.
 */
import * as React from 'react'
import { createPortal } from 'react-dom'
import { File as FileIcon, FileCode, FileImage, FileSpreadsheet, FileText, Paperclip, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Lightbox } from '@/components/capture/attachments-carousel'
import type { AttachmentItem } from '@/app/account/(dashboard)/views/capture-utils'
import { createClient } from '@/lib/supabase/client'
import { downloadFile } from '@/lib/download'
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

const PARENT_NOUN: Record<WorkspaceFile['parent']['type'], string> = { capture: 'Capture', action: 'Action', project: 'Project' }

function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** The viewer's item, as the carousel's Lightbox takes it. */
function asAttachment(file: WorkspaceFile): AttachmentItem {
  return {
    id: file.id,
    file_name: file.file_name,
    file_size_bytes: file.file_size_bytes,
    mime_type: file.mime_type,
    file_extension: file.file_extension,
    file_category: file.file_category,
    storage_path: file.storage_path,
    thumbnail_path: file.thumbnail_path,
    note_id: file.parent.type === 'capture' ? file.parent.id : null,
    action_id: file.parent.type === 'action' ? file.parent.id : null,
    project_id: file.parent.type === 'project' ? file.parent.id : null,
    created_at: file.created_at,
  }
}

/** A short signed URL to a file in the attachments bucket, or null. */
async function signedUrlOf(path: string): Promise<string | null> {
  const { data } = await createClient().storage.from('attachments').createSignedUrl(path, 60)
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

  const [viewing, setViewing] = React.useState<{ item: AttachmentItem; url: string } | null>(null)
  React.useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setViewing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [viewing])

  const openFile = React.useCallback(async (file: WorkspaceFile) => {
    if (!file.storage_path) return
    const url = await signedUrlOf(file.storage_path)
    if (!url) {
      toast.error('Could not open the file')
      return
    }
    if (file.file_category === 'image') {
      setViewing({ item: asAttachment(file), url })
      return
    }
    try {
      await downloadFile(url, file.file_name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    }
  }, [])

  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current}>
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
                  {!filtered && <p className="mt-1 text-sm text-muted-foreground">Files attached to a capture, an action or a project show here.</p>}
                </div>
              </div>
            ) : (
              <>
                {files.length > 0 && (
                  <ul className="divide-y divide-border">
                    {files.map((file) => (
                      <FileRow key={file.id} file={file} onOpen={() => void openFile(file)} onOpenParent={() => records.open({ ...file.parent })} />
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
      {viewing &&
        createPortal(
          <Lightbox images={[viewing.item]} signedUrls={{ [viewing.item.id]: viewing.url }} currentIndex={0} onIndexChange={() => {}} onClose={() => setViewing(null)} />,
          document.body,
        )}
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
          title={file.file_category === 'image' ? `View ${file.file_name}` : `Download ${file.file_name}`}
          className="block max-w-full truncate text-left text-sm font-medium text-foreground hover:underline"
        >
          {file.file_name}
        </button>
        <button
          type="button"
          data-files-parent={`${file.parent.type}:${file.parent.id}`}
          onClick={onOpenParent}
          title={`Open ${PARENT_NOUN[file.parent.type].toLowerCase()}`}
          className="block max-w-full truncate text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          {PARENT_NOUN[file.parent.type]} · {file.parent.label}
        </button>
      </span>
      {size && <span className="hidden shrink-0 text-xs tabular-nums text-muted-foreground sm:block">{size}</span>}
      <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">{shortDate(file.created_at)}</span>
    </li>
  )
}
