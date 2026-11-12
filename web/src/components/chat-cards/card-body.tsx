'use client'

/**
 * The page inside a card in the chat: the heavy half, loaded only once a card
 * mounts (show-tool-card.tsx loads it lazily, so a chat with no cards never
 * pays for the list and the detail panels).
 *
 * Each kind draws here (CARD_BODIES: one entry per kind; see
 * src/lib/chat-cards/kinds.ts for the other halves):
 *   list    UnifiedViewLayout in card mode: the agent's page as its baseline,
 *           the person's changes kept with the card, a row opening its record
 *           inside the card;
 *   record  the record's own detail panel;
 *   calendar  the Calendar page's grid on the card's own range
 *           (./calendar-card-body.tsx);
 *   mail    the Mail page on the card's own folder, search or thread
 *           (./mail-card-body.tsx).
 *
 * The whole body sits under WindowFocusProvider isFocused={false} unless the
 * card is full screen, so the page's global key handlers never fire twice
 * (once for the real page, once for the card).
 *
 * Where the card is (the record open inside it, an action's inner section)
 * is a step in the card's history (./card-history.tsx): the card header's
 * Back and Forward walk it, so nothing inside a card draws a Back row of its
 * own.
 *
 * The My Actions page's own card (TasksCardBody; Liam, 11-11: "one todo icon
 * on the main nav and when you click it the sub-nav would show things like
 * milestone and projects that way it's nested and clean") is a list card
 * that also holds the places its sub-nav beside the rail opens (Projects,
 * Initiatives, Milestones, All teams and each team's board: a step in its
 * history each, the list under them),
 * and tells the sub-nav where it is (./tasks-card-controls.ts). Full screen
 * from `md` up the sub-nav is its one set of views: its own view tabs exist
 * only below `md` (CSS, no waiting on the panel). A detail panel's
 * properties and actions go in the card header's
 * Properties popover (window-properties.tsx), as they went in a window's.
 */
import * as React from 'react'
import { UnifiedViewLayout, WindowFocusProvider, type CardLayoutState } from '@/components/views/unified-view-layout'
import { ChatCardLayer } from '@/components/views/tab-active'
import type { ViewConfig } from '@/components/views/hooks/use-view'
import type { ViewEntityType } from '@/lib/views/types'
import { queryFromConfig } from '@/lib/chat-cards/context'
import { flattenRows, rowLabel } from '@/lib/chat-cards/rows'
import { CARD_RECORD_TYPES, isPageCard, type CalendarCardSpec, type CardRecordType, type CardSpec, type ListCardSpec, type MailCardSpec } from '@/lib/chat-cards/kinds'
import type { PageKind } from '@/lib/chat-cards/pages'
import { PageGate, type PageCardProps } from './pages/page-card'
import { ActionDetailPanel } from '@/app/account/(dashboard)/views/action-detail-panel'
import { CaptureDetailPanel } from '@/app/account/(dashboard)/views/capture-detail-panel'
import { DocumentDetailPanel } from '@/app/account/(dashboard)/views/document-detail-panel'
import { ContactDetailPanel } from '@/app/account/(dashboard)/views/contact-detail-panel'
import { CompanyDetailPanel } from '@/app/account/(dashboard)/views/company-detail-panel'
import { ProjectDetailPanel } from '@/app/account/(dashboard)/views/project-detail-panel'
import { InitiativeDetailPanel } from '@/app/account/(dashboard)/views/initiative-detail-panel'
import type { ChatCardStore } from './card-store'
import type { CardOpenRecord } from './card-storage'
import { useEditorSelectionRelay } from './editor-selection'
import { useCardNav, useCardNavStoreSync } from './card-history'
import { CardHeaderSlot } from './card-header-slot'
import { WindowPropertiesButton, WindowPropertiesProvider, WindowPropertiesSidebar, useWindowPropertiesSidebarShown, type PropertiesFrame } from '@/components/views/window-properties'
import { cn } from '@/lib/utils'
import { CardOverlay, CardCovered } from './card-covered'
import type { CardListNav } from '@/components/views/unified-view-layout'
import { pageOfCard } from '@/app/account/(dashboard)/rail/rail-pages'
import { useOwnSubnavShown } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import { publishTasksCard, unpublishTasksCard, type TasksPlace } from './tasks-card-controls'
import { isTasksPlace, tasksPlaceList, type TasksPlaceList } from '@/lib/chat-cards/tasks-places'

