'use client'

/**
 * A Word .docx, read in the browser: mammoth (BSD-2) turns it into plain HTML
 * (headings, paragraphs, lists, tables, pictures as data: images), and
 * DOMPurify keeps only harmless markup (no script, no styles, no frames, no
 * links that run code) before it is shown.
 */
import * as React from 'react'
import DOMPurify from 'dompurify'
import { Loader2 } from 'lucide-react'

/** The sanitized HTML of a converted document: links open in a new tab and never reach back to the page. */
export function sanitizeDocxHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
    FORBID_ATTR: ['style', 'class', 'id'],
    ALLOW_DATA_ATTR: false,
  })
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html')
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer nofollow')
  }
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    // Only the document's own pictures (data: URIs); never a remote fetch that tells a sender it was read.
    if (!(img.getAttribute('src') ?? '').startsWith('data:image/')) img.remove()
  }
  return doc.body.firstElementChild?.innerHTML ?? ''
}

export default function DocxViewer({ blob, onDownload }: { blob: Blob; onDownload: () => void }) {
  const [html, setHtml] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let live = true
    void (async () => {
      try {
        const mammoth = (await import('mammoth')).default
        const result = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() })
        if (live) setHtml(sanitizeDocxHtml(result.value))
      } catch {
        if (live) setError('This document could not be read. It may not be a Word (.docx) file.')
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
  if (html === null)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    )
  return (
    <div className="h-full overflow-auto">
      <article
        data-file-viewer-docx=""
        className={[
          'mx-auto my-6 max-w-3xl rounded-lg bg-white px-10 py-12 text-sm leading-6 text-neutral-900 shadow-sm dark:bg-neutral-900 dark:text-neutral-100',
          '[&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold',
          '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mt-3 [&_h4]:font-semibold [&_p]:my-2',
          '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:text-blue-600 [&_a]:underline',
          '[&_img]:max-w-full [&_table]:my-3 [&_table]:border-collapse [&_td]:border [&_td]:border-neutral-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-neutral-300 [&_th]:px-2 [&_th]:py-1',
        ].join(' ')}
        dangerouslySetInnerHTML={{ __html: html || '<p><em>This document is empty.</em></p>' }}
      />
    </div>
  )
}
