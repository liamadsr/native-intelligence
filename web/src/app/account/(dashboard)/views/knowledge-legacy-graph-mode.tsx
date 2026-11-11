'use client'

/**
 * The LEGACY graph — `react-force-graph-2d` over the whole workspace payload.
 *
 * It is kept as an escape hatch, nothing more. It is reached only by setting
 * `localStorage['knowledge-graph-renderer'] = 'legacy'`, and it is slated for
 * deletion together with `knowledge-graph.tsx`, `GET /api/account/knowledge`
 * and the `react-force-graph-2d` / `d3-force` dependencies once the WebGL map
 * has been validated in the desktop app's WKWebView.
 *
 * It lives in its own file so `knowledge-view.tsx` is about the CURRENT
 * product — the views chrome over claims — rather than half about a renderer
 * on its way out. Everything here (the payload types, the client-side filter,
 * the bespoke five-control bar) is deliberately unchanged from what shipped;
 * porting it onto the views filter model would be work invested in code that
 * is about to be deleted.
 *
 * Note what it does NOT do: it never runs behind the map. The whole point of
 * the map is that it never ships the full workspace, and this path fetches
 * exactly that.
 */

import { PageLoadingOrb } from '@/components/page-loading-orb'
import { Network } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import type { ClaimType } from '@/lib/knowledge/graph-map/types'
import type { GraphData, GraphNode } from './knowledge-graph'
import {
  EMPTY_FILTER_STATE,
  KnowledgeFilterBar,
  countBadgeText,
  filterStateActive,
  type KnowledgeFilterState,
} from './knowledge-filter-bar'
import {
  ClaimBody,
  EntityBody,
  InspectorShell,
  NotFoundBody,
  type OpenEntity,
} from './knowledge-map-inspector'
import type { PromoteLiveRules } from './knowledge-library'

// react-force-graph-2d touches `window` on import → load client-only.
const KnowledgeGraph = dynamic(() => import('./knowledge-graph'), {
  ssr: false,
  loading: () => <PageLoadingOrb label="Loading knowledge graph…" />,
})

// ─── API types ───────────────────────────────────────────────────────────────

type ClaimConfirmation = 'suggested' | 'confirmed'

interface Claim {
  id: string
  text: string
  type: ClaimType
  confidence: number | null
  confirmation: ClaimConfirmation
  status: 'active'
  auto_accepted?: boolean | null
  created_at: string
  last_verified_at: string | null
}

type EdgeRelation =
  | 'cites'
  | 'about'
  | 'related_to'
  | 'depends_on'
  | 'supersedes'
  | 'contradicts'
  | 'mentions'
  | 'authored_by'

interface KnowledgeEdge {
  id: string
  source_type: 'claim'
  source_id: string
  target_type:
    | 'claim'
    | 'capture'
    | 'project'
    | 'contact'
    | 'document'
    | 'email_thread'
    | 'attachment'
    | 'action'
  target_id: string
  relation: EdgeRelation
  weight: number | null
}

type SourceType =
  | 'capture'
  | 'attachment'
  | 'document'
  | 'email'
  | 'external_url'
  | 'manual'

interface ClaimSource {
  claim_id: string
  source_type: SourceType
  source_id: string | null
  source_uri: string | null
  excerpt: string | null
}

interface KnowledgeData {
  claims: Claim[]
  edges: KnowledgeEdge[]
  sources: ClaimSource[]
  entities: Record<string, { type: string; label: string }>
}

// ─── Graph data ──────────────────────────────────────────────────────────────

/**
 * Builds the force-graph `{nodes, links}` from the knowledge payload.
 * Claims and entities are both nodes; entity_link edges become links. Entities
 * act as hubs so claims cluster around their shared capture / project / contact.
 *
 * Every claim is included — no cap. A partial graph drops edges whose other
 * endpoint isn't in the kept set, which is what made the graph look
 * unconnected.
 */
function buildGraphData(data: KnowledgeData): { graph: GraphData } {
  const { claims, edges, entities } = data

  // Degree per node (claim or entity) — drives node size.
  const degree = new Map<string, number>()
  const bump = (k: string) => degree.set(k, (degree.get(k) ?? 0) + 1)
  for (const e of edges) {
    bump(e.source_id)
    const tk =
      e.target_type === 'claim' ? e.target_id : `${e.target_type}:${e.target_id}`
    bump(tk)
  }

  const claimIds = new Set(claims.map((c) => c.id))

  // Every entity referenced by an edge from a loaded claim becomes a hub node.
  const entityIds = new Set<string>()
  for (const e of edges) {
    if (!claimIds.has(e.source_id)) continue
    if (e.target_type === 'claim') continue
    entityIds.add(`${e.target_type}:${e.target_id}`)
  }

  const nodes: GraphNode[] = [
    ...claims.map<GraphNode>((c) => ({
      id: c.id,
      kind: 'claim',
      label: c.text,
      claimType: c.type,
      suggested: c.confirmation === 'suggested',
      degree: degree.get(c.id) ?? 0,
    })),
    ...[...entityIds].map<GraphNode>((key) => {
      const colon = key.indexOf(':')
      const entityType = key.slice(0, colon)
      return {
        id: key,
        kind: 'entity',
        label: entities[key]?.label ?? key,
        entityType,
        degree: degree.get(key) ?? 0,
      }
    }),
  ]

  const nodeIds = new Set(nodes.map((n) => n.id))
  const links: GraphData['links'] = edges
    .map((e) => ({
      source: e.source_id,
      target:
        e.target_type === 'claim' ? e.target_id : `${e.target_type}:${e.target_id}`,
      relation: e.relation,
    }))
    .filter(
      (l) => nodeIds.has(l.source as string) && nodeIds.has(l.target as string),
    )

  return { graph: { nodes, links } }
}