export interface CardBodyProps {
  toolCallId: string
  spec: CardSpec
  store: ChatCardStore
  fullScreen: boolean
  /** The live count, for the card's header. */
  onCount?: (count: number | null) => void
  /** The current view config, for Save as view. */
  onConfig?: (config: ViewConfig) => void
  /** A record card's panel closed: the card folds to its pill. */
  onClose?: () => void
  /**
   * The focus is in the card (its frame, or a popover it opened). With full
   * screen, what makes it the card in front, as a window's focus did on main:
   * only that card's Properties may lock open (a push compose in progress) or
   * reveal itself.
   */
  focused?: boolean
}

// The calendar and mail pages are heavy and only their cards need them.
const CalendarCardBody = React.lazy(() => import('./calendar-card-body'))
const MailCardBody = React.lazy(() => import('./mail-card-body'))
// Teams inside My Actions' card (Liam, 11-11: "Teams should be under action items"): only once one opens.
const TasksTeamsPlace = React.lazy(() => import('./pages/tasks-teams-place'))

export function isRecordType(type: string): type is CardRecordType {
  return (CARD_RECORD_TYPES as readonly string[]).includes(type)
}

/**
 * One record's detail panel, inside a card. Links to other records open them
 * in the card too (`onOpen`), never in a window: the card is where the person is.
 */
export function CardRecordPanel({
  record,
  onOpen,
  onClose,
}: {
  record: CardOpenRecord
  onOpen: (record: CardOpenRecord) => void
  onClose: () => void
}) {
  const open = (type: string) => (id: string, label: string) => {
    if (isRecordType(type)) onOpen({ type, id, label })
  }
  const openEntity = (type: string, id: string, label: string) => {
    if (isRecordType(type)) onOpen({ type, id, label })
  }
  // Selected text in a doc or a capture goes to the chat (editor-selection.ts).
  const onSelectionChange = useEditorSelectionRelay()
  switch (record.type) {
    case 'action':
      return (
        <ActionDetailPanel
          key={record.id}
          actionId={record.id}
          section={record.section}
          // Its Details / Cloud / Agents switch is a step of the card's own.
          onSectionChange={(section) => onOpen({ ...record, section })}
          onClose={onClose}
          onSelectAction={open('action')}
          onOpenEntity={openEntity}
        />
      )
    case 'capture':
      return (
        <CaptureDetailPanel
          key={record.id}
          captureId={record.id}
          onClose={onClose}
          onOpenContact={open('contact')}
          onOpenEntity={openEntity}
          onSelectionChange={onSelectionChange}
        />
      )
    case 'document':
      return <DocumentDetailPanel key={record.id} documentId={record.id} onClose={onClose} onOpenEntity={openEntity} onSelectionChange={onSelectionChange} />
    case 'contact':
      return <ContactDetailPanel key={record.id} contactId={record.id} onClose={onClose} onSelectAction={open('action')} onOpenCapture={open('capture')} />
    case 'company':
      return <CompanyDetailPanel key={record.id} companyId={record.id} onClose={onClose} onSelectContact={open('contact')} onOpenCapture={open('capture')} />
    case 'project':
      return (
        <ProjectDetailPanel
          key={record.id}
          projectId={record.id}
          onClose={onClose}
          onSelectAction={open('action')}
          onOpenCapture={open('capture')}
          onOpenEntity={openEntity}
        />
      )
    case 'initiative':
      return <InitiativeDetailPanel key={record.id} initiativeId={record.id} onClose={onClose} />
    default:
      // An event or a thread: its own kind's body opens it.
      return null
  }
}

