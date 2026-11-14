/** Made-up pointer traces for the tests and benches (no real recording's). */

/** The pointer a desktop recording carries: a trace in the recording's own points (here half its pixels), moving and clicking. */
export function madeUpTrace(seconds: number, viewport: { width: number; height: number; scale: number }, clickEveryMs = 1300, firstClickMs = 650) {
  const cursor: [number, number, number][] = []
  for (let t = 0; t <= seconds * 1000; t += 8) {
    const s = t / 1000
    cursor.push([t, viewport.width * (0.5 + 0.38 * Math.sin(s * 0.9)), viewport.height * (0.5 + 0.36 * Math.sin(s * 1.37 + 0.6))])
  }
  const actions = Array.from({ length: Math.max(0, Math.floor((seconds * 1000 - firstClickMs) / clickEveryMs) + 1) }, (_, i) =>
    ({ t: firstClickMs + i * clickEveryMs, end: firstClickMs + i * clickEveryMs + 80, kind: 'click', label: 'Click', box: null }))
  return { viewport, cursor, actions }
}
