'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface AttachmentImage {
  url: string
  name: string
  captureId?: string | null
  actionId?: string | null
}

interface AttachmentImagePreviewProps {
  images: AttachmentImage[]
}

export function AttachmentImagePreview({ images }: AttachmentImagePreviewProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  if (images.length === 0) return null

  const current = images[currentIndex]
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  return (
    <>
      <div className="pl-6">
        {/* Image preview with carousel controls */}
        <div className="relative inline-block">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="block cursor-zoom-in"
          >
            <img
              src={current.url}
              alt={current.name}
              className="max-h-64 max-w-sm rounded-lg border border-border shadow-sm transition-opacity hover:opacity-90"
            />
          </button>

          {/* Carousel nav arrows */}
          {images.length > 1 && (
            <>
              {hasPrev && (
                <button
                  onClick={() => setCurrentIndex((i) => i - 1)}
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white transition-colors hover:bg-black/70"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              )}
              {hasNext && (
                <button
                  onClick={() => setCurrentIndex((i) => i + 1)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-1 text-white transition-colors hover:bg-black/70"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
              {/* Counter */}
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] text-white">
                {currentIndex + 1} / {images.length}
              </div>
            </>
          )}
        </div>

        {/* File name */}
        <div className="mt-1.5 text-xs text-muted-foreground">
          <span className="truncate max-w-[200px]">{current.name}</span>
        </div>
      </div>

      {/* Fullscreen lightbox */}
      {lightboxOpen && createPortal(
        <ImageLightbox
          images={images}
          currentIndex={currentIndex}
          onIndexChange={setCurrentIndex}
          onClose={() => setLightboxOpen(false)}
        />,
        document.body,
      )}
    </>
  )
}

// ── Lightbox overlay ────────────────────────────────────────────

const ZOOM_MIN = 0.25
const ZOOM_MAX = 5
const ZOOM_STEP = 0.25

function ImageLightbox({
  images,
  currentIndex,
  onIndexChange,
  onClose,
}: {
  images: AttachmentImage[]
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
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1
  const isZoomed = zoom !== 1

  // Reset zoom/pan when image changes
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [currentIndex])

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(currentIndex - 1)
      else if (e.key === 'ArrowRight' && hasNext) onIndexChange(currentIndex + 1)
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [currentIndex, hasPrev, hasNext, onIndexChange, onClose])

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

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
    setZoom((z) => {
      const next = Math.min(Math.max(z + delta, ZOOM_MIN), ZOOM_MAX)
      if (next <= 1) setPan({ x: 0, y: 0 })
      return next
    })
  }, [])

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose()
      }}
    >
      {/* Top-left: zoom controls */}
      <div className="absolute top-8 left-4 z-10">
        <div className="h-8 inline-flex items-center gap-0.5 rounded-full bg-white/10 px-1">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleResetZoom}
            className="h-6 min-w-[3rem] inline-flex items-center justify-center rounded-full px-1 text-[11px] font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            className="h-6 w-6 inline-flex items-center justify-center rounded-full text-white/70 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Top-center: counter */}
      {images.length > 1 && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 z-10 h-8 inline-flex items-center rounded-full bg-white/10 px-3 text-xs text-white/70">
          {currentIndex + 1} / {images.length}
        </div>
      )}

      {/* Top-right: close */}
      <button
        onClick={onClose}
        className="absolute top-8 right-4 z-10 h-8 w-8 inline-flex items-center justify-center rounded-full bg-white/10 text-white/70 transition-colors hover:bg-white/20 hover:text-white"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Previous */}
      {hasPrev && (
        <button
          onClick={() => onIndexChange(currentIndex - 1)}
          className="absolute left-4 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}

      {/* Image with zoom + pan */}
      <div
        className="flex items-center justify-center overflow-hidden"
        style={{ width: '70vw', height: '70vh' }}
        onWheel={handleWheel}
      >
        <img
          src={current.url}
          alt={current.name}
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

      {/* Next */}
      {hasNext && (
        <button
          onClick={() => onIndexChange(currentIndex + 1)}
          className="absolute right-4 top-1/2 -translate-y-1/2 z-10 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>
  )
}
