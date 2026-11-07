'use client'

/**
 * Coordination bus between the recording layer (which GUARANTEES the
 * end-of-meeting batch extraction runs, even if nothing is on screen) and the
 * capture detail panel (which, when mounted on that capture, renders the
 * extraction as a live Granola-style stream).
 *
 * The contract avoids running the SAME extraction twice (once guaranteed by the
 * recording layer, once as the panel's stream — that would double the LLM cost):
 *
 *   1. While a capture detail panel is mounted, it REGISTERS its captureId here
 *      (synchronous — no event race).
 *   2. On Stop (live mode off), the recording layer checks `hasStreamingPanel`:
 *        • registered  → dispatch `dial8:stream-extraction`; the panel runs the
 *          stream and owns completion. The recording layer SKIPS its own fetch.
 *        • not registered → the recording layer runs the guaranteed (non-stream)
 *          batch fetch exactly as before.
 *   3. The panel signals completion by dispatching `dial8:capture-ended`, which
 *      the recording layer already listens for to do post-extraction work
 *      (title generation, semantic indexing) at the correct time.
 *
 * Registration is a plain module-level Set: the recording provider and the
 * panel live in the same client bundle / window, so they share this module.
 */

const registered = new Set<string>()

export function registerStreamingPanel(captureId: string): void {
  registered.add(captureId)
}

export function unregisterStreamingPanel(captureId: string): void {
  registered.delete(captureId)
}

/** True when a capture detail panel for this capture is currently mounted. */
export function hasStreamingPanel(captureId: string): boolean {
  return registered.has(captureId)
}

export type StreamExtractionDetail = {
  captureId: string
  mode: 'batch' | 'live'
  recipeId?: string
  recentChunks?: string[]
}

export const STREAM_EXTRACTION_EVENT = 'dial8:stream-extraction'

/** Ask the mounted panel to run a streaming extraction for this capture. */
export function requestStreamingExtraction(detail: StreamExtractionDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(STREAM_EXTRACTION_EVENT, { detail }),
  )
}
