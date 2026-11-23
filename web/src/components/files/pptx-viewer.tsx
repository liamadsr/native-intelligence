'use client'

/**
 * A PowerPoint .pptx, basic (lib/files/pptx-slides.ts): one card a slide, its
 * text in reading order (the first paragraph as its title), its pictures and
 * its speaker notes. The slide's own layout is not drawn; the header says
 * so and offers the file.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { readPptxSlides, slideImageType, type PptxDeck } from '@/lib/files/pptx-slides'

function SlideImage({ deck, path }: { deck: PptxDeck; path: string }) {
  const [url, setUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    const type = slideImageType(path)
    const part = deck.zip.file(path)
    if (!type || !part) return
    let u: string | null = null
    let live = true
    void part.async('uint8array').then((bytes) => {
      if (!live) return
      u = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
      setUrl(u)
    })
    return () => {
      live = false
      if (u) URL.revokeObjectURL(u)
    }
  }, [deck, path])
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="max-h-64 max-w-full rounded object-contain" /> : null
}

export default function PptxViewer({ blob, onDownload }: { blob: Blob; onDownload: () => void }) {
  const [deck, setDeck] = React.useState<PptxDeck | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let live = true
    void (async () => {
      try {
        const read = await readPptxSlides(await blob.arrayBuffer())
        if (live) setDeck(read)
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'This presentation could not be read.')
      }
    })()
    return () => {
      live = false
    }
  }, [blob])
  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-destructive">{error}</p>
        <button type="button" onClick={onDownload} className="text-xs text-muted-foreground underline hover:text-foreground">
          Download it
        </button>
      </div>
    )
  if (!deck)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    )
  return (
    <div className="h-full overflow-auto">
      <p className="mx-auto max-w-3xl px-4 pt-4 text-xs text-muted-foreground">
        A simple view of each slide’s words and pictures.{' '}
        <button type="button" onClick={onDownload} className="underline hover:text-foreground">
          Download
        </button>{' '}
        to see the slides as designed.
      </p>
      <ol className="mx-auto flex max-w-3xl flex-col gap-4 p-4" data-file-viewer-pptx="">
        {deck.slides.map((slide) => (
          <li key={slide.number} data-file-viewer-slide={slide.number} className="aspect-[16/9] overflow-hidden rounded-lg border border-border bg-white p-8 text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100">
            <div className="flex h-full flex-col gap-3 overflow-auto">
              <span className="text-[10px] uppercase tracking-wide text-neutral-400">Slide {slide.number}</span>
              {slide.paragraphs[0] && <h3 className="text-lg font-semibold">{slide.paragraphs[0]}</h3>}
              {slide.paragraphs.length > 1 && (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {slide.paragraphs.slice(1).map((p, i) => (
                    <li key={i} className="whitespace-pre-wrap">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
              {slide.images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {slide.images.map((path) => (
                    <SlideImage key={path} deck={deck} path={path} />
                  ))}
                </div>
              )}
              {slide.notes && <p className="mt-auto border-t border-neutral-200 pt-2 text-xs text-neutral-500 dark:border-neutral-700">Notes: {slide.notes}</p>}
            </div>
          </li>
        ))}
      </ol>
      {deck.truncated && <p className="pb-6 text-center text-xs text-muted-foreground">Only the first slides are shown.</p>}
    </div>
  )
}