/**
 * The record open inside a card, a step of the card's history: opening one
 * (or another from inside it, or its inner section) is a navigation, and the
 * header's Back returns to what was before. Only the open record is kept with
 * the card (a reload returns to it, with no steps behind it).
 */
export function useOpenRecords(toolCallId: string, store: ChatCardStore) {
  const nav = useCardNav<CardOpenRecord | null>(
    'open',
    () => store.state(toolCallId).open ?? null,
    (open) => store.update(toolCallId, { open }, { touch: true }),
  )
  // A record written from outside the card (a reused card's seed) opens in it,
  // at mount too.
  useCardNavStoreSync(store, nav, () => store.state(toolCallId).open)
  const { set } = nav
  return {
    current: nav.value,
    open: set as (record: CardOpenRecord) => void,
    /** The panel closed: back to what the record was opened over (a step too). */
    close: React.useCallback(() => set(null), [set]),
  }
}

/**
 * Whose actions an action list's own filter picks (`@me` as the assignee or
 * the creator): the view tab that is its page. My Actions is "Assigned to
 * me" (and open), so that tab is lit on it, and pressing it stays on the
 * page; "All" and "Created by me" are their own pages (use-view.ts
 * resetConfig).
 */
export function actionScopeOf(spec: ListCardSpec): 'assigned' | 'created' | undefined {
  if (spec.entity_type !== 'action') return undefined
  const me = (field: string) => spec.filters.some((f) => f.field === field && f.operator === 'is' && f.value === '@me')
  if (me('assignee_id')) return 'assigned'
  if (me('user_id')) return 'created'
  return undefined
}

/** A list card's view config: the agent's page, as UnifiedViewLayout reads a baseline. */
function baselineOf(spec: ListCardSpec): Partial<ViewConfig> {
  const scope = actionScopeOf(spec)
  return {
    ...(scope ? { action_scope: scope } : {}),
    filters: spec.filters.map((f, i) => ({ id: `card-${i}`, ...f })),
    ...(spec.ordering ? { ordering: spec.ordering } : {}),
    ...(spec.grouping !== undefined ? { grouping: spec.grouping } : {}),
    ...(spec.layout ? { layout: spec.layout } : {}),
    ...(spec.columns ? { display_properties: spec.columns } : {}),
  }
}

function ListCardBody(props: CardBodyProps & { spec: ListCardSpec }) {
  const records = useOpenRecords(props.toolCallId, props.store)
  return <ListCardFrame {...props} records={records} />
}

/** What a page's own list card adds (TasksCardBody): a place over the list, the nav it reports, its tabs only below `md`. */
interface ListCardExtras {
  records: ReturnType<typeof useOpenRecords>
  /** A list opened over the card's own (a place inside the page), or null. */
  over?: TasksPlaceList | null
  onNav?: (nav: CardListNav) => void
  /** Its view tabs only below `md` (UnifiedViewLayout viewTabsBelowMdOnly): from there up the page's sub-nav holds them. */
  viewTabsBelowMdOnly?: boolean
  /** A place over the list that is not a list (All teams, a team's board), or null. */
  overlay?: { key: string; node: React.ReactNode } | null
}

