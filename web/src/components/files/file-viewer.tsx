'use client'

/**
 * The in-app file viewer (docs/plans/drive-files.md, phase 1): one full-window
 * dialog that shows a file in the browser, from its own bytes, whatever place
 * opened it (Drive, a mail attachment, a team chat file, a search result).
 *
 *   Header   the file's icon, name and where it came from; Download; Close.
 *   Body     the viewer its kind takes (lib/files/viewer-kind.ts), loaded on
 *            demand so a page that never opens a PDF never loads pdf.js.
 *            A file too big for its viewer, of a kind none shows, or from
 *            outside the workspace (a form's upload) is offered as a
 *            download, never rendered.
 *
 * Nothing is sent anywhere: the bytes come from the caller's own signed URL
 * or route (lib/files/viewer-file.ts), and a Figma link is shown in Figma's
 * own embed, as the link's own page would show it.
 */
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Download, File as FileIcon, FileImage, FileSpreadsheet, FileText, Film, Loader2, Music, Presentation, X } from 'lucide-react'
import { toast } from 'sonner'
import { saveBlobFile } from '@/lib/download'
import { formatFileSize } from '@/lib/attachments/workspace-files-model'
import { figmaEmbedUrl, fitsViewer, viewerKindOf, type ViewerKind } from '@/lib/files/viewer-kind'
import { loadViewerBytes, type ViewerFile } from '@/lib/files/viewer-file'
import { cn } from '@/lib/utils'
import type { PdfPageOverlay } from './pdf-viewer'
import { FileCommentsButton, FileCommentsPanel, useFileCommentOverlay, useFileComments, type PendingPin } from './file-comments'

const PdfViewer = React.lazy(() => import('./pdf-viewer'))
const DocxViewer = React.lazy(() => import('./docx-viewer'))
const SheetViewer = React.lazy(() => import('./sheet-viewer'))
const PptxViewer = React.lazy(() => import('./pptx-viewer'))
const TextViewer = React.lazy(() => import('./text-viewer'))

const KIND_ICON: Record<ViewerKind, typeof FileIcon> = {
  pdf: FileText,
  docx: FileText,
  text: FileText,
  sheet: FileSpreadsheet,
  pptx: Presentation,
  image: FileImage,
  video: Film,
  audio: Music,
  figma: FileImage,
  none: FileIcon,
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
}

/** A blob re-typed for the element that shows it (a mail route answers octet-stream); never as SVG or HTML. */
function typedBlob(blob: Blob, kind: ViewerKind, file: ViewerFile): Blob {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const given = (file.mimeType ?? '').toLowerCase()
  let type = ''
  if (kind === 'image') type = IMAGE_TYPES[ext] ?? (given.startsWith('image/') && !given.includes('svg') ? given : 'image/png')
  else if (kind === 'video') type = given.startsWith('video/') ? given : ext === 'webm' ? 'video/webm' : 'video/mp4'
  else if (kind === 'audio') type = given.startsWith('audio/') ? given : ext === 'wav' ? 'audio/wav' : 'audio/mpeg'
  return type ? new Blob([blob], { type }) : blob
}

export interface FileViewerProps {
  file: ViewerFile | null
  onClose: () => void
  /** Pins drawn over a PDF's pages (phase 4's comments). */
  pdfOverlay?: PdfPageOverlay
  /** Extra controls in the header (a "Comments" toggle). */
  headerExtra?: React.ReactNode
  /** A panel beside the file (the comments list). */
  aside?: React.ReactNode
}

