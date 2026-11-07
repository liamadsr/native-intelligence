'use client'

/**
 * Obsidian-style force-directed knowledge graph.
 *
 * Renders claims + their linked entities as a physics graph on canvas:
 * dots sized by degree, labels that fade in on zoom, hover-highlight of a
 * node's neighborhood, click-to-inspect, and smooth pinch-zoom / pan.
 *
 * react-force-graph-2d touches `window` on import, so this module is loaded
 * via next/dynamic({ ssr: false }) from knowledge-view. Theme colors are read
 * from the live DOM (resolved CSS vars) so the canvas tracks light/dark mode.
 */

import { forceCenter, forceCollide, forceLink, forceManyBody } from 'd3-force'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ForceGraphMethods,
  LinkObject,
  NodeObject,
} from 'react-force-graph-2d'
import ForceGraph2D from 'react-force-graph-2d'

// ─── Public node/link shapes ──────────────────────────────────────────────────

export type GraphNodeKind = 'claim' | 'entity'

export interface GraphNode extends NodeObject {
  id: string
  kind: GraphNodeKind
  label: string
  /** claim type (fact/decision/…) — only for claim nodes */
  claimType?: 'fact' | 'open_question' | 'inference' | 'decision_summary'
  /** entity type (capture/project/…) — only for entity nodes */
  entityType?: string
  suggested?: boolean
  degree: number
  // runtime-populated adjacency (set in buildAdjacency)
  neighbors?: GraphNode[]
  linkRefs?: GraphLink[]
}

export interface GraphLink extends LinkObject {
  source: string | GraphNode
  target: string | GraphNode
  relation: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

// ─── Theme ────────────────────────────────────────────────────────────────────

/**
 * Monochrome theme. The graph is intentionally black & white: neutral grey
 * dots, faint links, and the app's foreground "ink" reserved for the node
 * the user is hovering / has selected (and its immediate links). Entities read
 * a touch darker/heavier than claims so hubs are distinguishable by weight,
 * not hue.
 */
interface ThemeColors {
  background: string
  ink: string // foreground — used for active/selected emphasis
  claim: string // resting claim dot
  entity: string // resting entity dot (heavier than claim)
  dim: string // dimmed node when something else is hovered
  link: string // resting link
  linkActive: string // highlighted link
  linkFaint: string // non-highlighted link while hovering
  label: string // resting label text
  isDark: boolean
}

function hsl(varName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim()
  return raw ? `hsl(${raw})` : fallback
}

function readTheme(): ThemeColors {
  const isDark =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark')
  return {
    background: hsl('--background', isDark ? '#0b0d14' : '#f8f9fc'),
    ink: hsl('--foreground', isDark ? '#e6e8ee' : '#1d2333'),
    claim: isDark ? 'rgba(228,230,238,0.42)' : 'rgba(30,35,51,0.34)',
    entity: isDark ? 'rgba(232,234,242,0.72)' : 'rgba(24,28,42,0.6)',
    dim: isDark ? 'rgba(228,230,238,0.12)' : 'rgba(30,35,51,0.1)',
    link: isDark ? 'rgba(160,166,182,0.16)' : 'rgba(40,46,66,0.14)',
    linkActive: isDark ? 'rgba(236,238,244,0.85)' : 'rgba(20,24,38,0.7)',
    linkFaint: isDark ? 'rgba(160,166,182,0.05)' : 'rgba(40,46,66,0.05)',
    label: isDark ? 'rgba(220,224,234,0.78)' : 'rgba(34,40,58,0.72)',
    isDark,
  }
}

/** Resting fill for a node (monochrome; entities are heavier than claims). */
function nodeColor(node: GraphNode, theme: ThemeColors): string {
  return node.kind === 'entity' ? theme.entity : theme.claim
}

// ─── Adjacency wiring (for hover-highlight) ───────────────────────────────────

/**
 * Returns a fresh graph (cloned nodes + links) with `neighbors`/`linkRefs`
 * populated for hover-highlight. We clone rather than mutate the incoming
 * `data` because (a) it's a React prop / memo input that must stay read-only,
 * and (b) react-force-graph mutates the node objects it's handed (x/y/vx/vy/fx),
 * so giving it our own copies keeps that physics state off the source data.
 */
function buildAdjacency(data: GraphData): GraphData {
  const nodes: GraphNode[] = data.nodes.map((n) => ({
    ...n,
    neighbors: [],
    linkRefs: [],
  }))
  const links: GraphLink[] = data.links.map((l) => ({ ...l }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const link of links) {
    const s =
      typeof link.source === 'object'
        ? byId.get((link.source as GraphNode).id)
        : byId.get(link.source as string)
    const t =
      typeof link.target === 'object'
        ? byId.get((link.target as GraphNode).id)
        : byId.get(link.target as string)
    if (!s || !t) continue
    s.neighbors!.push(t)
    t.neighbors!.push(s)
    s.linkRefs!.push(link)
    t.linkRefs!.push(link)
  }
  return { nodes, links }
}

// ─── Component ────────────────────────────────────────────────────────────────

interface KnowledgeGraphProps {
  data: GraphData
  /** Called with the clicked node, or null when the empty canvas is clicked. */
  onNodeClick?: (node: GraphNode | null) => void
  selectedId?: string | null
}

export default function KnowledgeGraph({
  data,
  onNodeClick,
  selectedId,
}: KnowledgeGraphProps) {
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(
    undefined,
  )
  const containerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ width: 0, height: 0 })
  const [theme, setTheme] = useState<ThemeColors>(() => readTheme())

