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

/**
 * A made-up pointer that goes once round the recording's edges in `seconds`: along the top, the right, the bottom and
 * the left, through every corner, its tip between 1 point outside the picture and 5 points inside it, clicking every
 * `clickEveryMs`.
 */
export function edgeTrace(seconds: number, viewport: { width: number; height: number; scale: number }, clickEveryMs = 900, firstClickMs = 300) {
  const { width: w, height: h } = viewport, perimeter = 2 * (w + h), cursor: [number, number, number][] = []
  for (let t = 0; t <= seconds * 1000; t += 8) {
    const u = (t / (seconds * 1000)) * perimeter, d = 2 + 3 * Math.sin(t / 170)
    const [x, y] = u < w ? [u, d] : u < w + h ? [w - d, u - w] : u < 2 * w + h ? [w - (u - w - h), h - d] : [d, h - (u - 2 * w - h)]
    cursor.push([t, x, y])
  }
  const actions = Array.from({ length: Math.max(0, Math.floor((seconds * 1000 - firstClickMs) / clickEveryMs) + 1) }, (_, i) =>
    ({ t: firstClickMs + i * clickEveryMs, end: firstClickMs + i * clickEveryMs + 80, kind: 'click', label: 'Click', box: null }))
  return { viewport, cursor, actions }
}
