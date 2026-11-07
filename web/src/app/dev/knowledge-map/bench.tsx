'use client'

/**
 * The synthetic Knowledge Map benchmark.
 *
 * Drives the REAL pipeline — generator → layout → tiling → in-memory data
 * source → TileStore → WebGL renderer — so nothing here is a mock of the
 * thing being measured. Only the transport is synthetic (and even that can be
 * given artificial latency, because a tile that always resolves in the same
 * microtask never exercises the store's queue, abort or hysteresis paths).
 *
 * Everything is also exposed on `window.__kmBench` / `window.__kmBenchRun` so
 * a browser automation tool can drive it headlessly: click-free runs are how
 * the GL path gets verified at all, since WebGL cannot be unit-tested.
 *
 * This page passes `showStats` to the map, which is a MEASUREMENT MODE, not a
 * display toggle: it makes the shell call `renderer.syncForTiming()` once per
 * frame, forcing a GPU sync so `syncedFrameMs` reports true CPU+GPU cost even
 * when rAF is throttled. That sync is precisely the stall the renderer is
 * built to avoid, so nothing but this bench may turn `showStats` on. It also
 * gates the `__kmStats` / `__kmDebug` / `__kmFrameLog` probes the tour reads;
 * with it off, the shell deletes them from `window`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import KnowledgeMap from '@/components/knowledge-map/knowledge-map'
import {
  createInMemoryDataSource,
  createNetworkDataSource,
} from '@/components/knowledge-map/data-source'
import type {
  KnowledgeMapHandle,
  MapDataSource,
  MapStatus,
  SelectedMapNode,
} from '@/components/knowledge-map/types'
import {
  generateSyntheticMap,
  generateSyntheticRows,
  layoutMap,
  tileMap,
  type LaidOutMap,
} from '@/lib/knowledge/graph-map'
import { pickTourStops, summariseTour, type TourResult } from './tour-stats'

/**
 * Above this the real `generateSyntheticRows + layoutMap` path (the spiral hub
 * packer) is too slow to wait for in a browser, so the fast synthetic layout
 * takes over. It is NOT append-stable, which is fine for a throwaway map and
 * wrong for anything real (core layer note).
 */
const REAL_PIPELINE_MAX = 50_000

const SIZES = [1_000, 5_000, 20_000, 50_000, 200_000, 1_000_000] as const
const LATENCIES = [0, 80, 300] as const

type BenchStatus = 'idle' | 'generating' | 'ready' | 'touring' | 'done'

interface Timings {
  generateMs: number
  layoutMs: number
  tileMs: number
  totalMs: number
  nodes: number
  edges: number
  tiles: number
  maxZ: number
  pipeline: 'real' | 'fast'
}

interface BenchWindow {
  __kmBench?: {
    status: BenchStatus
    dataset: { nodes: number; seed: number; latencyMs: number }
    timings: Timings | null
    result: TourResult | null
    mapStatus: MapStatus | null
    error?: string
  }
  __kmBenchRun?: (size?: number) => Promise<TourResult>
}

interface BuiltBench {
  source: MapDataSource
  timings: Timings
  map: LaidOutMap
}

