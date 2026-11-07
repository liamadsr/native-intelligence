'use client'

/**
 * The `graph` layout's body — the WebGL knowledge map, drawn inside the shared
 * views chrome.
 *
 * This is what `UnifiedViewLayout` renders in place of ViewList/ViewBoard when
 * a claim view's layout is 'graph'. It is passed in from the page rather than
 * imported by the views system (see `renderGraph`), so the renderer, the tile
 * store and the shaders stay out of the bundle of every list in the product.
 *
 * WHAT IT OWNS vs WHAT IT IS HANDED
 *  - HANDED the view's filters and search term. The toolbar above owns those
 *    now; there is no bespoke filter bar here any more.
 *  - HANDED the selection, because the inspector serves all three layouts —
 *    clicking a node and clicking a row must open the same panel, so the page
 *    holds the selection and the panel, not this file.
 *  - OWNS the data source (memoised on `filtersKey`, so a filter change is a
 *    new source and therefore a reload with the camera kept), the map's meta,
 *    its status, and the refresh token.
 *
 * FILTERS ARE SERVER-SIDE. Nothing filters map data on the client: tiles are
 * importance-ordered, so a client-side mask over partially loaded tiles hides
 * exactly the nodes a filter is looking for.
 */

import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { PageLoadingOrb } from '@/components/page-loading-orb'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { Network } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { filtersKey, toMapFilters, type RejectedFilter } from '@/lib/knowledge/graph-map/filter-model'
import type { MapMeta, NodeKey } from '@/lib/knowledge/graph-map/types'
import type { ViewFilter } from '@/lib/views/types'
import { createNetworkDataSource } from '@/components/knowledge-map/data-source'
import type { MapStatus, SelectedMapNode } from '@/components/knowledge-map/types'
import { countBadgeText } from './knowledge-filter-bar'

// WebGL2 context creation touches `window` at module scope → client-only, with
// a loading fallback so switching layouts does not flash empty.
const KnowledgeMap = dynamic(() => import('@/components/knowledge-map/knowledge-map'), {
  ssr: false,
  loading: () => <PageLoadingOrb label="Loading knowledge graph…" />,
})

export interface KnowledgeGraphLayoutProps {
  /** The view's filters, already merged with any scope filters by the layout. */
  filters: ViewFilter[]
  /** The toolbar's search term — applied as a text predicate over claim text. */
  search: string
  selected: SelectedMapNode | null
  onSelect: (node: SelectedMapNode | null) => void
  /** The server's facts about the filtered map — counts, projects, promote set. */
  onMeta?: (meta: MapMeta | null) => void
  /** The map probed as unsupported; the page falls back to the legacy graph. */
  onUnsupported: () => void
}

