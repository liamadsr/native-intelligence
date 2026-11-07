/**
 * Minimal heartbeat worker.
 *
 * Browsers throttle `setInterval` / `setTimeout` on the main thread when a page
 * is hidden or its window is occluded — clamping them to as little as one tick
 * per minute. In the desktop app that throttling is what kills live
 * transcription: when another window (e.g. a video-call app) fully covers
 * Dial8, the WebView's main-thread timers stall, so the 8-second Deepgram
 * KeepAlive stops firing and Deepgram closes the idle stream.
 *
 * Worker timers are NOT subject to that visibility/occlusion throttling, so a
 * worker that simply posts a tick on a fixed interval keeps the main thread's
 * keep-alive cadence honest even while the page is in the background.
 *
 * Protocol:
 *   main → worker: { type: 'start', intervalMs }   begin ticking
 *   main → worker: { type: 'stop' }                stop ticking
 *   worker → main: { type: 'tick' }                emitted every intervalMs
 */

export interface HeartbeatStartRequest {
  type: 'start'
  intervalMs: number
}
export interface HeartbeatStopRequest {
  type: 'stop'
}
export type HeartbeatRequest = HeartbeatStartRequest | HeartbeatStopRequest

export interface HeartbeatTick {
  type: 'tick'
}

// Inside a worker, `self` is the global scope (typed here via the DOM lib, the
// same way voice-embedding-worker.ts does). postMessage/onmessage resolve to
// the worker's globals at runtime.
let timer: ReturnType<typeof setInterval> | null = null

self.onmessage = (e: MessageEvent<HeartbeatRequest>) => {
  const msg = e.data
  if (msg.type === 'start') {
    if (timer) clearInterval(timer)
    timer = setInterval(() => {
      self.postMessage({ type: 'tick' } satisfies HeartbeatTick)
    }, msg.intervalMs)
  } else if (msg.type === 'stop') {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
