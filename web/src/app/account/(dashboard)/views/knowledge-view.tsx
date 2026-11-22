'use client'

/**
 * The Knowledge page: the claims. It had a second surface, the Library (the
 * workspace brief, the per-project rollups, the curated packages), picked
 * with a pill; that is a page of its own now, next to this one in Drive
 * (Liam, 11-21: "split the Knowledge page into two pages";
 * components/chat-cards/pages/knowledge-library-card.tsx).
 *
 * Shape, top to bottom — the same shape as the Team board and every other
 * collection in the product:
 *
 *   Header:       the search, at the right (in its card, the card's header)
 *   ViewToolbar:  saved-view tabs · filter · settings · Promote
 *   FilterChips:  Type is any of Fact, Decision   ×
 *   Body:         <canvas> | <list> | <board>     ← the view's LAYOUT
 *
 * The layout toggle picks HOW the claims read: a knowledge map, a list or a
 * board, over one saved filter set. A claim view opens on the map because
 * that is a claim's natural reading, and the other two are one click away in
 * the view settings. Promote turns the view into a package, which the
 * Library keeps.
 *
 * ONE INSPECTOR, THREE LAYOUTS. The selection lives here rather than inside the
 * canvas, so clicking a node and clicking a row open the same panel with the
 * same evidence. Both resolve through `useMapNodeDetail`, which fetches a
 * claim's full record by key.
 */

import { Button } from '@/components/ui/button'
import { Network, Package } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ListHeaderControls } from '@/components/views/list-header-controls'
import { CardHeaderSlot } from '@/components/chat-cards/card-header-slot'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { openTarget } from '@/lib/chat-cards/open-card'
import type { MapMeta } from '@/lib/knowledge/graph-map/types'
import type { ViewFilter } from '@/lib/views/types'
import type { SelectedMapNode } from '@/components/knowledge-map/types'
import { PromotePackageDialog, type PromoteLiveRules } from './knowledge-library'
import {
  ClaimBody,
  EntityBody,
  InspectorError,
  InspectorShell,
  InspectorSkeleton,
  NotFoundBody,
  type OpenEntity,
} from './knowledge-map-inspector'
import { KnowledgeGraphLayout } from './knowledge-graph-layout'
import { LegacyGraphMode } from './knowledge-legacy-graph-mode'
import { isVirtualKey, useMapNodeDetail } from './use-map-node-detail'
import { viewFiltersToPromoteRules } from './knowledge-promote-rules'
import { ViewHeader } from './view-header'

export type { OpenEntity } from './knowledge-map-inspector'

// ─── Renderer choice ─────────────────────────────────────────────────────────

/**
 * Graph mode runs the WebGL map unless the viewer has opted out, or the map's
 * capability probe says this browser cannot run it. The legacy force-graph
 * renderer stays as the fallback and is deleted in a follow-up PR once the map
 * is validated in the desktop app.
 */
const RENDERER_KEY = 'knowledge-graph-renderer'

function legacyRendererRequested(): boolean {
  try {
    return window.localStorage.getItem(RENDERER_KEY) === 'legacy'
  } catch {
    // Private mode / blocked storage — the new map is the default.
    return false
  }
}

interface PromoteContext {
  liveRules: PromoteLiveRules | undefined
  frozenClaimIds: string[]
  defaultName: string
}

/**
 * Knowledge in a chat card (src/components/chat-cards/pages/knowledge-card.tsx).
 * The map, WebGL, runs only where the card allows it (full screen, one at a
 * time). Elsewhere the graph layout shows a still with the way to full screen.
 */
export interface KnowledgeCardMode {
  mapAllowed: boolean
  onWantMap: () => void
  /** A record is open over the page: it owns the card's header. */
  covered?: boolean
}

/** What a chat card shows where the map would run, inline or while another card holds it. */
function MapStill({ onWantMap }: { onWantMap: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
      <Network className="h-5 w-5" />
      <span>The knowledge map opens in full screen.</span>
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onWantMap}>
        Open the map
      </Button>
    </div>
  )
}

