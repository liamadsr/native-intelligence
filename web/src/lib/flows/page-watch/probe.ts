/**
 * The check a page watch gets when it is saved: read the page once, the way
 * the watch pass will (./read-page.ts), and say whether there is text to
 * watch. A page that builds itself in the browser comes back as a near-empty
 * shell to a plain fetch, and a watch on it would never see anything change,
 * so the person is told now rather than left waiting, and pointed at the
 * browser read (phase 2: read-browser.ts), which can see such a page.
 */
import 'server-only'
import { readWatchPage, type FetchPage } from './read-page'
import { PAGE_WATCH_MIN_LINES } from './url'

export { PAGE_WATCH_MIN_LINES }

export async function probeWatchPage(
  url: string,
  deps: { fetchPage?: FetchPage } = {},
): Promise<{ ok: true; lineCount: number } | { ok: false; reason: string }> {
  const read = await readWatchPage(url, deps)
  if (!read.ok) return read
  if (read.lines.length < PAGE_WATCH_MIN_LINES) {
    return { ok: false, reason: 'This page shows its content only in a browser. Switch on "Read it in my browser" to watch it there.' }
  }
  return { ok: true, lineCount: read.lines.length }
}
