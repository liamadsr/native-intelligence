'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Download, FileText, Loader2, Paperclip, Plus, X, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { downloadFile } from '@/lib/download'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import type { AttachmentItem } from '@/app/account/(dashboard)/views/capture-utils'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel'
import { cn } from '@/lib/utils'

interface AttachmentsCarouselProps {
  captureId?: string
  actionId?: string
  /** Incremented externally to trigger a refresh (e.g. after upload) */
  refreshKey?: number
  /** Called when the "Add" button is clicked */
  onAddClick?: () => void
  /** Whether an upload is in progress */
  uploading?: boolean
  /**
   * `card` (default) renders the standalone titled card.
   * `row` renders a collapsible property row — an expand toggle plus an add
   * button — for use inside a Properties group, matching Participants.
   */
  variant?: 'card' | 'row'
  /**
   * Horizontal padding of the `row` variant, so it lines up with the sibling
   * rows of whichever panel mounts it. The panels use two conventions: `px-3`
   * (capture, document) and `px-2` (action, initiative, contact).
   */
  padding?: 'px-2' | 'px-3'
}

export function AttachmentsCarousel({ captureId, actionId, refreshKey = 0, onAddClick, uploading, variant = 'card', padding = 'px-2' }: AttachmentsCarouselProps) {
  const [expanded, setExpanded] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({})
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  // Fetch attachments
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const param = captureId ? `note_id=${captureId}` : `action_id=${actionId}`
    fetch(`/api/account/attachments?${param}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data) => {
        if (cancelled || !data?.attachments) {
          if (!cancelled) setLoading(false)
          return
        }

        const items = data.attachments as AttachmentItem[]
        if (!cancelled) setAttachments(items)

        // Generate signed URLs for images
        const imageItems = items.filter(
          (item) => item.file_category === 'image' && item.storage_path,
        )
        if (imageItems.length > 0) {
          const supabase = createClient()
          const results = await Promise.all(
            imageItems.map(async (item) => {
              const { data: urlData } = await supabase.storage
                .from('attachments')
                .createSignedUrl(item.storage_path!, 3600)
              return { id: item.id, url: urlData?.signedUrl || null }
            }),
          )
          if (!cancelled) {
            const urls: Record<string, string> = {}
            for (const r of results) {
              if (r.url) urls[r.id] = r.url
            }
            setSignedUrls(urls)
          }
        }

        if (!cancelled) setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [captureId, actionId, refreshKey])

  // Only images for the lightbox
  const imageAttachments = attachments.filter((a) => a.file_category === 'image')

  // The row can sit in the card's properties popover, which keeps its content
  // mounted but hidden (an Activity) while closed. Hiding cleans up effects:
  // the viewer closes with the popover, never coming back on the next hover.
  useEffect(() => () => setLightboxIndex(null), [])

  // Keyboard navigation for lightbox. The window's capture phase, ahead of
  // everything else: the viewer is on top, so its keys are its own (Escape
  // closes it, not the popover under it too).
  useEffect(() => {
    if (lightboxIndex === null) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setLightboxIndex((i) =>
          i !== null && i > 0 ? i - 1 : i,
        )
      } else if (e.key === 'ArrowRight') {
        setLightboxIndex((i) =>
          i !== null && i < imageAttachments.length - 1 ? i + 1 : i,
        )
      } else if (e.key === 'Escape') {
        setLightboxIndex(null)
      } else {
        return
      }
      e.stopPropagation()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [lightboxIndex, imageAttachments.length])

  const handleDownload = useCallback(async (item: AttachmentItem) => {
    if (!item.storage_path) return
    const supabase = createClient()
    const { data } = await supabase.storage
      .from('attachments')
      .createSignedUrl(item.storage_path, 60)
    if (data?.signedUrl) {
      try {
        await downloadFile(data.signedUrl, item.file_name)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Download failed')
      }
    }
  }, [])

  const [pendingDelete, setPendingDelete] = useState<AttachmentItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const performDelete = useCallback(async (item: AttachmentItem) => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/account/attachments/${item.id}`, { method: 'DELETE' })
      if (res.ok) {
        setAttachments((prev) => prev.filter((a) => a.id !== item.id))
        toast.success('Attachment deleted')
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error(body?.error ?? 'Delete failed')
      }
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }, [])

  // The scrollable strip of thumbnails, shared by both variants.
  const carousel = (
    attachments.length > 0 && <div className="relative px-3 pb-3">
          <Carousel opts={{ align: 'start', dragFree: true }}>
            <CarouselContent className="-ml-2">
              {attachments.map((item, i) => (
                <CarouselItem key={item.id} className="pl-2 basis-auto">
                  <div className="group/item relative">
                    {item.file_category === 'image' ? (
                      <button
                        onClick={() => {
                          const imgIdx = imageAttachments.findIndex((a) => a.id === item.id)
                          if (imgIdx >= 0) setLightboxIndex(imgIdx)
                        }}
                        className="relative h-20 w-20 overflow-hidden rounded-md border bg-muted transition-opacity hover:opacity-80"
                      >
                        {signedUrls[item.id] ? (
                          <img
                            src={signedUrls[item.id]}
                            alt={item.file_name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            <div className="h-4 w-4 animate-pulse rounded bg-muted-foreground/20" />
                          </div>
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={() => handleDownload(item)}
                        className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-md border bg-muted/50 text-muted-foreground transition-colors hover:bg-muted"
                      >
                        <FileText className="h-5 w-5" />
                        <span className="max-w-[72px] truncate text-[10px]">
                          {item.file_name}
                        </span>
                        <Download className="h-3 w-3 opacity-50" />
                      </button>
                    )}
                    {/* Inside the card bounds — the embla viewport is
                        overflow-hidden, so an outset badge gets clipped */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDelete(item)
                      }}
                      className="absolute top-1 right-1 z-10 hidden h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm group-hover/item:flex hover:text-destructive"
                      aria-label={`Delete ${item.file_name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            {attachments.length > 4 && (
              <>
                <CarouselPrevious className="absolute -left-1 top-1/2 -translate-y-1/2 h-7 w-7" />
                <CarouselNext className="absolute -right-1 top-1/2 -translate-y-1/2 h-7 w-7" />
              </>
            )}
          </Carousel>
        </div>
  )

  return (
    <>
      {variant === 'row' ? (
        /* Property row — mirrors Participants: a expand/collapse toggle on the
           left, an add button on the right, thumbnails revealed below. */
        <div>
          <div className="flex items-center">
            <button
              onClick={() => setExpanded((v) => !v)}
              disabled={attachments.length === 0}
              className={cn(
                'flex h-8 flex-1 items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted/50 disabled:hover:bg-transparent',
                padding,
              )}
            >
              <Paperclip className="h-4 w-4 shrink-0" />
              <span>
                {loading
                  ? 'Attachments'
                  : attachments.length === 0
                    ? 'No attachments'
                    : `${attachments.length} ${attachments.length === 1 ? 'attachment' : 'attachments'}`}
              </span>
              {attachments.length > 0 &&
                (expanded ? (
                  <ChevronDown className="ml-auto h-3 w-3" />
                ) : (
                  <ChevronRight className="ml-auto h-3 w-3" />
                ))}
            </button>
            {onAddClick && (
              <button
                onClick={onAddClick}
                disabled={uploading}
                className="mr-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80 disabled:opacity-50"
                title="Add attachment"
              >
                {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
          {expanded && carousel}
        </div>
      ) : (
        <div className="rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2">
            <div className="text-sm font-medium text-muted-foreground">
              Attachments
              {attachments.length > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground/60">{attachments.length}</span>
              )}
            </div>
            {onAddClick && (
              <button
                onClick={onAddClick}
                disabled={uploading}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted hover:border-foreground/30 transition-colors disabled:opacity-50"
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                Add
              </button>
            )}
          </div>
          {carousel}
        </div>
      )}

      {/* Fullscreen lightbox — portalled to body to escape panel stacking context */}
      {lightboxIndex !== null && imageAttachments[lightboxIndex] && createPortal(
        <Lightbox
          images={imageAttachments}
          signedUrls={signedUrls}
          currentIndex={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />,
        document.body,
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
        title="Delete attachment"
        description={`This permanently deletes "${pendingDelete?.file_name ?? ''}" — the file, its search index, and its knowledge-graph links.`}
        busy={deleting}
        onConfirm={() => {
          if (pendingDelete) void performDelete(pendingDelete)
        }}
      />
    </>
  )
}

// ── Lightbox overlay ────────────────────────────────────────────

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25

function Lightbox({
  images,
  signedUrls,
  currentIndex,
  onIndexChange,
  onClose,
}: {
  images: AttachmentItem[]
  signedUrls: Record<string, string>
  currentIndex: number
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const current = images[currentIndex]
  const url = current ? signedUrls[current.id] : null
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1
  const isZoomed = zoom !== 1

  // Reset zoom/pan when image changes
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [currentIndex])

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(z - ZOOM_STEP, ZOOM_MIN)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  const handleResetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  // Mouse wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
    setZoom((z) => {
      const next = Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

  // Pan via drag when zoomed
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (zoom <= 1) return
    e.preventDefault()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [zoom, pan])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    })
  }, [dragging])

  const handlePointerUp = useCallback(() => {
    setDragging(false)
  }, [])

  // Double-click to toggle zoom
  const handleDoubleClick = useCallback(() => {
    if (zoom > 1) {
      setZoom(1)
      setPan({ x: 0, y: 0 })
    } else {
      setZoom(2)
    }
  }, [zoom])

  return (
    <div
      ref={overlayRef}
      // A dialog: the properties popover it opens from counts a press in a
      // dialog as its own (window-properties.tsx isPickerSurface), so the
      // close button closes this, not the popover. Above the popover too.
      role="dialog"
      aria-modal="true"
      aria-label="Attachment viewer"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      {/* Top-left: zoom controls */}
      <div className="absolute top-8 left-4">
        <div className="h-8 inline-flex items-center gap-0.5 rounded-full bg-white/10 px-1">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Zoom out"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleResetZoom}
            className="h-6 min-w-[3rem] inline-flex items-center justify-center rounded-full px-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            title="Reset zoom"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
            title="Zoom in"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Top-center: counter */}
      {images.length > 1 && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 h-8 inline-flex items-center rounded-full bg-white/10 px-3 text-xs text-white/70">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Top-right: close */}
      <button
        onClick={onClose}
        className="absolute top-8 right-4 h-8 w-8 inline-flex items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Previous */}
      {hasPrev && (
        <button
          onClick={() => onIndexChange(currentIndex - 1)}
          className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {/* Image with zoom + pan */}
      {url ? (
        <div
          className="flex items-center justify-center overflow-hidden"
          style={{ width: '70vw', height: '70vh' }}
          onWheel={handleWheel}
        >
          <img
            src={url}
            alt={current?.file_name || ''}
            className={cn(
              'max-h-[70vh] max-w-[70vw] rounded-lg object-contain select-none',
              isZoomed ? 'cursor-grab' : 'cursor-zoom-in',
              dragging && 'cursor-grabbing',
            )}
            style={{
              transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              transition: dragging ? 'none' : 'transform 0.15s ease-out',
            }}
            draggable={false}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onDoubleClick={handleDoubleClick}
          />
        </div>
      ) : (
        <div className="flex h-40 w-40 items-center justify-center rounded-lg bg-white/5">
          <div className="h-8 w-8 animate-pulse rounded bg-white/10" />
        </div>
      )}

      {/* Next */}
      {hasNext && (
        <button
          onClick={() => onIndexChange(currentIndex + 1)}
          className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>
  )
}