export function KnowledgeView({
  onOpenEntity,
  card,
}: {
  onOpenEntity?: OpenEntity
  card?: KnowledgeCardMode
}) {
  // Renderer choice. `useLegacy` starts false on the server and is settled in
  // an effect, because localStorage is unreadable during SSR/hydration. An
  // 'unsupported' probe result sticks, so a browser that already said no is
  // not probed again.
  const [useLegacy, setUseLegacy] = useState(false)
  useEffect(() => {
    if (legacyRendererRequested()) setUseLegacy(true)
  }, [])
  const handleUnsupported = useCallback(() => setUseLegacy(true), [])

  const [promoteOpen, setPromoteOpen] = useState(false)
  // The map's server-computed facts (counts, projects, promote top-50).
  const [mapMeta, setMapMeta] = useState<MapMeta | null>(null)
  // The view's live filters, reported up by the layout so Promote can turn the
  // same filter set into standing package rules.
  const [viewFilters, setViewFilters] = useState<ViewFilter[]>([])
  // What Promote should do, when the LEGACY path is what is on screen — it has
  // its own filter state and derives its own rules.
  const [legacyPromote, setLegacyPromote] = useState<PromoteContext | null>(null)

  /**
   * Search, owned HERE so the input can live at the far right of the page
   * header — where Documents and the CRM put theirs — instead of in the band
   * above the body. Passing the value down to UnifiedViewLayout is what stands
   * its own in-list search bar down; the two are one decision, not two.
   */
  const [search, setSearch] = useState('')

  // The selected node — shared by the canvas, the list and the board.
  const [selected, setSelected] = useState<SelectedMapNode | null>(null)
  const detail = useMapNodeDetail(selected?.key ?? null)

  /**
   * A row click, from the list or the board, becomes the same selection a node
   * click makes. `claim:<id>` is the map's own node key, and `useMapNodeDetail`
   * resolves it through the same endpoint either way — so the panel a reader
   * opens from a row is byte-for-byte the panel they would have opened from the
   * canvas, evidence excerpts and all.
   */
  const handleRowSelect = useCallback((itemId: string, title: string) => {
    setSelected({ key: `claim:${itemId}`, kind: 'claim', label: title })
  }, [])

  /**
   * Promote. The button is the toolbar's, but the RULES come from the view's
   * filters, and the derivation is fail-closed: a filter with no representation
   * in a package's `rules` JSONB returns undefined for the whole set, which
   * forces the dialog into frozen-pins mode rather than persisting a standing
   * rule that means something narrower than what the user was looking at.
   */
  const mapPromote = useMemo<PromoteContext>(() => {
    // The toolbar search narrows the map too (a text predicate over claim
    // text), and rules have no text form — so a search forces frozen pins.
    const liveRules = search.trim() ? undefined : viewFiltersToPromoteRules(viewFilters)
    const projects = mapMeta?.projects ?? []
    const projectFilter = viewFilters.find((f) => f.field === 'project_ids')
    const onlyProject =
      projectFilter && typeof projectFilter.value === 'string'
        ? projectFilter.value
        : Array.isArray(projectFilter?.value) && projectFilter.value.length === 1
          ? String(projectFilter.value[0])
          : null
    return {
      liveRules,
      frozenClaimIds: mapMeta?.promote.topClaimIds ?? [],
      defaultName:
        (onlyProject && projects.find((p) => p.id === onlyProject)?.label) ||
        'Filtered knowledge',
    }
  }, [viewFilters, mapMeta, search])

  const promote = useLegacy ? legacyPromote : mapPromote
  const canPromote = useLegacy
    ? (legacyPromote?.frozenClaimIds.length ?? 0) > 0
    : (mapMeta?.counts.claims ?? 0) > 0

  const graphIsMap = !useLegacy
  // A card where the map may not run (inline, or another card holds it).
  const mapStill = !!card && !card.mapAllowed

  // The map's search. The legacy renderer keeps its own filter state, so the
  // box is not offered over it.
  const searchControl = graphIsMap ? (
    <ListHeaderControls
      searchValue={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search knowledge…"
      searchLabel="Search knowledge"
      // No create button: a claim is extracted from a meeting or a document,
      // never authored here.
    />
  ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!card && <ViewHeader history="custom" className="gap-3" title="Knowledge" actions={searchControl ?? undefined} />}

      {graphIsMap ? (
        /* `relative` so the inspector can overlay the whole views column —
           including the toolbar — rather than sitting beside the body and
           resizing the canvas every time it opens. */
        <div className="relative flex min-h-0 flex-1 flex-col">
          <UnifiedViewLayout
            entityType="claim"
            onItemSelect={handleRowSelect}
            selectedItemId={selected?.kind === 'claim' ? selected.key.slice('claim:'.length) : null}
            toolbarActions={
              <Button
                // Clear on the card's glass, like the view tabs: the outline
                // variant's solid fill read as a dark block (Liam, 11-21).
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground dark:shadow-none"
                disabled={!canPromote}
                onClick={() => setPromoteOpen(true)}
                title="Create a gated, shareable package from the current view"
              >
                <Package className="h-3 w-3" />
                Promote
              </Button>
            }
            renderGraph={({ filters, search }) => mapStill ? (
              <MapStill onWantMap={card!.onWantMap} />
            ) : (
              <KnowledgeGraphLayout
                filters={filters}
                search={search}
                selected={selected}
                onSelect={setSelected}
                onMeta={setMapMeta}
                onUnsupported={handleUnsupported}
              />
            )}
            onFiltersChange={setViewFilters}
            searchValue={search}
          />

          {/* The shell renders from the SELECTION alone — never after the fetch
              resolves — so a click never leaves the panel missing for a beat. */}
          {selected && (
            <InspectorShell
              overlay
              title={selected.kind === 'claim' ? 'Claim' : 'Source'}
              onClose={() => setSelected(null)}
            >
              <InspectorBody selected={selected} detail={detail} onOpenEntity={onOpenEntity} />
            </InspectorShell>
          )}
        </div>
      ) : mapStill ? (
        <MapStill onWantMap={card!.onWantMap} />
      ) : (
        <LegacyGraphMode
          onOpenEntity={onOpenEntity}
          onPromote={() => setPromoteOpen(true)}
          onPromoteContext={setLegacyPromote}
        />
      )}

      {/* In its card, the search sits in the card's own header, as every other
          page's search does (Liam, 11-21); none while a record is open over
          the page, which owns the header then. After the views layout, so it
          lands after the layout switcher there, as on every page. */}
      {card && !card.covered && searchControl && <CardHeaderSlot side="right">{searchControl}</CardHeaderSlot>}

      {promoteOpen && promote && (
        <PromotePackageDialog
          open
          onOpenChange={(open) => !open && setPromoteOpen(false)}
          defaultName={promote.defaultName}
          liveRules={promote.liveRules}
          liveDescription={
            promote.liveRules
              ? 'The current filter becomes a standing rule — matching claims keep flowing in automatically.'
              : undefined
          }
          frozenClaimIds={promote.frozenClaimIds}
          frozenTotal={useLegacy ? undefined : mapMeta?.promote.total}
          onCreated={(pkg) => {
            setPromoteOpen(false)
            // The package is the Library's, a page away since the split
            // (Liam, 11-21): say where it is, one click from it.
            toast.success(`“${pkg.name}” is in the Library`, {
              action: { label: 'Open', onClick: () => openTarget({ type: 'package', id: pkg.id, title: pkg.name }, { from: 'knowledge' }) },
            })
          }}
        />
      )}
    </div>
  )
}

