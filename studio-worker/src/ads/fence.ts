/**
 * The fence around every page the worker draws its own HTML in (the ads, the reel's type layer, the contact sheet).
 *
 * A page is never opened from file://. It is served from a made-up origin (PAGE_ORIGIN) whose every address is a file
 * in the job's own scratch folder, answered by the worker through the browser's request interception: a page can
 * read the files the job staged there and nothing else, not the asset cache, not another job's scratch, not the
 * worker's own files. Every other request (another origin, any network address, a WebSocket) is refused before it
 * leaves the browser, and the browser itself is started with no route to any network (browser.ts) as a second fence.
 */
import { realpath, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import type { Browser, BrowserContext, Page, Route } from 'playwright-core'

/** The made-up origin the pages are served from (.invalid never resolves). */
export const PAGE_ORIGIN = 'http://studio-job.invalid'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
}

/** The address a file inside `root` is served at. Throws for a file outside it. Pure. */
export function pageUrl(root: string, file: string): string {
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is not in the job's folder`)
  return `${PAGE_ORIGIN}/${rel.split(sep).map(encodeURIComponent).join('/')}`
}

/**
 * The file inside `root` an address names, or null when it names none: another origin or scheme, a path segment
 * that is empty, `.` or `..` (also when written %2e%2e) or that holds a slash, a backslash or a NUL. Pure (the served
 * file is checked again on disk: no link may lead out of the folder).
 */
export function fileForUrl(root: string, address: string): string | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.origin !== PAGE_ORIGIN || url.username || url.password) return null
  const raw = url.pathname.split('/').slice(1)
  if (!raw.length) return null
  const parts: string[] = []
  for (const segment of raw) {
    let part: string
    try {
      part = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (!part || part === '.' || part === '..' || /[/\\\0]/.test(part)) return null
    parts.push(part)
  }
  const file = join(root, ...parts)
  const rel = relative(root, file)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? file : null
}

/** What a page asked for and whether it got it, for the job log and the tests. */
export type FenceLog = { url: string; served: boolean }[]

/** Answer every request of `target` from `root` (PAGE_ORIGIN) or refuse it. */
export async function fence(target: Page | BrowserContext, root: string, log?: FenceLog): Promise<void> {
  const realRoot = await realpath(root)
  await target.route('**/*', async (route: Route) => {
    const url = route.request().url()
    const file = fileForUrl(root, url)
    if (file) {
      try {
        const real = await realpath(file)
        const rel = relative(realRoot, real)
        if (rel && !rel.startsWith('..') && !isAbsolute(rel) && (await stat(real)).isFile()) {
          log?.push({ url, served: true })
          return await route.fulfill({ status: 200, contentType: TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream', body: await readFile(real) })
        }
      } catch {
        // not there: refused below
      }
    }
    log?.push({ url, served: false })
    await route.abort('blockedbyclient').catch(() => undefined)
  })
  await target.routeWebSocket(/.*/, (ws) => void ws.close().catch(() => undefined))
}

/**
 * A page in a context of its own, fenced to `root`: no service workers, no downloads; closing the page closes its
 * context.
 */
export async function fencedPage(browser: Browser, root: string, opts: { viewport?: { width: number; height: number }; deviceScaleFactor?: number; log?: FenceLog } = {}): Promise<Page> {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, deviceScaleFactor: opts.deviceScaleFactor ?? 1, ...(opts.viewport ? { viewport: opts.viewport } : {}) })
  try {
    await fence(context, root, opts.log)
    const page = await context.newPage()
    page.on('close', () => void context.close().catch(() => undefined))
    return page
  } catch (err) {
    await context.close().catch(() => undefined)
    throw err
  }
}
