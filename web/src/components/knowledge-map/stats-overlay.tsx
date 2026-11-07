'use client'

/**
 * Dev/benchmark overlay: what the last frame actually cost.
 *
 * Two numbers matter more than the rest and are placed first. `drawCalls`
 * proves the O(resident tiles) contract — if it ever tracks node count, the
 * per-tile instancing has regressed to per-node draws. `fps` is measured over
 * RENDERED frames (see FpsMeter), because a render-on-demand map is idle most
 * of the time and wall-clock fps would read as 0 on a perfectly healthy map.
 *
 * Rendered from React state at most once per frame, and only when `showStats`
 * is on, so it costs nothing in production.
 *
 * `showStats` is not free, though: the shell calls `renderer.syncForTiming()`
 * to fill `syncedFrameMs`, which forces a GPU sync EVERY FRAME (a 1×1
 * readPixels). That is the stall this architecture exists to avoid — it is a
 * benchmark instrument, so only the dev bench at /dev/knowledge-map turns
 * `showStats` on, never the app. The same flag gates the `__kmStats` /
 * `__kmDebug` / `__kmFrameLog` window probes the automated tour reads.
 */

export interface MapStats {
  fps: number
  frameMs: number
  /** CPU + GPU cost of the frame, measured with a forced GPU sync (dev only). */
  syncedFrameMs: number
  residentTiles: number
  drawnTiles: number
  nodes: number
  edges: number
  drawCalls: number
  labels: number
  /** Continuous zoom level. */
  zc: number
  /** CSS px per world unit. */
  k: number
}

export function StatsOverlay({ stats }: { stats: MapStats }) {
  return (
    <div
      // `pointer-events-none` so the overlay never eats a pan that starts
      // under it. No backdrop-filter: this sits inside the dashboard's own
      // glass panel and a second blur layer there is both wasteful and,
      // stacked, visibly wrong.
      className="pointer-events-none absolute right-2 top-2 select-none rounded-md border border-border/60 bg-background/80 px-2.5 py-2 font-mono text-[10px] leading-[1.45] text-muted-foreground"
      data-testid="knowledge-map-stats"
    >
      <Row label="fps" value={stats.fps.toFixed(1)} />
      <Row label="draws" value={String(stats.drawCalls)} />
      <Row label="frame" value={`${stats.frameMs.toFixed(1)} ms`} />
      <Row label="cpu+gpu" value={`${stats.syncedFrameMs.toFixed(1)} ms`} />
      <Row label="tiles" value={`${stats.drawnTiles}/${stats.residentTiles}`} />
      <Row label="nodes" value={format(stats.nodes)} />
      <Row label="edges" value={format(stats.edges)} />
      <Row label="labels" value={String(stats.labels)} />
      <Row label="z" value={stats.zc.toFixed(2)} />
      <Row label="k" value={stats.k.toFixed(3)} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 tabular-nums">
      <span className="opacity-60">{label}</span>
      <span className="text-foreground/80">{value}</span>
    </div>
  )
}

function format(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
