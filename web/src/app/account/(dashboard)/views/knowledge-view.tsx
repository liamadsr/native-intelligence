'use client'

/**
 * The Knowledge page.
 *
 * Shape, top to bottom — the same shape as the Team board and every other
 * collection in the product:
 *
 *   ViewHeader:   Knowledge  [Graph ⌄]        ← the pill picks the SURFACE
 *   ViewToolbar:  saved-view tabs · filter · settings · Promote
 *   FilterChips:  Type is any of Fact, Decision   ×
 *   Body:         <canvas> | <list> | <board>     ← the view's LAYOUT
 *
 * The pill and the layout toggle are two different questions, which is why
 * there are two controls. The pill picks WHAT you are looking at: the claims
 * (Graph) or the reading surface built on top of them (Library — the workspace
 * brief, the per-project rollups, the curated packages). The layout toggle
 * picks HOW: a knowledge map, a list or a board, over one saved filter set.
 * A claim view opens on the map because that is a claim's natural reading, and
 * the other two are one click away in the view settings.
 *
 * Only the Graph side is a views surface. The Library is not a list of claims —
 * it has no row entity for filters or sorting to act on — so it keeps its own
 * layout under the same header.
 *
 * ONE INSPECTOR, THREE LAYOUTS. The selection lives here rather than inside the
 * canvas, so clicking a node and clicking a row open the same panel with the
 * same evidence. Both resolve through `useMapNodeDetail`, which fetches a
 * claim's full record by key.
 */

import { PageTitle } from '@/components/views/page-title'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BookOpen, Check, ChevronsUpDown, Network, Package } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListHeaderControls } from '@/components/views/list-header-controls'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import type { MapMeta } from '@/lib/knowledge/graph-map/types'
import type { ViewFilter } from '@/lib/views/types'
import type { SelectedMapNode } from '@/components/knowledge-map/types'
import {
  KnowledgeLibrary,
  PromotePackageDialog,
  type PromoteLiveRules,
} from './knowledge-library'
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

/**
 * The remembered surface for a workspace, or null.
 *
 * Wrapped because a bare `localStorage.getItem` THROWS in a private window and
 * wherever site data is blocked — and this one runs inside an effect, so the
 * throw took the whole page down rather than degrading to the default. Only an
 * explicit, recognised value is returned: an unreadable store and a corrupted
 * one both mean "no preference recorded", which leaves the default in place.
 */
function readStoredMode(workspaceId: string | null): 'library' | 'graph' | null {
  if (!workspaceId) return null
  try {
    const stored = window.localStorage.getItem(`knowledge-view-mode:${workspaceId}`)
    return stored === 'graph' || stored === 'library' ? stored : null
  } catch {
    return null
  }
}

function writeStoredMode(workspaceId: string | null, mode: 'library' | 'graph'): void {
  if (!workspaceId) return
  try {
    window.localStorage.setItem(`knowledge-view-mode:${workspaceId}`, mode)
  } catch {
    // Quota / private mode — accept losing the preference rather than failing
    // the click that set it.
  }
}

interface PromoteContext {
  liveRules: PromoteLiveRules | undefined
  frozenClaimIds: string[]
  defaultName: string
}

/**
 * Knowledge in a chat card (src/components/chat-cards/pages/knowledge-card.tsx).
 * The card owns the surface (Graph or Library), so the page's remembered
 * choice is neither read nor written; and the map, WebGL, runs only where the
 * card allows it (full screen, one at a time). Elsewhere the graph layout
 * shows a still with the way to full screen.
 */
