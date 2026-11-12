/**
 * Cross-platform file download.
 *
 * Inside the Tauri desktop shell, the WKWebView has no download handler and
 * new-window requests are denied — `window.open(url)` and anchor `download`
 * clicks are silently dropped. So downloads are fetched in-page (auth cookies
 * flow with the request) and the bytes are handed to a native save dialog on
 * desktop, or to a blob-anchor click in the browser.
 */

import { isDesktopApp } from './platform'
import { tauriBridge } from './tauri-bridge'

/** Pull the filename out of a Content-Disposition header, if present. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  // RFC 5987 form: filename*=UTF-8''some%20name.md
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)
  if (star) {
    const raw = star[1].trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : null
}

/**
 * Download `url` and save it as a file (`init`: a POST that names what to
 * export, a table view's).
 *
 * Returns where the file went (a path on desktop, the filename in a browser),
 * or null if the user cancelled the desktop save dialog. Throws on HTTP or
 * save errors with a user-presentable message.
 */
export async function downloadFile(url: string, fallbackName: string, init?: RequestInit): Promise<string | null> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let message = `Download failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: string; message?: string }
      if (body.error || body.message) message = body.error ?? body.message ?? message
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message)
  }

  const fileName =
    filenameFromContentDisposition(res.headers.get('Content-Disposition')) ?? fallbackName
  const buffer = await res.arrayBuffer()

  if (isDesktopApp()) {
    try {
      return await tauriBridge.saveFile(fileName, Array.from(new Uint8Array(buffer)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/not found|unknown/i.test(message)) {
        throw new Error('Saving files needs a newer Native Intelligence desktop app — please update.')
      }
      throw new Error(message)
    }
  }

  const blobUrl = URL.createObjectURL(new Blob([buffer]))
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(blobUrl)
  return fileName
}