  // Hover highlight state (kept in refs so paint callbacks don't churn React).
  const hoverNodeRef = useRef<GraphNode | null>(null)
  const highlightNodes = useRef<Set<string>>(new Set())
  const highlightLinks = useRef<Set<GraphLink>>(new Set())
  const [, forceRepaint] = useState(0)

  const graphData = useMemo(() => buildAdjacency(data), [data])

  // Large graphs (thousands of nodes) can't afford a long synchronous warmup —
  // each tick is O(n log n), so 140 blocking ticks on a 2.5k-node sim freezes
  // the tab on mount. Scale the pre-roll down as the graph grows; the
  // simulation keeps cooling live after first paint either way.
  const nodeCount = graphData.nodes.length
  const { warmupTicks, cooldownTicks } = useMemo(() => {
    if (nodeCount > 1500) return { warmupTicks: 0, cooldownTicks: 60 }
    if (nodeCount > 600) return { warmupTicks: 8, cooldownTicks: 90 }
    return { warmupTicks: 20, cooldownTicks: 120 }
  }, [nodeCount])

  // ── Resize observer ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setDims({ width: r.width, height: r.height })
    })
    ro.observe(el)
    setDims({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── Watch for dark-mode class flips ──
  // Initial value already comes from useState(() => readTheme()); this only
  // re-reads when the <html> class actually changes, so no synchronous setState.
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readTheme()))
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => obs.disconnect()
  }, [])

  // ── Configure forces (Obsidian-like spacing) ──
  // Depends on `dims.width` too: the ForceGraph2D element (and thus
  // fgRef.current) only mounts once we have non-zero dimensions, so on first
  // load this effect must re-run after the ResizeObserver fires — otherwise it
  // no-ops on `!fg` and the graph keeps d3's default forces.
  useEffect(() => {
    const fg = fgRef.current
    if (!fg) return
    fg.d3Force('charge', forceManyBody().strength(-95).distanceMax(420))
    fg.d3Force(
      'link',
      forceLink<GraphNode, GraphLink>()
        .id((n: GraphNode) => n.id)
        .distance((l: GraphLink) => {
          // entity hubs sit a little further out so clusters breathe
          const t =
            typeof l.target === 'object' ? (l.target as GraphNode) : null
          return t?.kind === 'entity' ? 70 : 42
        })
        .strength(0.18),
    )
    fg.d3Force('center', forceCenter(0, 0).strength(0.04))
    fg.d3Force(
      'collide',
      forceCollide<GraphNode>()
        .radius((n: GraphNode) => nodeRadius(n) + 4)
        .iterations(2),
    )
    fg.d3ReheatSimulation()
  }, [graphData, dims.width])

  // ── Fit to view once physics settle ──
  const didFit = useRef(false)
  useEffect(() => {
    didFit.current = false
  }, [graphData])

  const handleEngineStop = useCallback(() => {
    if (didFit.current) return
    didFit.current = true
    fgRef.current?.zoomToFit(420, 60)
  }, [])

  // Selection is read inside the canvas painter; with autoPauseRedraw the loop
  // may be idle, so nudge a redraw whenever the selected node changes (e.g. the
  // user clicked a claim in the list view).
  useEffect(() => {
    fgRef.current?.resumeAnimation()
  }, [selectedId])

  // ── Hover handling ──
  const handleNodeHover = useCallback((node: GraphNode | null) => {
    const hn = highlightNodes.current
    const hl = highlightLinks.current
    hn.clear()
    hl.clear()
    if (node) {
      hn.add(node.id)
      node.neighbors?.forEach((n) => hn.add(n.id))
      node.linkRefs?.forEach((l) => hl.add(l))
    }
    hoverNodeRef.current = node
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? 'pointer' : 'grab'
    }
    forceRepaint((v) => v + 1)
    // The simulation may be paused (autoPauseRedraw) once it settles; nudge a
    // single redraw so the hover highlight actually paints.
    fgRef.current?.resumeAnimation()
  }, [])

  // ── Node painter (monochrome) ──
  const paintNode = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const r = nodeRadius(node)
      const hovering = hoverNodeRef.current !== null
      const isHot = highlightNodes.current.has(node.id)
      const isSelected = selectedId === node.id
      const isActive = node === hoverNodeRef.current || isSelected
      const dim = hovering && !isHot

      // Resting → grey; in a hovered neighborhood → ink; dimmed → very faint.
      const fill = dim
        ? theme.dim
        : isActive || isHot
          ? theme.ink
          : nodeColor(node, theme)

      ctx.save()
      ctx.beginPath()
      ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI)
      ctx.fillStyle = fill
      ctx.fill()

      // Crisp ink ring on the focused node itself.
      if (isActive) {
        ctx.lineWidth = 1.4 / globalScale
        ctx.strokeStyle = theme.ink
        ctx.beginPath()
        ctx.arc(node.x!, node.y!, r + 2.5 / globalScale, 0, 2 * Math.PI)
        ctx.stroke()
      }

      // Suggested claims read as a hollow ring (unverified) rather than a filled dot.
      if (node.kind === 'claim' && node.suggested && !isActive && !isHot) {
        ctx.beginPath()
        ctx.arc(
          node.x!,
          node.y!,
          Math.max(r - 1.2 / globalScale, 0.4),
          0,
          2 * Math.PI,
        )
        ctx.fillStyle = theme.background
        ctx.fill()
      }

      // Label — fades in on zoom; hub/bigger nodes surface earlier. Always for
      // the active neighborhood.
      const labelThreshold =
        node.kind === 'entity'
          ? 0.7
          : node.degree >= 6
            ? 1.1
            : node.degree >= 3
              ? 1.8
              : 2.6
      const showLabel = globalScale >= labelThreshold || isHot || isSelected
      if (showLabel && node.label) {
        const fontSize = Math.min(13 / globalScale, r * 1.7)
        ctx.font = `${node.kind === 'entity' ? 600 : 400} ${fontSize}px Inter, ui-sans-serif, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const label =
          node.label.length > 42 ? node.label.slice(0, 40) + '…' : node.label
        ctx.fillStyle = dim
          ? theme.dim
          : isActive || isHot
            ? theme.ink
            : theme.label
        ctx.fillText(label, node.x!, node.y! + r + 2.5 / globalScale)
      }

      ctx.restore()
    },
    [theme, selectedId],
  )

  // pointer hit area = the dot (plus a small constant-screen-space pad so
  // small nodes stay clickable when zoomed out)
  const paintPointerArea = useCallback(
    (
      node: GraphNode,
      color: string,
      ctx: CanvasRenderingContext2D,
      globalScale: number,
    ) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(
        node.x!,
        node.y!,
        nodeRadius(node) + 3 / globalScale,
        0,
        2 * Math.PI,
      )
      ctx.fill()
    },
    [],
  )

  // ── Link painter (monochrome) ──
  const linkColor = useCallback(
    (link: GraphLink) => {
      if (highlightLinks.current.has(link)) return theme.linkActive
      if (hoverNodeRef.current) return theme.linkFaint
      return theme.link
    },
    [theme],
  )
  const linkWidth = useCallback(
    (link: GraphLink) => (highlightLinks.current.has(link) ? 1.4 : 0.55),
    [],
  )

  // ── Click / drag handlers (stable across renders) ──
  const handleNodeClick = useCallback(
    (node: GraphNode) => onNodeClick?.(node),
    [onNodeClick],
  )
  const handleBackgroundClick = useCallback(
    () => onNodeClick?.(null),
    [onNodeClick],
  )
  const handleNodeDragEnd = useCallback((node: GraphNode) => {
    // Pin the node where the user dropped it (Obsidian behavior).
    node.fx = node.x
    node.fy = node.y
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      // No opaque background here — the ForceGraph canvas is transparent
      // (backgroundColor="rgba(0,0,0,0)") so the dashboard's glyph dot grid shows
      // through behind the graph, matching every other page.
      style={{ cursor: 'grab' }}
    >
      {dims.width > 0 && (
        <ForceGraph2D<GraphNode, GraphLink>
          ref={fgRef}
          width={dims.width}
          height={dims.height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={1}
          nodeVal={(n) => nodeRadius(n) ** 2}
          nodeColor={(n) => nodeColor(n, theme)}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          linkColor={linkColor}
          linkWidth={linkWidth}
          linkCurvature={0.08}
          linkDirectionalParticles={0}
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          onBackgroundClick={handleBackgroundClick}
          onNodeDragEnd={handleNodeDragEnd}
          cooldownTicks={cooldownTicks}
          onEngineStop={handleEngineStop}
          minZoom={0.4}
          maxZoom={8}
          enableZoomInteraction
          enablePanInteraction
          enableNodeDrag
          warmupTicks={warmupTicks}
        />
      )}
    </div>
  )
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

/** Node radius scales gently with degree (Obsidian-like). */
function nodeRadius(node: GraphNode): number {
  const base = node.kind === 'entity' ? 4 : 2.6
  const growth =
    Math.sqrt(node.degree + 1) * (node.kind === 'entity' ? 1.4 : 1.0)
  return Math.min(base + growth, node.kind === 'entity' ? 14 : 9)
}