function ListCardFrame({ toolCallId, spec, store, fullScreen, onCount, onConfig, records, over = null, onNav, viewTabsBelowMdOnly, overlay = null }: CardBodyProps & { spec: ListCardSpec } & ListCardExtras) {
  const kept = React.useMemo(() => store.state(toolCallId), [store, toolCallId])
  const baseline = React.useMemo(() => baselineOf(spec), [spec])
  const onCountRef = React.useRef(onCount)
  onCountRef.current = onCount
  const onConfigRef = React.useRef(onConfig)
  onConfigRef.current = onConfig

  const card = React.useMemo(
    () => ({
      baseline,
      overrides: kept.overrides as Partial<ViewConfig> | undefined,
      search: kept.search,
      compact: !fullScreen,
      // The person's own changes: kept with the card, and they make it the
      // last touched card the agent hears about.
      onOverridesChange: (overrides: Partial<ViewConfig>) => store.update(toolCallId, { overrides: overrides as Record<string, unknown> }, { touch: true }),
      onSearchChange: (search: string) => store.update(toolCallId, { search }, { touch: true }),
      // The saved view picked, kept with the card (a page loaded again lands on it).
      view: kept.views?.list,
      onViewChange: (view: string | null) => store.update(toolCallId, { views: { ...store.state(toolCallId).views, list: view } }, { touch: true }),
      ...(onNav ? { onNav } : {}),
      // What the card shows now, kept quietly for the next turn's note.
      onStateChange: (state: CardLayoutState) => {
        const rows = flattenRows(state.rows).slice(0, 5).map(rowLabel)
        store.update(toolCallId, {
          base: queryFromConfig(state.baseline, state.defaults),
          cur: queryFromConfig(state.config, state.defaults, state.search),
          count: state.total,
          rows: rows.map((r) => ({ ...(r.identifier ? { identifier: r.identifier } : {}), title: r.title })),
        })
        onCountRef.current?.(state.total)
        onConfigRef.current?.(state.config)
      },
    }),
    // `kept` is read once, at mount; the layout owns the state after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseline, fullScreen, store, toolCallId, onNav],
  )

  // A place over the list: its own quiet card list (no tabs, no report), its
  // changes kept with the card by the place's key, as a page card keeps a list's.
  const overKey = over?.key ?? null
  const overCard = React.useMemo(() => {
    if (!over) return null
    const key = over.key
    return {
      baseline: over.baseline,
      overrides: store.state(toolCallId).lists?.[key] as Partial<ViewConfig> | undefined,
      compact: !fullScreen,
      onOverridesChange: (overrides: Partial<ViewConfig>) => {
        const lists = { ...(store.state(toolCallId).lists ?? {}), [key]: overrides as Record<string, unknown> }
        store.update(toolCallId, { lists }, { touch: true })
      },
    }
    // One per place: its baseline is fixed by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overKey, fullScreen, store, toolCallId])

  const openRow = (type: string, id: string, title: string) => {
    if (isRecordType(type)) records.open({ type, id, label: title })
  }
  return (
    <div className="relative h-full min-h-0">
      <CardCovered covered={!!records.current || !!over || !!overlay}>
        <UnifiedViewLayout
          entityType={spec.entity_type as ViewEntityType}
          card={card}
          viewTabsBelowMdOnly={viewTabsBelowMdOnly}
          obscured={!!records.current || !!over || !!overlay}
          onItemSelect={(id, title, _event, _item, entityType) => openRow(entityType ?? spec.entity_type, id, title)}
        />
      </CardCovered>
      {over && overCard && (
        <CardOverlay key={over.key}>
          <div data-card-place={over.key} className="min-h-0 flex-1">
            <CardCovered covered={!!records.current}>
              <UnifiedViewLayout
                entityType={over.entityType}
                card={overCard}
                obscured={!!records.current}
                onItemSelect={(id, title, _event, _item, entityType) => openRow(entityType ?? over.entityType, id, title)}
              />
            </CardCovered>
          </div>
        </CardOverlay>
      )}
      {overlay && (
        <CardOverlay key={overlay.key}>
          <div data-card-place={overlay.key} className="min-h-0 flex-1">
            <CardCovered covered={!!records.current}>{overlay.node}</CardCovered>
          </div>
        </CardOverlay>
      )}
      {records.current && (
        <CardOverlay>
          <div className="min-h-0 flex-1 overflow-hidden">
            <CardRecordPanel record={records.current} onOpen={records.open} onClose={records.close} />
          </div>
        </CardOverlay>
      )}
    </div>
  )
}

/**
 * The My Actions page's own card: its list, and the places its sub-nav
 * beside the rail opens inside it (./tasks-card-controls.ts). A place is a
 * step in the card's history (`tasks_place`), so Back returns to the list
 * and the card in front never changes (the page stays selected and lit,
 * rail/selected-place.ts). Where it is goes to the sub-nav whenever it
 * changes; the sub-nav's rows move it the same way its own tabs do.
 */
function TasksCardBody(props: CardBodyProps & { spec: ListCardSpec }) {
  const { toolCallId, store, fullScreen, spec } = props
  const records = useOpenRecords(toolCallId, store)
  // The page this card is the own card of (My Actions; a non-page card: none, never covered).
  const ownPage = React.useMemo(() => pageOfCard(spec), [spec])
  const subnavShown = useOwnSubnavShown(ownPage)
  const place = useCardNav<TasksPlace | null>('tasks_place', () => null)
  const [nav, setNav] = React.useState<CardListNav | null>(null)
  const recordsRef = React.useRef(records)
  recordsRef.current = records
  const placeRef = React.useRef(place)
  placeRef.current = place
  // A place asked for from outside the card (Projects or Initiatives opened
  // from `/`, Search or a link: they nest here, rail/rail-pages.ts
  // nestedPageOpen, chat-panel openCardHere): a step to it over where the card
  // was, so Back returns there, at mount too. Taken once: the card's own steps
  // hold it after that. A record open over the list closes in the same step.
  useCardNavStoreSync(store, place, () => {
    const asked = store.state(toolCallId).tasksPlace
    if (asked === undefined) return undefined
    store.update(toolCallId, { tasksPlace: undefined })
    if (!isTasksPlace(asked)) return undefined
    if (recordsRef.current.current) recordsRef.current.close()
    return asked
  })

  React.useEffect(() => {
    if (!nav) return
    // Leaving a place (or a record open over the list) for the list: one step
    // (the history merges what one press moves).
    const toList = () => {
      if (recordsRef.current.current) recordsRef.current.close()
      if (placeRef.current.get() !== null) placeRef.current.set(null)
    }
    publishTasksCard({
      cardId: toolCallId,
      scope: nav.scope,
      viewId: nav.viewId,
      views: nav.views.map((v) => ({ id: v.id, name: v.name })),
      place: place.value,
      setScope: (scope) => {
        toList()
        nav.setScope(scope)
      },
      setView: (viewId) => {
        toList()
        nav.setView(viewId)
      },
      go: (next) => {
        if (recordsRef.current.current) recordsRef.current.close()
        placeRef.current.set(next)
      },
      show: () => {
        if (store.fullScreen() !== toolCallId) store.enterFullScreen(toolCallId)
      },
    })
  }, [nav, place.value, toolCallId, store])
  React.useEffect(() => () => unpublishTasksCard(toolCallId), [toolCallId])

  // All teams or a team's board (Liam, 11-11: "Teams should be under action
  // items"): the Teams page's own views over the list, not a list; moving
  // between them is a step too, and an action on a board opens over it.
  const teamsAt = place.value && !tasksPlaceList(place.value) ? place.value : null
  const teamsNode = teamsAt ? (
    <React.Suspense fallback={null}>
      <TasksTeamsPlace
        place={teamsAt}
        toolCallId={toolCallId}
        store={store}
        fullScreen={fullScreen}
        go={(next) => placeRef.current.set(next)}
        openAction={(id, title) => records.open({ type: 'action', id, label: title })}
        selectedActionId={records.current?.type === 'action' ? records.current.id : null}
        obscured={!!records.current}
      />
    </React.Suspense>
  ) : null

  return (
    <ListCardFrame
      {...props}
      records={records}
      over={place.value ? tasksPlaceList(place.value) : null}
      overlay={teamsAt ? { key: `tasks:${teamsAt}`, node: teamsNode } : null}
      onNav={setNav}
      // Full screen from `md` up the sub-nav beside the rail is the card's
      // one set of views (Liam, 11-11: "did you actually clean up the old
      // one and remove it from the panel complely or did you do something
      // the lazy way?"): its tabs only below `md`, in CSS, from the first
      // paint, while that sub-nav is on screen (not with a capture's notepad
      // on the left or the panel closed: page-panel/subnav-on-screen.ts;
      // Liam, 11-11). Inline in the chat it shows no tabs anyway (a card's list).
      viewTabsBelowMdOnly={fullScreen && subnavShown}
    />
  )
}

function RecordCardBody({ toolCallId, spec, store, onClose }: CardBodyProps) {
  const records = useOpenRecords(toolCallId, store)
  if (spec.kind !== 'record') return null
  const shown: CardOpenRecord = records.current ?? {
    type: spec.record.type,
    id: spec.record.id,
    label: spec.title,
    ...(spec.record.section ? { section: spec.record.section } : {}),
  }
  // The card's own record with another section (its Details / Cloud / Agents
  // switch, a step all the same) is not a record opened over it: the panel's X
  // folds the card. Only another record opened from it closes back to it.
  const opened = !!records.current && !(records.current.type === spec.record.type && records.current.id === spec.record.id)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <CardRecordPanel record={shown} onOpen={records.open} onClose={opened ? records.close : (onClose ?? (() => {}))} />
      </div>
    </div>
  )
}

/**
 * The whole pages (P3, src/lib/chat-cards/pages.ts), each loaded the first
 * time a card of its kind mounts: a chat with only list cards never pays for
 * the prospecting page or the flow canvas.
 */
const PAGE_BODIES: Record<PageKind, React.LazyExoticComponent<React.ComponentType<PageCardProps>>> = {
  team_board: React.lazy(() => import('./pages/team-board-card')),
  sequences: React.lazy(() => import('./pages/sequences-card')),
  prospecting: React.lazy(() => import('./pages/prospecting-card')),
  flows: React.lazy(() => import('./pages/flows-card')),
  evals: React.lazy(() => import('./pages/evals-card')),
  campaigns: React.lazy(() => import('./pages/campaigns-card')),
  tables: React.lazy(() => import('./pages/tables-card')),
  pipelines: React.lazy(() => import('./pages/pipelines-card')),
  team_chat: React.lazy(() => import('./pages/team-chat-card')),
  availability: React.lazy(() => import('./pages/availability-card')),
  files: React.lazy(() => import('./pages/files-card')),
  studio: React.lazy(() => import('./pages/studio-card')),
  seo_audit: React.lazy(() => import('./pages/seo-audit-card')),
  seo_keywords: React.lazy(() => import('./pages/seo-keywords-card')),
  seo_rankings: React.lazy(() => import('./pages/seo-rankings-card')),
  seo_search: React.lazy(() => import('./pages/seo-search-card')),
  seo_competitors: React.lazy(() => import('./pages/seo-competitors-card')),
  seo_backlinks: React.lazy(() => import('./pages/seo-backlinks-card')),
  seo_ai_visibility: React.lazy(() => import('./pages/seo-ai-visibility-card')),
  seo_local: React.lazy(() => import('./pages/seo-local-card')),
  knowledge: React.lazy(() => import('./pages/knowledge-card')),
  library: React.lazy(() => import('./pages/library-card')),
  teams: React.lazy(() => import('./pages/teams-card')),
  bot: React.lazy(() => import('./pages/bot-card')),
  work_item: React.lazy(() => import('./pages/work-item-card')),
  guest: React.lazy(() => import('./pages/guest-card')),
  agent_link: React.lazy(() => import('./pages/agent-link-card')),
}

function PageCardBody(props: CardBodyProps) {
  if (!isPageCard(props.spec)) return null
  const Body = PAGE_BODIES[props.spec.kind]
  return (
    <PageGate spec={props.spec}>
      <React.Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading…</div>}>
        <Body toolCallId={props.toolCallId} spec={props.spec} store={props.store} fullScreen={props.fullScreen} onCount={props.onCount} />
      </React.Suspense>
    </PageGate>
  )
}

