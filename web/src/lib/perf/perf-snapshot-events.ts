/**
 * The desktop main window's `perf_snapshot` event (Liam, 10-19): every 30
 * minutes the window is up, the page snapshot's counts go to PostHog, so a
 * window that slows over a day says what piled up without anyone opening Web
 * Inspector. Numbers only: no labels, ids, names or text (the snapshot's
 * `body`, `widest`, animation names and channel topics stay on the page).
 *
 * Only the main window: the HUD and the workspace windows (`workspace-<id>`)
 * would each send their own, and the browser never does.
 */
import { isDesktopApp } from '@/lib/platform'
import type { PerfSnapshot } from './perf-snapshot'

export const PERF_SNAPSHOT_EVENT = 'perf_snapshot'

/** How often the main window sends one. */
export const PERF_SNAPSHOT_EVERY_MS = 30 * 60_000

/** The Tauri window this page runs in, or null outside the desktop app. */
function desktopWindowLabel(): string | null {
  if (!isDesktopApp()) return null
  const internals = window.__TAURI_INTERNALS__ as { metadata?: { currentWindow?: { label?: unknown } } } | undefined
  const label = internals?.metadata?.currentWindow?.label
  return typeof label === 'string' ? label : null
}

/** In the desktop app's main window. */
export function isDesktopMainWindow(): boolean {
  return desktopWindowLabel() === 'main'
}

/** The snapshot as flat numbers, PostHog's property names. */
export function perfSnapshotProperties(s: PerfSnapshot): Record<string, number> {
  return {
    uptime_min: s.uptimeMin,
    elements: s.elements,
    svg_elements: s.svgElements,
    hidden_elements: s.hiddenElements,
    shadow_roots: s.shadow.roots,
    shadow_elements: s.shadow.elements,
    card_count: s.pages.cards,
    parked_pages: s.pages.parked,
    parked_elements: s.pages.parkedElements,
    dormant_pages: s.pages.dormant,
    dormant_elements: s.pages.dormantElements,
    full_screen_cards: s.pages.fullScreen,
    docked_cards: s.pages.docked,
    inline_cards: s.pages.inline,
    inline_asleep_pages: s.pages.inlineAsleep,
    inline_asleep_elements: s.pages.inlineAsleepElements,
    card_pills: s.pages.pills,
    chat_messages: s.chat.messages,
    chat_elements: s.chat.elements,
    capture_panels: s.capturePanels.count,
    capture_panel_elements: s.capturePanels.elements,
    animations: s.animations.total,
    animations_running: s.animations.running,
    animations_infinite: s.animations.infinite,
    animations_finished: s.animations.finished,
    animations_parked: s.animations.parked,
    canvases: s.canvases.count,
    canvas_megapixels: s.canvases.megapixels,
    iframes: s.media.iframes,
    images: s.media.images,
    style_sheets: s.styles.sheets,
    style_rules: s.styles.rules,
    has_rules: s.styles.hasRules,
    style_tags: s.styles.styleTags,
    realtime_channels: s.realtime?.channels ?? -1,
    body_children: s.body.length,
    widest_list: s.widest[0]?.children ?? 0,
    ...(s.heapMB !== undefined ? { heap_mb: s.heapMB } : {}),
  }
}

/**
 * Sends `perf_snapshot` every PERF_SNAPSHOT_EVERY_MS from the desktop main
 * window (anywhere else: nothing, not even a timer). Returns its stop.
 */
export function startPerfSnapshotEvents(
  capture: (event: string, properties: Record<string, number | string>) => void,
  take: () => PerfSnapshot,
): () => void {
  if (!isDesktopMainWindow()) return () => {}
  const timer = window.setInterval(() => {
    try {
      capture(PERF_SNAPSHOT_EVENT, { ...perfSnapshotProperties(take()), window: 'main' })
    } catch {
      // A snapshot that failed says nothing worth sending.
    }
  }, PERF_SNAPSHOT_EVERY_MS)
  return () => window.clearInterval(timer)
}