export interface KnowledgeCardMode {
  mode: 'library' | 'graph'
  onMode: (mode: 'library' | 'graph') => void
  mapAllowed: boolean
  onWantMap: () => void
  /** The person opened (or closed) a package in the library. */
  onPackageChange?: (pkg: { id: string; name?: string } | null) => void
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
  initialPackageId,
  card,
}: {
  onOpenEntity?: OpenEntity
  /** Deep link: open the library's PackagePanel for this package once. Forces
   *  library mode (the graph has no package panel). Read-once — see the effect
   *  below and KnowledgeLibrary's own consume-once guard. */
  initialPackageId?: string
  card?: KnowledgeCardMode
}) {
  const workspaceId = useWorkspaceId()
  /**
   * THE GRAPH IS THE DEFAULT SURFACE.
   *
   * It used to be the Library, from when the graph was a slow inspection tool
   * you opened deliberately. That is no longer what it is: it loads on demand,
   * it carries the saved views, and it is what someone means when they say
   * "knowledge". A returning viewer's own choice still wins — `switchMode`
   * records it per workspace and the effect below restores it — so this is the
   * FIRST-VISIT answer, not an override of anyone's preference.
   */
  const [ownMode, setMode] = useState<'library' | 'graph'>('graph')
  const mode = card ? card.mode : ownMode
  const inCard = !!card

  // Renderer choice. `useLegacy` starts false on the server and is settled in
  // an effect, because localStorage is unreadable during SSR/hydration. An
  // 'unsupported' probe result sticks for the session, so toggling modes does
  // not re-probe a browser that already said no.
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

  // A package deep link (e.g. a work-run resource chip) forces LIBRARY mode —
  // the graph has no PackagePanel. Consumed once per distinct id so switching
  // to the graph after arriving (or re-navigating to the same package) isn't
  // fought. `deepLinkForcedRef` keeps the force alive across a LATE workspace
  // resolution (the stored-mode restore below re-fires then and must not
  // override it); the user's own mode switch clears it.
  const consumedPackageIdRef = useRef<string | null>(null)
  const deepLinkForcedRef = useRef(false)
  useEffect(() => {
    if (!initialPackageId) {
      consumedPackageIdRef.current = null
      deepLinkForcedRef.current = false
      return
    }
    if (consumedPackageIdRef.current === initialPackageId) return
    consumedPackageIdRef.current = initialPackageId
    deepLinkForcedRef.current = true
    setMode('library')
  }, [initialPackageId])

  // Restore the last-used mode per workspace, so someone who prefers the
  // Library keeps landing on it. Only an explicit stored value moves the mode:
  // absent or unreadable storage leaves the graph default above in place,
  // rather than falling back to the other surface. A pending or just-consumed
  // package deep link wins until the user switches modes.
  useEffect(() => {
    if (!workspaceId || inCard) return
    if (deepLinkForcedRef.current) return
    if (initialPackageId && consumedPackageIdRef.current !== initialPackageId) return
    const stored = readStoredMode(workspaceId)
    if (stored) setMode(stored)
  }, [workspaceId, initialPackageId, inCard])

  const switchMode = (m: 'library' | 'graph') => {
    if (card) {
      card.onMode(m)
      return
    }
    deepLinkForcedRef.current = false
    setMode(m)
    writeStoredMode(workspaceId, m)
  }

  // Leaving the graph clears the selection — the panel belongs to the claims.
  useEffect(() => {
    if (mode !== 'graph') setSelected(null)
  }, [mode])

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

  const graphIsMap = mode === 'graph' && !useLegacy
  // A card where the map may not run (inline, or another card holds it).
  const mapStill = !!card && !card.mapAllowed

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        history="custom"
        className="gap-3"
        // `title` takes a NODE, so the name and the surface pill stay a single
        // left-anchored group while `actions` pins the search to the far right
        // — the layout contract ViewHeader already enforces everywhere else.
        title={
          <div className="flex min-w-0 items-center gap-3">
            <PageTitle label="Knowledge" as="h1" />
            {/* Surface switcher — a pill dropdown, matching the Team / Calendar
                view pickers so the pattern reads the same across the app. */}
            <SurfacePill mode={mode} onSelect={switchMode} />
          </div>
        }
        // Only the claims surface consumes a search term. The Library is a
        // brief and a shelf of packages with no query behind it, so rendering
        // the box there would be a control that does nothing — worse than not
        // offering it, because it invites the reader to type into it.
        actions={
          graphIsMap ? (
            <ListHeaderControls
              searchValue={search}
              onSearchChange={setSearch}
              searchPlaceholder="Search knowledge…"
              searchLabel="Search knowledge"
              // No create button: a claim is extracted from a meeting or a
              // document, never authored here.
            />
          ) : undefined
        }
      />

      {mode === 'library' ? (
        <div className="relative min-h-0 flex-1">
          <KnowledgeLibrary onOpenEntity={onOpenEntity} initialPackageId={initialPackageId} onPackageChange={card?.onPackageChange} />
        </div>
      ) : graphIsMap ? (
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
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs"
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
          onCreated={() => setPromoteOpen(false)}
        />
      )}
    </div>
  )
}

/** The surface switcher — Graph or Library. A pill dropdown, matching the Team
 *  and Calendar view pickers so the pattern reads the same across the app. */
function SurfacePill({
  mode,
  onSelect,
}: {
  mode: 'library' | 'graph'
  onSelect: (mode: 'library' | 'graph') => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold text-foreground shadow-sm transition-colors hover:bg-muted data-[state=open]:bg-muted dark:shadow-none">
        {mode === 'library' ? (
          <BookOpen className="h-3.5 w-3.5" />
        ) : (
          <Network className="h-3.5 w-3.5" />
        )}
        {mode === 'library' ? 'Library' : 'Graph'}
        <ChevronsUpDown className="h-3 w-3 opacity-50" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-40">
        {(['library', 'graph'] as const).map((m) => (
          <DropdownMenuItem key={m} onClick={() => onSelect(m)} className="gap-2">
            {m === 'library' ? (
              <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <Network className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="flex-1">{m === 'library' ? 'Library' : 'Graph'}</span>
            {mode === m && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
