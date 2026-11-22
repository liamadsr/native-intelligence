/**
 * Artifacts: a small self-contained HTML page as an item on the canvas.
 *
 * An artifact is someone's (usually an agent's) markup and script, so it is
 * never part of the app's own page. It is drawn in a frame with no origin
 * (`sandbox="allow-scripts"` and nothing else): it cannot read the app's
 * cookies, storage or DOM, open windows, submit forms or move the top page.
 * The document it is given starts with a policy of its own that turns the
 * network off: scripts and styles written in the page run; images, fonts and
 * media only from data: URLs; no fetch, no frames, no forms, no base.
 *
 * What is left: a frame may still send ITSELF somewhere (location = ...),
 * which no policy a page can state forbids. The view counts the frame's loads
 * and takes an artifact that loads a second time off the screen. So an
 * artifact can give away what is written in it and nothing else; treat its
 * contents as readable by whoever wrote it.
 */
import type { ArtifactItem, CanvasItem } from '../types'
import type { Scene } from './scene'

export const ARTIFACT_LIMITS = { html: 200_000, title: 120, minW: 120, minH: 80 } as const
export const ARTIFACT_DEFAULT_SIZE = { w: 480, h: 320 } as const

/** What the frame may do: run script. Not same-origin, not forms, popups, downloads or top navigation. */
export const ARTIFACT_SANDBOX = 'allow-scripts'

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/**
 * The document the frame is given. The policy is the first thing in it, ahead
 * of anything the artifact wrote, so nothing of the artifact's is read before
 * the policy applies; a policy the artifact states itself can only narrow it.
 */
export function artifactDocument(html: string, opts: { dark?: boolean } = {}): string {
  const body = typeof html === 'string' ? html.slice(0, ARTIFACT_LIMITS.html) : ''
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="color-scheme" content="${opts.dark ? 'dark' : 'light'}">` +
    `<style>html{height:100%}body{margin:0;min-height:100%;padding:12px;box-sizing:border-box;font:14px/1.5 system-ui,sans-serif;color:${opts.dark ? '#e5e5e5' : '#171717'};background:transparent;overflow:auto}</style>` +
    '</head><body>' +
    body +
    '</body></html>'
  )
}

/** A title fit to show: one line, trimmed, capped. */
export function artifactTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const t = title.replace(/\s+/g, ' ').trim().slice(0, ARTIFACT_LIMITS.title)
  return t || undefined
}

/**
 * The artifacts in the order they are presented: by their own present key
 * where one was set, the rest after them in reading order (top to bottom in
 * rows, left to right), so a board laid out as slides presents as it reads.
 */
export function presentOrder(scene: Scene): ArtifactItem[] {
  const all = Object.values(scene.items).filter((it): it is ArtifactItem => it.kind === 'artifact')
  const keyed = all.filter((a) => typeof a.presentOrder === 'string' && a.presentOrder).sort((a, b) => ((a.presentOrder as string) < (b.presentOrder as string) ? -1 : (a.presentOrder as string) > (b.presentOrder as string) ? 1 : a.id < b.id ? -1 : 1))
  const loose = all.filter((a) => !a.presentOrder)
  // Rows: two artifacts are on one row when their tops are within half the shorter one's height.
  loose.sort((a, b) => {
    const same = Math.abs(a.y - b.y) <= Math.min(a.h, b.h) / 2
    if (!same) return a.y - b.y
    return a.x - b.x || (a.id < b.id ? -1 : 1)
  })
  return [...keyed, ...loose]
}

export const isArtifact = (it: CanvasItem | undefined): it is ArtifactItem => !!it && it.kind === 'artifact'
