'use client'

/**
 * What every page card shares (src/lib/chat-cards/pages.ts): where in the
 * page the person is, the card surface that makes every list inside the page
 * a card list, and the edition gate.
 *
 * A page card drives the real page component through its own props, the way
 * a tab drives it through its location: opening a sequence, a list or a suite
 * moves the CARD (kept per device, keyed by the tool call), never the tab.
 * Every views-system list the page draws inside takes its card options from
 * the surface (CardSurfaceContext), so it keeps its filters with the card,
 * reports what it shows for the agent's note, and never reads or writes the
 * real page's saved views, selection or drafts.
 */
import * as React from 'react'
import { CardSurfaceContext, type CardLayoutOptions, type CardLayoutState, type CardSurface } from '@/components/views/unified-view-layout'
import type { ViewConfig } from '@/components/views/hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'
import { isViewAllowed } from '@/lib/editions/manifest'
import { pageWords } from '@/lib/editions/words'
import { useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { queryFromConfig } from '@/lib/chat-cards/context'
import { flattenRows, rowLabel } from '@/lib/chat-cards/rows'
import { PAGE_KINDS, pageEntities, type PageCardSpec, type PagePlace } from '@/lib/chat-cards/pages'
import type { ChatCardStore } from '../card-store'
import { useCardNav, useCardNavStoreSync } from '../card-history'

export interface PageCardProps {
  toolCallId: string
  spec: PageCardSpec
  store: ChatCardStore
  fullScreen: boolean
  onCount?: (count: number | null) => void
}

/** The baseline a list inside a page card starts from: the agent's own, where it gave one. */
function baselineFor(spec: PageCardSpec, entityType: ViewEntityType): Partial<ViewConfig> {
  if (spec.kind === 'team_board' && entityType === 'action') {
    return { filters: (spec.filters ?? []).map((f, i) => ({ id: `card-${i}`, ...f })), layout: 'board' }
  }
  // The knowledge map is WebGL: inline, claims read as a list. Full screen, the
  // person may switch the layout to the map (see KnowledgePageCard).
  if (entityType === 'claim') return { layout: 'list' }
  return {}
}

/**
 * The surface a page card hands the lists inside it. One options object per
 * list (entity + scope), stable for the card's life in one place, so a list's
 * config never resets under the person.
 *
 * Only the page's own list reports what it shows (for the note and
 * read_card): a list of an entity the kind shows. Any other list inside the
 * card (a project's actions in a record opened over the page, a team's board
 * over the Teams page) is still a card list, but quiet; and `quiet` makes
 * every list under a surface quiet (the record overlays use one).
 */
export function usePageCardSurface(
  { toolCallId, spec, store, fullScreen, onCount }: PageCardProps,
  opts: { quiet?: boolean } = {},
): CardSurface {
  const onCountRef = React.useRef(onCount)
  onCountRef.current = onCount
  const quiet = !!opts.quiet
  return React.useMemo(() => {
    const cache = new Map<string, CardLayoutOptions>()
    const reports = quiet ? new Set<ViewEntityType>() : pageEntities(spec.kind)
    return {
      listOptions(entityType, key) {
        const hit = cache.get(key)
        if (hit) return hit
        const kept = store.state(toolCallId)
        const own = reports.has(entityType)
        const options: CardLayoutOptions = {
          // A quiet list is the page's default, never the agent's page.
          baseline: quiet ? {} : baselineFor(spec, entityType),
          overrides: kept.lists?.[key] as Partial<ViewConfig> | undefined,
          ...(own ? { search: kept.search } : {}),
          compact: !fullScreen,
          keepTabs: entityType === 'prospect_list_entry',
          onOverridesChange: (overrides) => {
            const lists = { ...(store.state(toolCallId).lists ?? {}), [key]: overrides as Record<string, unknown> }
            store.update(toolCallId, { lists }, { touch: true })
          },
          // The saved view each list picked, kept with the card (a page loaded again lands on it).
          view: kept.views?.[key],
          onViewChange: (view) => store.update(toolCallId, { views: { ...store.state(toolCallId).views, [key]: view } }, { touch: true }),
        }
        if (own) {
          options.onSearchChange = (search) => store.update(toolCallId, { search }, { touch: true })
          options.onStateChange = (state: CardLayoutState) => {
            const rows = flattenRows(state.rows).slice(0, 5).map(rowLabel)
            store.update(toolCallId, {
              entity: entityType,
              base: queryFromConfig(state.baseline, state.defaults),
              cur: queryFromConfig(state.config, state.defaults, state.search),
              count: state.total,
              rows: rows.map((r) => ({ ...(r.identifier ? { identifier: r.identifier } : {}), title: r.title })),
            })
            onCountRef.current?.(state.total)
          }
        }
        cache.set(key, options)
        return options
      },
    }
  }, [toolCallId, spec, store, fullScreen, quiet])
}

/** Where in a page a card is: the place (null: the page's top level) and the tab. */
export interface PagePlaceState {
  at: PagePlace | null
  tab?: string
}

/**
 * Where in the page the card is, and on which tab. Starts where the person
 * left it (or where the agent opened it); every move is kept with the card
 * and drops what the last place's list reported, until the new place's list
 * reports. Every move (a place, a tab) is a step in the card's history, so
 * the header's Back and Forward walk them; `restored` counts the times they
 * moved it, for a page that reads where it opens only once.
 */
export function usePagePlace({ toolCallId, spec, store }: PageCardProps) {
  const nav = useCardNav<PagePlaceState>(
    'place',
    () => {
      const kept = store.state(toolCallId)
      return { at: kept.at === undefined ? (spec.target ?? null) : kept.at, tab: kept.tab ?? spec.tab }
    },
    ({ at, tab }) =>
      store.update(
        toolCallId,
        { at, tab, entity: undefined, base: undefined, cur: undefined, count: undefined, rows: undefined },
        { touch: true },
      ),
  )
  const { value, set, get } = nav
  // A place written from outside the card (a bot's page opened again on one
  // of its items, reusing this card: chat-panel openCardHere) moves it there,
  // at mount too (the card may have been collapsed when it was written).
  useCardNavStoreSync(store, nav, (current) => {
    const kept = store.state(toolCallId).at
    return kept === undefined ? undefined : { ...current, at: kept }
  })
  const go = React.useCallback((at: PagePlace | null, tab?: string) => set({ at, tab }), [set])
  const setTab = React.useCallback((tab: string) => set({ ...get(), tab }), [set, get])
  return { at: value.at, tab: value.tab, go, setTab, restored: nav.restored }
}

/** The page's lists, as card lists. */
export function PageCardSurface({ surface, children }: { surface: CardSurface; children: React.ReactNode }) {
  return <CardSurfaceContext.Provider value={surface}>{children}</CardSurfaceContext.Provider>
}

/** A short line in place of the page: off in this workspace, or not here. */
export function PageCardNotice({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">{text}</div>
}

/**
 * The edition gate, on the client too: a card shown before an owner turned the
 * page off draws the notice, not the page. The same answer the nav gives.
 */
export function PageGate({ spec, children }: { spec: PageCardSpec; children: React.ReactNode }) {
  const edition = useWorkspaceEdition()
  const def = PAGE_KINDS[spec.kind]
  if (def.view && !isViewAllowed(edition, def.view)) return <PageCardNotice text={`${pageWords(edition, def.view, def).label} is off in this workspace.`} />
  return <>{children}</>
}