function InspectorBody({
  selected,
  detail,
  onOpenEntity,
}: {
  selected: SelectedMapNode
  detail: ReturnType<typeof useMapNodeDetail>
  onOpenEntity?: OpenEntity
}) {
  // A virtual hub is a layout device with no row behind it, so there is
  // nothing to fetch — the route answers 400 for these by design.
  if (isVirtualKey(selected.key)) {
    return (
      <div>
        <p className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
          Unfiled
        </p>
        <p className="text-foreground mt-0.5 text-sm font-medium">{selected.label}</p>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          Claims from this month that aren&rsquo;t linked to a meeting, document
          or project yet. Open one to see where it came from.
        </p>
      </div>
    )
  }

  const { state, retry, loadMore } = detail
  if (state.status === 'loading' || state.status === 'idle') return <InspectorSkeleton />
  if (state.status === 'error') return <InspectorError onRetry={retry} />
  if (state.status === 'not-found') return <NotFoundBody />

  if (state.detail.kind === 'claim') {
    return (
      <ClaimBody
        claim={state.detail.claim}
        sources={state.detail.sources}
        links={state.detail.links}
        onOpenEntity={onOpenEntity}
      />
    )
  }

  return (
    <EntityBody
      label={state.detail.label}
      entityType={state.detail.entityType}
      entityId={state.detail.entityId}
      claims={state.detail.claims}
      total={state.detail.total}
      onLoadMore={state.detail.nextCursor ? loadMore : undefined}
      loadingMore={state.loadingMore}
      onOpenEntity={onOpenEntity}
    />
  )
}