/** What each kind draws. */
const CARD_BODIES: Record<'list' | 'record' | 'calendar' | 'mail', (props: CardBodyProps) => React.ReactNode> = {
  list: (props) =>
    props.spec.kind !== 'list' ? null : pageOfCard(props.spec) === 'actions' ? (
      <TasksCardBody {...props} spec={props.spec} />
    ) : (
      <ListCardBody {...props} spec={props.spec} />
    ),
  record: (props) => <RecordCardBody {...props} />,
  calendar: (props) => (props.spec.kind === 'calendar' ? <CalendarCardBody {...props} spec={props.spec as CalendarCardSpec} /> : null),
  mail: (props) => (props.spec.kind === 'mail' ? <MailCardBody {...props} spec={props.spec as MailCardSpec} /> : null),
}

/**
 * The narrowest a full-screen card can be and still give its properties a
 * column of their own (WindowPropertiesSidebar's 320px), leaving the page room
 * beside it; narrower, they stay behind the header's button.
 */
export const EMBEDDED_PROPERTIES_MIN_PX = 920

/**
 * With the column beside it, the page keeps to its reading width (the detail
 * pages' 736px), and the two stand centred together, the column right where
 * the content ends (Liam, 10-19: "right next to where the content ends").
 */
const EMBEDDED_PAGE_WIDTH = 'max-w-[736px]'

