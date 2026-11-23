/**
 * A file as the in-app viewer takes it (components/files/file-viewer.tsx).
 * Each place that opens a file says how its bytes are read, with the
 * caller's own rights: Drive and team chat through a short signed URL their
 * bucket's read policy fences, a mail attachment through the mailbox's own
 * attachment route. The viewer itself never widens who reads a file: it only
 * renders what the caller could already download.
 */

import type { FileTarget } from '@/lib/drive/file-comments'

export interface ViewerFile {
  /** Stable key (an attachment id, a chat file path, a mail message + name). */
  key: string
  name: string
  mimeType?: string | null
  size?: number | null
  /** Where it came from, shown under the name ("Email · Re: Q3 plan"). */
  sourceLabel?: string | null
  /**
   * A URL the browser may stream directly (a short signed URL, a Figma link).
   * Video and audio play from it; the other viewers read its bytes.
   */
  url?: string | null
  /** Read the file's bytes, when there is no URL to read (a mail attachment). */
  load?: () => Promise<Blob>
  /** Saves the file; by default the viewer saves the bytes it read. */
  download?: () => Promise<void>
  /** A file that came from outside the workspace (a form's upload): download only, never rendered. */
  downloadOnly?: boolean
  /** The file comments are kept on (migration 711): an upload, or a chat file. A mail attachment has none. */
  commentTarget?: FileTarget | null
}

/** The bytes of a viewer file: its loader's, else its URL's (same-origin credentials go with it). */
export async function loadViewerBytes(file: ViewerFile, signal?: AbortSignal): Promise<Blob> {
  if (file.load) return file.load()
  if (!file.url) throw new Error('This file has no content to show.')
  const res = await fetch(file.url, { signal, credentials: 'same-origin' })
  if (!res.ok) {
    let message = `Could not read the file (${res.status})`
    try {
      const body = (await res.clone().json()) as { error?: unknown }
      if (typeof body?.error === 'string' && body.error) message = body.error
    } catch {
      /* not JSON */
    }
    throw new Error(message)
  }
  return res.blob()
}

/** A loader for a same-origin route that answers with the file's bytes (the mail attachment routes). */
export function routeLoader(url: string): () => Promise<Blob> {
  return async () => {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) {
      let message = res.status === 413 ? 'This file is too big to open here. Download it instead.' : `Could not read the file (${res.status})`
      try {
        const body = (await res.clone().json()) as { error?: unknown }
        if (typeof body?.error === 'string' && body.error) message = body.error
      } catch {
        /* not JSON */
      }
      throw new Error(message)
    }
    return res.blob()
  }
}