export function KnowledgeGraphLayout({
  filters,
  search,
  selected,
  onSelect,
  onMeta,
  onUnsupported,
}: KnowledgeGraphLayoutProps) {
  const workspaceId = useWorkspaceId()

  const [meta, setMeta] = useState<MapMeta | null>(null)
  const [status, setStatus] = useState<MapStatus>('loading')
  const [refreshToken, setRefreshToken] = useState(0)
  // Bumping this remounts the map. It is the ONLY recovery that works from
  // every error the shell reports: a failed `createMapRenderer` returns before
  // a tile store exists at all, so there is nothing left for a refresh token to
  // revalidate — only a fresh mount rebuilds the GL stack and re-runs `load()`.
  const [mapGeneration, setMapGeneration] = useState(0)

  /**
   * The view's filters as the map's wire filters.
   *
   * The toolbar's SEARCH term joins them as an ordinary `text contains`
   * predicate rather than travelling as its own parameter, so one mechanism
   * answers both and the canvas narrows exactly the way the list would. The
   * list reaches the same rows through the query engine's `fts` search; the two
   * are the same question asked of two engines.
   *
   * `filtersKey` is the canonical identity of a filter set, so the source is
   * recreated exactly when the server would answer differently — and a new
   * source identity is what the map treats as "reload, keep the camera". The
   * memo carries the filters object ALONGSIDE its key so the dependency stays a
   * primitive: the translated object is a fresh literal every render, and
   * depending on it would reload the map on every unrelated re-render.
   */
  const { dataSource, sourceKey, rejected } = useMemo(() => {
    const searchTerm = search.trim()
    const withSearch: ViewFilter[] = searchTerm
      ? [...filters, { id: '__search', field: 'text', operator: 'contains', value: searchTerm }]
      : filters
    const { filters: mapFilters, rejected } = toMapFilters(withSearch)
    return {
      dataSource: createNetworkDataSource(mapFilters),
      sourceKey: filtersKey(mapFilters),
      rejected,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterIdentity(filters), search])

  const bumpRefresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  /**
   * Recover from the error state.
   *
   * `status` is reset here rather than waiting for the remounted map to report
   * one, so the overlay clears on the click instead of on the next network
   * round-trip — and so a second failure is a fresh 'error', not a value that
   * never changed. The generation bump then gives React a new element identity,
   * which unmounts the failed map and mounts a clean one; the new mount's own
   * cold `load()` is what refetches.
   */
  const retry = useCallback(() => {
    setStatus('loading')
    setMapGeneration((n) => n + 1)
  }, [])

  // A changed workspace or filter set makes the old selection meaningless.
  useEffect(() => {
    onSelect(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, workspaceId])

  const handleMeta = useCallback(
    (next: MapMeta) => {
      setMeta(next)
      onMeta?.(next)
    },
    [onMeta],
  )

  const handleStatus = useCallback(
    (next: MapStatus) => {
      setStatus(next)
      if (next === 'unsupported') onUnsupported()
    },
    [onUnsupported],
  )

  // Realtime.
  useEntityListSync(['claim', 'entity_link'], bumpRefresh, { debounceMs: 2000 })

  const selectedKey: NodeKey | null = selected?.key ?? null
  const counts = meta?.counts
  const filtersActive = sourceKey !== ''

  // Empty states are driven by the server's counts, so they cannot disagree
  // with the canvas: `totalClaims` is the UNFILTERED total (no claims at all)
  // while `counts.claims` is the filtered one (nothing matches).
  const noClaimsAtAll = counts != null && counts.totalClaims === 0
  const noMatches = counts != null && counts.totalClaims > 0 && counts.claims === 0

  return (
    /**
     * ABSOLUTE, not a flex child. The chrome above this box changes height as
     * the user works — the dirty-state ribbon appears the moment a filter
     * diverges from the saved baseline and disappears on Cancel — and for a
     * canvas a height change is a viewport change that re-requests tiles. Being
     * absolutely positioned inside the layout's `relative` content box means
     * the canvas is sized by that box's final rect rather than participating in
     * a flow that reflows under it.
     */
    <div className="absolute inset-0">
      <KnowledgeMap
        key={mapGeneration}
        dataSource={dataSource}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onMeta={handleMeta}
        onStatus={handleStatus}
        refreshToken={refreshToken}
        active
      />

      {/* The loading orb sits OVER the canvas rather than replacing it, so a
          realtime revalidation never unmounts the GL context. */}
      {status === 'loading' && !meta && (
        <div className="bg-background/60 absolute inset-0">
          <PageLoadingOrb label="Loading knowledge graph…" />
        </div>
      )}

      {/* The error OVERLAYS the canvas for the same reason the empty states do,
          and for one more: `status` is written only by the map's own
          `onStatus`, so replacing the map with this panel would unmount the
          only thing that could ever clear the error — the view would latch
          dead. Note the missing `pointer-events-none`: the empty states carry
          it because they hold nothing to click, but copying it here would make
          Retry unclickable, which is the same dead button by another route. */}
      {status === 'error' && (
        <div className="bg-background/80 absolute inset-0 z-20 flex items-center justify-center backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-center">
            <Network className="text-muted-foreground h-8 w-8" />
            <p className="text-muted-foreground text-sm">Failed to load knowledge graph.</p>
            <button
              type="button"
              onClick={retry}
              className="text-foreground text-xs underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Both empty states OVERLAY the canvas rather than replacing it.
          Unmounting the map would take `onMeta`/`onStatus` with it, so a
          workspace that gets its first claim from a realtime write would have
          nothing left to notice it. */}
      {noClaimsAtAll && (
        <div className="bg-background pointer-events-none absolute inset-0 flex items-center justify-center">
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
      )}

      {noMatches && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">No claims match these filters</p>
        </div>
      )}

      {/* Status corner — BOTTOM LEFT, and one stack rather than two absolute
          boxes. The count used to sit top-right, where it collided with the
          toolbar's own controls directly above it and covered the canvas at the
          corner a reader scans first. Down here it is out of the way of both
          the toolbar and the inspector, which overlays from the right.

          Stacked in one column because the two can be on screen together: laid
          out separately they overlapped the moment a filter was rejected, which
          is exactly when the warning most needs to be readable. */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-col items-start gap-1.5">
        {/* A filter the canvas cannot answer is SAID, never swallowed. With the
            claim vocabulary chosen so every field is maskable this should be
            unreachable — a parity test asserts it — so if it ever shows, the
            two filter engines have drifted and the reader is told which chip is
            not being applied rather than shown a canvas that quietly ignores
            it. Above the count, because it is the more urgent of the two. */}
        {rejected.length > 0 && (
          <div className="border-amber-500/40 bg-amber-500/10 max-w-sm rounded-md border px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            {rejectedMessage(rejected)}
          </div>
        )}

        {counts && !noClaimsAtAll && (
          <div className="border-border bg-background/80 text-muted-foreground rounded-md border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur">
            {countBadgeText(counts.nodes, counts.edges, filtersActive)}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A stable identity for a filter array.
 *
 * `config.filters` is a fresh array on most renders, so depending on it
 * directly would rebuild the data source — and therefore reload the map —
 * constantly. Serialising the FIELDS THAT AFFECT THE QUERY (and not the chip
 * ids, which change when a chip is re-created with the same meaning) gives a
 * primitive that changes exactly when the answer would.
 */
function filterIdentity(filters: readonly ViewFilter[]): string {
  return JSON.stringify(filters.map((f) => [f.field, f.operator, f.value]))
}

function rejectedMessage(rejected: RejectedFilter[]): string {
  const names = rejected.map((r) => r.filter.field).join(', ')
  return rejected.length === 1
    ? `One filter is not applied to the graph: ${names}`
    : `${rejected.length} filters are not applied to the graph: ${names}`
}