/** The row is wide enough for the properties' column (measured only while full screen). */
function useRoomForProperties(row: React.RefObject<HTMLDivElement | null>, fullScreen: boolean): boolean {
  const [roomy, setRoomy] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = row.current
    if (!fullScreen || !el) return
    const measure = () => setRoomy(el.getBoundingClientRect().width >= EMBEDDED_PROPERTIES_MIN_PX)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => observer?.disconnect()
  }, [row, fullScreen])
  return fullScreen && roomy
}

/**
 * The card's inspector: a detail panel's properties and actions go in the
 * Properties popover, its button in the card header's right slot. Full screen,
 * with room, they stand in a column beside the content instead, always shown,
 * and the header has no button (Liam, 10-19: in the chat "it's the top
 * properties button that opens up. If they're full screen then you see it
 * embedded on the right hand side"). Each card owns its own; a card in a chat
 * out of sight, or one the focus left (inline), closes its popover. The row is
 * always there and the page always its first child, so going full screen and
 * back never mounts the page again (only the column comes and goes).
 */
function CardProperties({ focused, fullScreen, children }: { focused: boolean; fullScreen: boolean; children: React.ReactNode }) {
  const rowRef = React.useRef<HTMLDivElement>(null)
  const embedded = useRoomForProperties(rowRef, fullScreen)
  const frame = React.useMemo<PropertiesFrame>(() => ({ isFocused: focused, tucked: false, embedded }), [focused, embedded])
  return (
    <WindowPropertiesProvider frame={frame}>
      <CardHeaderSlot side="right">
        <WindowPropertiesButton />
      </CardHeaderSlot>
      <PropertiesRow rowRef={rowRef}>{children}</PropertiesRow>
    </WindowPropertiesProvider>
  )
}