export default function KnowledgeMapBench() {
  const [size, setSize] = useState<number>(20_000)
  const [seed, setSeed] = useState(1)
  const [latencyMs, setLatencyMs] = useState<number>(0)
  const [status, setStatus] = useState<BenchStatus>('idle')
  const [built, setBuilt] = useState<BuiltBench | null>(null)
  const [mapStatus, setMapStatus] = useState<MapStatus | null>(null)
  const [selected, setSelected] = useState<SelectedMapNode | null>(null)
  const [result, setResult] = useState<TourResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDark, setIsDark] = useState(false)

  const mapRef = useRef<KnowledgeMapHandle | null>(null)
  const [apiSource, setApiSource] = useState<MapDataSource | null>(null)
  const builtRef = useRef<BuiltBench | null>(null)
  builtRef.current = built

  // ── window.__kmBench mirror ────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as BenchWindow
    w.__kmBench = {
      status,
      dataset: { nodes: size, seed, latencyMs },
      timings: built?.timings ?? null,
      result,
      mapStatus,
      ...(error ? { error } : {}),
    }
  }, [status, size, seed, latencyMs, built, result, mapStatus, error])

  // ── Generation ─────────────────────────────────────────────────────────────

  const generate = useCallback(
    async (nodes: number, currentSeed: number, latency: number): Promise<BuiltBench | null> => {
      setStatus('generating')
      setError(null)
      setResult(null)
      setBuilt(null)
      setSelected(null)
      // Yield once so React paints the "Generating…" state before the main
      // thread disappears for a few seconds at 1M nodes.
      await new Promise((resolve) => setTimeout(resolve, 0))

      try {
        const t0 = performance.now()
        let map: LaidOutMap
        let generateMs = 0
        let layoutMs = 0
        let pipeline: Timings['pipeline']

        if (nodes <= REAL_PIPELINE_MAX) {
          pipeline = 'real'
          const rows = generateSyntheticRows({ claims: nodes, seed: currentSeed })
          const t1 = performance.now()
          generateMs = t1 - t0
          map = layoutMap(rows)
          layoutMs = performance.now() - t1
        } else {
          pipeline = 'fast'
          map = generateSyntheticMap({ nodes, seed: currentSeed })
          generateMs = performance.now() - t0
        }

        const t2 = performance.now()
        const tiled = tileMap(map, {
          filters: {},
          version: `bench-${nodes}-${currentSeed}`,
          nowMs: Date.now(),
        })
        const tileMs = performance.now() - t2

        const timings: Timings = {
          generateMs,
          layoutMs,
          tileMs,
          totalMs: performance.now() - t0,
          nodes: tiled.meta.counts.nodes,
          edges: tiled.meta.counts.edges,
          tiles: tiled.tiles.size,
          maxZ: tiled.meta.maxZ,
          pipeline,
        }
        const source = createInMemoryDataSource(tiled, { latencyMs: latency })
        const next: BuiltBench = { source, timings, map }
        setBuilt(next)
        setStatus('ready')
        return next
      } catch (err) {
        // A shader compile failure, an OOM at 1M nodes, or a tiling invariant
        // blowing up all land here — and this is the FIRST place any of them
        // would be seen, so the message is shown verbatim rather than logged.
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        setError(message)
        setStatus('idle')
        return null
      }
    },
    [],
  )

  // ── The scripted tour ──────────────────────────────────────────────────────

  const runTour = useCallback(async (bench: BuiltBench): Promise<TourResult> => {
    const handle = mapRef.current
    if (!handle) throw new Error('map handle not mounted')

    setStatus('touring')
    setResult(null)

    // A separate rAF probe rather than the map's own frame counter: the map
    // renders on demand, so what we want to measure is the interval between
    // the browser's frames while the camera is moving — which is exactly what
    // an independent rAF loop sees.
    const intervals: number[] = []
    let last = 0
    let running = true
    const tick = (now: number) => {
      if (!running) return
      if (last > 0) intervals.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    const stops = pickTourStops(bench.map, 4)
    const deepK = 12
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    try {
      handle.fitAll()
      await wait(1400)

      for (const stop of stops) {
        handle.flyTo(stop.x, stop.y, deepK)
        await wait(1200)
      }

      // Pan between two neighbouring regions at deep zoom — the branch that
      // actually forces tile load + eviction rather than just fade-in.
      if (stops.length >= 2) {
        const [a, b] = stops
        const steps = 6
        for (let i = 0; i <= steps; i++) {
          const t = i / steps
          handle.flyTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, deepK)
          await wait(300)
        }
      }

      handle.fitAll()
      await wait(1200)
    } finally {
      running = false
    }

    // Drop the first sample: it straddles the tour's start and is always an
    // outlier that would dominate the 1% low.
    const summary = summariseTour(intervals.slice(1))
    setResult(summary)
    setStatus('done')
    return summary
  }, [])

  // ── Automation hooks + ?n=&tour=1 ──────────────────────────────────────────

  const runRef = useRef<(s?: number) => Promise<TourResult>>(null)
  runRef.current = async (requested?: number) => {
    const nodes = requested ?? size
    if (requested !== undefined && requested !== size) setSize(requested)
    const bench = await generate(nodes, seed, latencyMs)
    if (!bench) throw new Error(error ?? 'generation failed')
    // Let the map mount with the new source and load its inline tiles.
    await new Promise((resolve) => setTimeout(resolve, 600))
    return runTour(bench)
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    const w = window as unknown as BenchWindow
    w.__kmBenchRun = (s?: number) => runRef.current!(s)
    return () => {
      delete w.__kmBenchRun
    }
  }, [])

  const autoRanRef = useRef(false)
  useEffect(() => {
    if (autoRanRef.current || typeof window === 'undefined') return
    autoRanRef.current = true
    const params = new URLSearchParams(window.location.search)
    // `?source=api` renders the SIGNED-IN workspace's real map through the
    // production routes instead of synthetic data — the quickest way to look
    // at real layout/labels without going through the dashboard. Read-only.
    if (params.get('source') === 'api') {
      setApiSource(createNetworkDataSource({}))
      setStatus('ready')
      return
    }
    const n = Number(params.get('n'))
    const wantsTour = params.get('tour') === '1'
    if (!Number.isFinite(n) || n <= 0) {
      if (wantsTour) void runRef.current?.()
      return
    }
    setSize(n)
    if (wantsTour) void runRef.current?.(n)
    else void generate(n, seed, latencyMs)
    // Intentionally once on mount: this reads the URL, not React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Theme toggle ───────────────────────────────────────────────────────────
  const toggleTheme = useCallback(() => {
    const root = document.documentElement
    const next = !root.classList.contains('dark')
    root.classList.toggle('dark', next)
    setIsDark(next)
  }, [])

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'))
  }, [])

  const busy = status === 'generating' || status === 'touring'
  const timings = built?.timings ?? null
  const sizeLabel = useMemo(() => formatCount(size), [size])

  return (
    <div className="flex h-dvh w-full flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-medium">Knowledge Map bench</span>

        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">nodes</span>
          <select
            className="rounded border border-border bg-background px-1.5 py-0.5"
            value={size}
            disabled={busy}
            onChange={(e) => setSize(Number(e.target.value))}
          >
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {formatCount(n)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">seed</span>
          <input
            type="number"
            className="w-14 rounded border border-border bg-background px-1.5 py-0.5"
            value={seed}
            disabled={busy}
            onChange={(e) => setSeed(Number(e.target.value) || 1)}
          />
        </label>

        <label className="flex items-center gap-1">
          <span className="text-muted-foreground">latency</span>
          <select
            className="rounded border border-border bg-background px-1.5 py-0.5"
            value={latencyMs}
            disabled={busy}
            onChange={(e) => setLatencyMs(Number(e.target.value))}
          >
            {LATENCIES.map((ms) => (
              <option key={ms} value={ms}>
                {ms} ms
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
          disabled={busy}
          onClick={() => void generate(size, seed, latencyMs)}
        >
          Regenerate
        </button>

        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
          disabled={busy || !built}
          onClick={() => {
            const bench = builtRef.current
            if (bench) void runTour(bench).catch((err) => setError(String(err)))
          }}
        >
          Run tour
        </button>

        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:bg-muted"
          onClick={toggleTheme}
        >
          {isDark ? 'Light' : 'Dark'}
        </button>

        <span className="text-muted-foreground" data-testid="bench-status">
          {status === 'generating'
            ? `Generating ${sizeLabel} nodes…`
            : status === 'touring'
              ? 'Touring…'
              : status}
          {mapStatus ? ` · map: ${mapStatus}` : ''}
        </span>

        {timings ? (
          <span className="text-muted-foreground tabular-nums">
            {formatCount(timings.nodes)} nodes · {formatCount(timings.edges)} edges ·{' '}
            {timings.tiles} tiles · maxZ {timings.maxZ} · {timings.pipeline} · gen{' '}
            {timings.generateMs.toFixed(0)}ms
            {timings.layoutMs > 0 ? ` · layout ${timings.layoutMs.toFixed(0)}ms` : ''} · tile{' '}
            {timings.tileMs.toFixed(0)}ms
          </span>
        ) : null}

        {selected ? (
          <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums" data-testid="bench-selection">
            {selected.kind}
            {selected.entityType ? `/${selected.entityType}` : ''} · {selected.key} ·{' '}
            {selected.label || '(no label)'}
          </span>
        ) : null}
      </div>

      {error ? (
        <pre
          className="whitespace-pre-wrap border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          data-testid="bench-error"
        >
          {error}
        </pre>
      ) : null}

      {result ? (
        <div className="border-b border-border px-3 py-2 text-xs tabular-nums" data-testid="bench-result">
          <span className="font-medium">Tour</span> · avg {result.avgFps.toFixed(1)} fps · 1% low{' '}
          {result.lowFps1.toFixed(1)} fps · median {result.medianFrameMs.toFixed(1)} ms · worst{' '}
          {result.worstFrameMs.toFixed(1)} ms · {result.slowFrames} frames &gt; 25 ms ·{' '}
          {result.frames} frames over {(result.durationMs / 1000).toFixed(1)} s
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {apiSource ?? built ? (
          <KnowledgeMap
            ref={mapRef}
            dataSource={(apiSource ?? built?.source) as MapDataSource}
            showStats
            active
            onStatus={setMapStatus}
            onSelect={setSelected}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
            {status === 'generating'
              ? `Generating ${sizeLabel} nodes…`
              : 'Pick a size and press Regenerate.'}
          </div>
        )}
      </div>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`
  return String(n)
}