// ─── The mode ────────────────────────────────────────────────────────────────

export interface LegacyGraphModeProps {
  onOpenEntity?: OpenEntity
  onPromote: () => void
  /** Reports what Promote should freeze/turn into rules, from this path's own
   *  filter state — the map path derives the same thing from its view filters. */
  onPromoteContext: (ctx: {
    liveRules: PromoteLiveRules | undefined
    frozenClaimIds: string[]
    defaultName: string
  }) => void
}

export function LegacyGraphMode({
  onOpenEntity,
  onPromote,
  onPromoteContext,
}: LegacyGraphModeProps) {
  const workspaceId = useWorkspaceId()

  const [data, setData] = useState<KnowledgeData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [filters, setFilters] = useState<KnowledgeFilterState>(EMPTY_FILTER_STATE)

  // Guards a fetch already in flight so overlapping triggers (mount + a live
  // claim burst) don't double-request. A ref, not `loading`, because a
  // background refetch deliberately leaves `loading` false.
  const inFlightRef = useRef(false)

  const loadKnowledge = useCallback(async (background = false) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    if (!background) {
      setLoading(true)
      setData(null)
    }
    setError(null)
    try {
      const res = await fetch(`/api/account/knowledge`)
      const json: KnowledgeData | null = res.ok ? await res.json() : null
      if (!json) {
        // On a background refetch, keep whatever's on screen rather than
        // clobbering it with an error state.
        if (!background) setError('Failed to load knowledge graph.')
      } else {
        setData(json)
      }
    } catch {
      if (!background) setError('Failed to load knowledge graph.')
    } finally {
      inFlightRef.current = false
      if (!background) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!workspaceId || data) return
    void loadKnowledge()
  }, [workspaceId, data, loadKnowledge])

  const refetchKnowledge = useCallback(() => {
    if (!data) return
    void loadKnowledge(true)
  }, [data, loadKnowledge])
  useEntityListSync(['claim', 'entity_link'], refetchKnowledge, { debounceMs: 1000 })

  const projectOptions = useMemo(() => {
    if (!data) return []
    return Object.entries(data.entities)
      .filter(([key]) => key.startsWith('project:'))
      .map(([key, v]) => ({ id: key.slice('project:'.length), label: v.label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [data])

  const filtersActive = filterStateActive(filters)

  // Applied client-side: the full payload is already loaded here, so filtering
  // is a pure derivation and the count badge stays truthful.
  const filteredData = useMemo<KnowledgeData | null>(() => {
    if (!data) return null
    if (!filtersActive) return data
    const cutoff =
      filters.since === 'all' ? null : Date.now() - Number(filters.since) * 86_400_000
    const minConf = filters.confidence === 'any' ? null : Number(filters.confidence)
    let projectClaims: Set<string> | null = null
    if (filters.project !== 'all') {
      projectClaims = new Set(
        data.edges
          .filter((e) => e.target_type === 'project' && e.target_id === filters.project)
          .map((e) => e.source_id),
      )
    }
    const keptClaims = data.claims.filter((c) => {
      if (projectClaims && !projectClaims.has(c.id)) return false
      if (filters.types.size > 0 && !filters.types.has(c.type)) return false
      if (filters.confirmation !== 'all' && c.confirmation !== filters.confirmation) return false
      if (minConf != null && (c.confidence == null || c.confidence < minConf)) return false
      if (cutoff != null && new Date(c.created_at).getTime() < cutoff) return false
      return true
    })
    const keptIds = new Set(keptClaims.map((c) => c.id))
    const keptEdges = data.edges.filter(
      (e) =>
        keptIds.has(e.source_id) &&
        (e.target_type !== 'claim' || keptIds.has(e.target_id)),
    )
    return { ...data, claims: keptClaims, edges: keptEdges }
  }, [data, filtersActive, filters])

  // Promote context. Reported upward rather than rendered here, because the
  // dialog belongs to the page (both graph paths and the library share it).
  // `liveRules` is undefined when the filter cannot be expressed as standing
  // rules — suggested-only and the created-since window have no rule form —
  // which forces frozen pins rather than silently dropping a filter.
  useEffect(() => {
    const liveRules = (() => {
      if (filters.confirmation === 'suggested') return undefined
      // The "since" filter is on created_at, but a package's `since` rule is
      // resolved against updated_at — persisting it would admit old claims
      // that were edited recently. No faithful rule form: frozen pins only.
      if (filters.since !== 'all') return undefined
      const rules: PromoteLiveRules = {}
      if (filters.project !== 'all') rules.projects = [filters.project]
      if (filters.types.size > 0) rules.types = [...filters.types]
      if (filters.confidence !== 'any') rules.min_confidence = Number(filters.confidence)
      if (filters.confirmation === 'confirmed') rules.include_suggested = false
      return Object.keys(rules).length ? rules : undefined
    })()
    const frozenClaimIds = filteredData
      ? [...filteredData.claims]
          .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1))
          .map((c) => c.id)
      : []
    const defaultName =
      filters.project !== 'all'
        ? (projectOptions.find((p) => p.id === filters.project)?.label ?? 'Filtered knowledge')
        : 'Filtered knowledge'
    onPromoteContext({ liveRules, frozenClaimIds, defaultName })
  }, [filters, filteredData, projectOptions, onPromoteContext])

  const graphElements = useMemo(() => {
    if (!filteredData) return null
    return buildGraphData(filteredData)
  }, [filteredData])

  // Inspector: look up the source rows + claim record for the selected node.
  const selectedDetail = useMemo(() => {
    if (!selectedNode || !data) return null
    if (selectedNode.kind === 'claim') {
      const claim = data.claims.find((c) => c.id === selectedNode.id) ?? null
      const sources = data.sources
        .filter((s) => s.claim_id === selectedNode.id)
        .map((s) => {
          const key = s.source_id ? `${s.source_type}:${s.source_id}` : null
          const label = key ? (data.entities[key]?.label ?? null) : (s.source_uri ?? null)
          return { ...s, label }
        })
      const links = data.edges
        .filter((e) => e.source_id === selectedNode.id && e.target_type !== 'claim')
        .map((e) => {
          const key = `${e.target_type}:${e.target_id}`
          return {
            relation: e.relation,
            label: data.entities[key]?.label ?? key,
            type: e.target_type,
            id: e.target_id,
          }
        })
      return { kind: 'claim' as const, claim, sources, links }
    }
    const colon = selectedNode.id.indexOf(':')
    const entityId = colon >= 0 ? selectedNode.id.slice(colon + 1) : selectedNode.id
    const claimIds = new Set(
      data.edges
        .filter((e) => `${e.target_type}:${e.target_id}` === selectedNode.id)
        .map((e) => e.source_id),
    )
    const claims = data.claims.filter((c) => claimIds.has(c.id))
    return {
      kind: 'entity' as const,
      label: selectedNode.label,
      entityType: selectedNode.entityType,
      entityId,
      claims,
    }
  }, [selectedNode, data])

  const totalClaims = data?.claims.length ?? 0

  if (loading || (!data && !error)) {
    return (
      <div className="min-h-0 flex-1">
        <PageLoadingOrb label="Loading knowledge graph…" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-center">
          <Network className="text-muted-foreground h-8 w-8" />
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    )
  }
  if (totalClaims === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Network className="text-muted-foreground/40 h-10 w-10" />
          <div>
            <p className="text-foreground font-medium">No claims yet</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Ingest a meeting or document to build your knowledge graph.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <KnowledgeFilterBar
        value={filters}
        onChange={setFilters}
        projects={projectOptions}
        canPromote={!!filteredData?.claims.length}
        onPromote={onPromote}
      />

      <div className="relative flex min-h-0 flex-1">
        <div className="relative h-full min-w-0 flex-1">
          {graphElements && (
            <KnowledgeGraph
              data={graphElements.graph}
              selectedId={selectedNode?.id ?? null}
              onNodeClick={(node) => setSelectedNode(node ?? null)}
            />
          )}

          {graphElements && (
            <div className="border-border bg-background/80 text-muted-foreground pointer-events-none absolute top-3 right-3 z-10 rounded-md border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur">
              {countBadgeText(
                graphElements.graph.nodes.length,
                graphElements.graph.links.length,
                filtersActive,
              )}
            </div>
          )}
        </div>

        {selectedDetail && (
          <InspectorShell
            title={selectedDetail.kind === 'claim' ? 'Claim' : 'Source'}
            onClose={() => setSelectedNode(null)}
          >
            {selectedDetail.kind === 'claim' ? (
              selectedDetail.claim ? (
                <ClaimBody
                  claim={selectedDetail.claim}
                  sources={selectedDetail.sources}
                  links={selectedDetail.links}
                  onOpenEntity={onOpenEntity}
                />
              ) : (
                <NotFoundBody />
              )
            ) : (
              <EntityBody
                label={selectedDetail.label}
                entityType={selectedDetail.entityType}
                entityId={selectedDetail.entityId}
                claims={selectedDetail.claims}
                onOpenEntity={onOpenEntity}
              />
            )}
          </InspectorShell>
        )}
      </div>
    </>
  )
}