/**
 * The page and, beside it, the properties' column. Only while the column
 * shows does the page keep to its reading width; a page with no properties
 * (a list) keeps the card's full width.
 */
function PropertiesRow({ rowRef, children }: { rowRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }) {
  const shown = useWindowPropertiesSidebarShown()
  return (
    <div ref={rowRef} data-card-properties-row="" className={cn('flex h-full min-h-0', shown && 'justify-center')}>
      <div className={cn('h-full min-h-0 min-w-0 flex-1', shown && EMBEDDED_PAGE_WIDTH)}>{children}</div>
      <WindowPropertiesSidebar />
    </div>
  )
}

export default function CardBody(props: CardBodyProps) {
  const body = isPageCard(props.spec) ? <PageCardBody {...props} /> : CARD_BODIES[props.spec.kind as 'list' | 'record' | 'calendar' | 'mail'](props)
  const page = (
    <WindowFocusProvider isFocused={props.fullScreen}>
      <CardProperties focused={props.fullScreen || !!props.focused} fullScreen={props.fullScreen}>
        {body}
      </CardProperties>
    </WindowFocusProvider>
  )
  // Full screen, the card takes the focus from the windows under it, so a
  // shortcut (Shift+H on an action) fires once, in the card. Always rendered,
  // so the move to full screen and back never mounts the page again.
  return <ChatCardLayer active={props.fullScreen}>{page}</ChatCardLayer>
}