export function FileViewer({ file, onClose, pdfOverlay, headerExtra, aside }: FileViewerProps) {
  return (
    <DialogPrimitive.Root open={!!file} onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[90] bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          data-file-viewer=""
          aria-describedby={undefined}
          onKeyDown={(e) => {
            // The app's own shortcuts (G, C, M…) never see keys typed in the viewer.
            if (e.key !== 'Escape') e.stopPropagation()
          }}
          className="fixed inset-2 z-[91] flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-none sm:inset-6"
        >
          {file && <ViewerBody file={file} pdfOverlay={pdfOverlay} headerExtra={headerExtra} aside={aside} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

type Loaded = { state: 'loading' } | { state: 'ready'; blob: Blob } | { state: 'error'; message: string }

function ViewerBody({ file, pdfOverlay, headerExtra, aside }: { file: ViewerFile; pdfOverlay?: PdfPageOverlay; headerExtra?: React.ReactNode; aside?: React.ReactNode }) {
  const kind = viewerKindOf({ name: file.name, mimeType: file.mimeType, url: file.url })
  const shows = !file.downloadOnly && fitsViewer(kind, file.size)
  // Video and audio stream from their URL when there is one; Figma is a link.
  const streams = (kind === 'video' || kind === 'audio') && !!file.url && !file.load
  const needsBytes = shows && kind !== 'figma' && !streams
  const [loaded, setLoaded] = React.useState<Loaded>({ state: 'loading' })
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!needsBytes) return
    const abort = new AbortController()
    setLoaded({ state: 'loading' })
    loadViewerBytes(file, abort.signal)
      .then((blob) => !abort.signal.aborted && setLoaded({ state: 'ready', blob }))
      .catch((err: unknown) => {
        if (abort.signal.aborted) return
        setLoaded({ state: 'error', message: err instanceof Error ? err.message : 'Could not read the file' })
      })
    return () => abort.abort()
    // The file's key names it; a new object for the same file is not a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.key, needsBytes])

  const download = React.useCallback(async () => {
    setSaving(true)
    try {
      if (file.download) await file.download()
      else if (loaded.state === 'ready') await saveBlobFile(file.name, loaded.blob)
      else await saveBlobFile(file.name, await loadViewerBytes(file))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setSaving(false)
    }
  }, [file, loaded])

  // Comments (706): on an upload or a chat file, never a mail attachment; pins on a PDF's pages.
  const commentable = !!file.commentTarget && shows && kind !== 'figma'
  const comments = useFileComments(commentable ? file.commentTarget : null, file.name)
  const [commentsOpen, setCommentsOpen] = React.useState(false)
  const [placing, setPlacing] = React.useState(false)
  const [pending, setPending] = React.useState<PendingPin | null>(null)
  const [focus, setFocus] = React.useState<string | null>(null)
  const [jump, setJump] = React.useState<{ page: number; n: number } | null>(null)
  const showThread = (id: string | null) => {
    setFocus(id)
    const page = comments.threads.find((t) => t.root.id === id)?.root.page
    if (page) setJump((j) => ({ page, n: (j?.n ?? 0) + 1 }))
  }
  const commentOverlay = useFileCommentOverlay({
    comments,
    placing,
    pending,
    focus,
    onPlace: (pin) => {
      setPending(pin)
      setPlacing(false)
      setCommentsOpen(true)
    },
    onOpen: (id) => {
      setCommentsOpen(true)
      setFocus(id)
    },
  })
  const overlay = pdfOverlay ?? (commentable && comments.state === 'ready' ? commentOverlay : undefined)
  const commentsAside =
    commentable && commentsOpen ? (
      <FileCommentsPanel
        comments={comments}
        focus={focus}
        onFocus={showThread}
        pending={pending}
        onPendingDone={() => setPending(null)}
        canPlace={kind === 'pdf'}
        placing={placing}
        onPlacing={setPlacing}
        onClose={() => {
          setCommentsOpen(false)
          setPlacing(false)
          setPending(null)
        }}
      />
    ) : null

  const size = formatFileSize(file.size ?? null)
  const Icon = KIND_ICON[kind]
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <DialogPrimitive.Title className="truncate text-sm font-medium text-foreground" data-file-viewer-name="">
            {file.name}
          </DialogPrimitive.Title>
          {(file.sourceLabel || size) && (
            <p className="truncate text-xs text-muted-foreground">{[file.sourceLabel, size].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        {headerExtra}
        {commentable && <FileCommentsButton comments={comments} pressed={commentsOpen} onClick={() => setCommentsOpen((o) => !o)} />}
        {kind !== 'figma' && (
          <button
            type="button"
            data-file-viewer-download=""
            onClick={() => void download()}
            disabled={saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50"
          >
            {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
            Download
          </button>
        )}
        <DialogPrimitive.Close
          data-file-viewer-close=""
          aria-label="Close"
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 bg-muted/20">
          {!shows ? (
            <NoPreview file={file} kind={kind} onDownload={() => void download()} />
          ) : kind === 'figma' ? (
            <FigmaEmbed url={file.url ?? ''} name={file.name} />
          ) : streams ? (
            <MediaView kind={kind} src={file.url ?? ''} name={file.name} />
          ) : loaded.state === 'loading' ? (
            <Centered>
              <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
            </Centered>
          ) : loaded.state === 'error' ? (
            <Centered>
              <p className="text-sm text-destructive" data-file-viewer-error="">
                {loaded.message}
              </p>
              <button type="button" onClick={() => void download()} className="mt-3 text-xs text-muted-foreground underline hover:text-foreground">
                Try downloading it
              </button>
            </Centered>
          ) : (
            <React.Suspense
              fallback={
                <Centered>
                  <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
                </Centered>
              }
            >
              <KindView kind={kind} blob={loaded.blob} file={file} pdfOverlay={overlay} jump={jump} onDownload={() => void download()} />
            </React.Suspense>
          )}
        </div>
        {aside ?? commentsAside}
      </div>
    </>
  )
}

function KindView({ kind, blob, file, pdfOverlay, jump, onDownload }: { kind: ViewerKind; blob: Blob; file: ViewerFile; pdfOverlay?: PdfPageOverlay; jump?: { page: number; n: number } | null; onDownload: () => void }) {
  switch (kind) {
    case 'pdf':
      return <PdfViewer blob={blob} overlay={pdfOverlay} jump={jump} />
    case 'docx':
      return <DocxViewer blob={blob} onDownload={onDownload} />
    case 'sheet':
      return <SheetViewer blob={blob} name={file.name} onDownload={onDownload} />
    case 'pptx':
      return <PptxViewer blob={blob} onDownload={onDownload} />
    case 'text':
      return <TextViewer blob={blob} name={file.name} />
    case 'image':
      return <ImageView blob={typedBlob(blob, kind, file)} name={file.name} />
    case 'video':
    case 'audio':
      return <BlobMedia kind={kind} blob={typedBlob(blob, kind, file)} name={file.name} />
    default:
      return <NoPreview file={file} kind={kind} onDownload={onDownload} />
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center p-6 text-center">{children}</div>
}

/** An object URL for a blob, revoked when it goes. */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!blob) return
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => {
      URL.revokeObjectURL(u)
      setUrl(null)
    }
  }, [blob])
  return url
}

function ImageView({ blob, name }: { blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  const [zoomed, setZoomed] = React.useState(false)
  if (!url) return null
  return (
    <div className={cn('h-full overflow-auto', zoomed ? '' : 'flex items-center justify-center p-6')}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        data-file-viewer-image=""
        onClick={() => setZoomed((z) => !z)}
        className={cn(zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain')}
      />
    </div>
  )
}

function MediaView({ kind, src, name }: { kind: ViewerKind; src: string; name: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      {kind === 'video' ? (
        <video src={src} controls preload="metadata" className="max-h-full max-w-full rounded-lg bg-black" data-file-viewer-video="" aria-label={name} />
      ) : (
        <audio src={src} controls preload="metadata" className="w-full max-w-lg" data-file-viewer-audio="" aria-label={name} />
      )}
    </div>
  )
}

function BlobMedia({ kind, blob, name }: { kind: ViewerKind; blob: Blob; name: string }) {
  const url = useObjectUrl(blob)
  return url ? <MediaView kind={kind} src={url} name={name} /> : null
}

function FigmaEmbed({ url, name }: { url: string; name: string }) {
  const embed = figmaEmbedUrl(url)
  if (!embed) return <Centered>This is not a Figma link.</Centered>
  return (
    <iframe
      src={embed}
      title={name}
      data-file-viewer-figma=""
      className="h-full w-full border-0"
      allowFullScreen
      referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
    />
  )
}

function NoPreview({ file, kind, onDownload }: { file: ViewerFile; kind: ViewerKind; onDownload: () => void }) {
  const why = file.downloadOnly
    ? 'This file was sent from outside the workspace, so it is not opened here.'
    : kind === 'none'
      ? 'This kind of file can’t be shown here.'
      : 'This file is too big to show here.'
  return (
    <Centered>
      <FileIcon className="size-8 text-muted-foreground/60" aria-hidden />
      <p className="mt-3 text-sm text-foreground" data-file-viewer-no-preview="">
        {why}
      </p>
      <button
        type="button"
        onClick={onDownload}
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs text-background hover:bg-foreground/90"
      >
        <Download className="size-3.5" aria-hidden />
        Download
      </button>
    </Centered>
  )
}

/** Open files in the viewer from anywhere: `open(file)`, and render `viewer` once. */
export function useFileViewer(props?: Omit<FileViewerProps, 'file' | 'onClose'>) {
  const [file, setFile] = React.useState<ViewerFile | null>(null)
  const close = React.useCallback(() => setFile(null), [])
  const viewer = <FileViewer file={file} onClose={close} {...props} />
  return { open: setFile, close, file, viewer }
}
