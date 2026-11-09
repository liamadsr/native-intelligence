'use client'

/**
 * The panels around the main chat (Liam, 10-15: "make it a lot more smoother
 * so that they all fit nicely"): the right side panel and, on the left, the
 * For you column (chat/for-you-column.tsx), one system.
 *
 *   One way in   the right panel has its toggle in the top bar
 *                (side-panel-toggles.tsx), also ⌘\, and Esc closes it while
 *                the focus is inside it. For you has none from `md` up (Liam,
 *                11-09: "just show that stuff all the time if you have any"):
 *                there it shows whenever it has cards (useForYouAlways); on
 *                a phone, with no app rail, its top-bar toggle stays.
 *   One motion   a panel slides in and out on a transform (PANEL_SLIDE_MS,
 *                none under reduced motion); width, left and grid columns are
 *                never animated.
 *   One plan     space-plan.ts decides, from the row's width and where the
 *                chat's content stands, whether a panel makes room (it fits
 *                in the free space beside the content and the chat does not
 *                move at all, or the content moves by just the shortfall,
 *                once, never animated) or floats over the chat's edge. Where
 *                the chat moves, its scroll keeps its distance from the
 *                bottom (side-panel-store.ts captureChatAnchor /
 *                restoreChatAnchor).
 *   No remounts  the right panel mounts on its first open and then stays
 *                mounted, hidden off-screen and `inert`, so its rows and a
 *                steer half typed survive closing it.
 *   No flaps     (Liam, 10-16: "it shouldn't feel like you have two side
 *                panels; you just have floating cards") neither panel draws a
 *                box of its own: each is an invisible, click-through column
 *                (pointer-events: none) of floating cards that take the
 *                pointer, on the For you column's card surface
 *                (components/attention/card-skin.ts: solid, no backdrop blur
 *                over the moving sky).
 *
 * The right panel's sections, each only when it has something (Liam's "hide
 * empty widgets"), except the agent's own: Computer, always (Liam, 10-24: the
 * agent card always shows; with no cloud browser yet its computer row offers
 * to start one, and the agent's first browsing fills it in) (computer-section.tsx,
 * open by default: its preview is the point; its row is the agent's, with its
 * bot and name, as Dots' agent card; its bot and the settings icon at its far
 * right open the agent's editor, its name and look; a Call under its row
 * starts voice mode (on the desktop); always first, and the one card that
 * can't be moved),
 * Agents while anything runs, Plan when the main chat has
 * one, Context once the main chat's conversation has a measured size
 * (context-section.tsx), Environment while the main chat has one (a Mac or a
 * cloud environment, environment-section.tsx), Connections always. So the last run
 * settling never empties the panel
 * under the cursor: Connections stays. Each is a card that reads, closed, as
 * one row (Liam, 10-16, the Claude app's right panel: "you can see things at
 * a high level then you can open them"): its title, a chevron and a one-line
 * summary (card-heading.tsx), opened in place, remembered per device. They
 * stand in the person's order (dragged by the row's ⋮⋮ handle, card-drag.ts,
 * or ⌥↑ / ⌥↓ on it; remembered, a hidden card keeping its slot), Agents ·
 * Plan · Context · Environment · Connections until then.
 *
 * Flat cost: no timer but the Agents section's once-a-minute elapsed redraw
 * while rows show and the environment's 30 s read while the panel is open and
 * the page visible (the connections refresh when the panel opens, on window
 * focus while it is open, and after a connect returns; the context when it
 * opens and after each reply), no idle
 * animation (the computer card's bot moves only while someone is watching:
 * bots/agent-bot.tsx); the row re-renders only when a panel's mode changes, never per
 * frame of a resize (a resize that only changes how far the content moves
 * sets the strip's margins on the row's CSS variables, no render).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { useHotkeys } from '@/lib/hotkeys'
import { useConnections } from '@/lib/integrations/use-connections'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { CardHeading, type SummaryTone } from './card-heading'
import { AgentsSection, PlanSection, planHeaderCount, useAgentsSummary } from '../chat/chat-widgets'
import { useChatFeed } from './chat-feed'
import { ConnectionsSection, connectionsSummary } from './connections-section'
import { EnvironmentSection, useEnvironmentCard } from './environment-section'
import { ContextSection, contextSummary } from './context-section'
import { ComputerSection, agentBotState, agentSummary } from './computer-section'
import { AgentEditButton, AgentEditorHost, AgentLookButton } from '@/components/bots/agent-editor'
import { AgentCallButton } from '@/components/bots/agent-call-button'
import { useComputer, useComputerPolling } from '@/lib/cloud-browser/computer-client'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { useChatContext } from '@/lib/chat/context-client'
import {
  CHAT_THREAD_SELECTOR,
  getServerSidePanelState,
  getSidePanelState,
  moveSection,
  restoreChatAnchor,
  reportSpacePlan,
  setConnectionsAttention,
  setRightPanelOpen,
  subscribeSidePanels,
  toggleRightPanel,
  type SectionId,
  type SidePanelState,
} from './side-panel-store'
import {
  CHAT_CONTENT_MAX_PX,
  NO_PANELS,
  PANEL_GUTTER_PX,
  PANEL_SLIDE_MS,
  RIGHT_PANEL_WIDTH_PX,
  TOP_BAR_FADE_PX,
  planKeyOf,
  planSpace,
  type PanelMode,
  type SpacePlan,
} from './space-plan'

export function useSidePanelState(): SidePanelState {
  return useSyncExternalStore(subscribeSidePanels, getSidePanelState, getServerSidePanelState)
}

/** The app rail's breakpoint (tailwind.css `[data-app-rail]`, Tailwind's `md`). */
export const FOR_YOU_ALWAYS_QUERY = '(min-width: 768px)'

function wideQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(FOR_YOU_ALWAYS_QUERY) : null
}
function subscribeWide(listener: () => void): () => void {
  const query = wideQuery()
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}
const getWide = () => wideQuery()?.matches ?? false
const getWideServer = () => false

/**
 * For you shows by itself (Liam, 11-09: no toggle; "just show that stuff all
 * the time if you have any"): from `md` up, where the app rail is. Below it
 * (a phone) it waits for its top-bar toggle, as before. One media query
 * listener; false on the server and the first client render.
 */
export function useForYouAlways(): boolean {
  return useSyncExternalStore(subscribeWide, getWide, getWideServer)
}

/**
 * Where the panels go in a row this wide, as the store says they are. With
 * `always` (useForYouAlways: from `md` up) For you shows whenever it has
 * cards, making room where it fits and floating over the chat's edge where it
 * doesn't, whatever the device remembered. Without (a phone), as the device
 * remembered it, it shows where it makes room, and floats only once opened by
 * hand this session. `content` is the chat's widest content
 * (measureChatContent), `was` the plan in force (the hysteresis).
 */
export function planFor(
  width: number,
  state: Pick<SidePanelState, 'rightOpen' | 'leftOpen' | 'leftContent' | 'leftFloatOk' | 'captureDock'>,
  { content, was = null, always = false }: { content?: number; was?: SpacePlan | null; always?: boolean } = {},
): SpacePlan {
  const input = { width, right: state.rightOpen, content, dock: state.captureDock, was }
  const plan = planSpace({ ...input, left: state.leftContent && (always || state.leftOpen) })
  if (plan.left === 'float' && !always && !state.leftFloatOk) return planSpace({ ...input, left: false })
  return plan
}

/** The row's CSS variables holding the chat strip's margins (dashboard-shell.tsx reads them). */
export const INSET_LEFT_VAR = '--side-panel-inset-left'
export const INSET_RIGHT_VAR = '--side-panel-inset-right'

/**
 * How wide the chat's content stands at its cap, px: the reading column's
 * cap (--chat-reading-max, the token the conversation, the composer and the
 * inline cards share), widened by any card in the conversation reaching past
 * the column, as a share of the column (so it holds whatever the strip's
 * width is now). A kept page waiting out of sight (inert) never counts.
 */
export function measureChatContent(row: HTMLElement): number {
  const cap = parseFloat(getComputedStyle(row).getPropertyValue('--chat-reading-max')) || CHAT_CONTENT_MAX_PX
  const column = row.querySelector<HTMLElement>(CHAT_THREAD_SELECTOR)
  const box = column?.getBoundingClientRect()
  if (!column || !box || !(box.width > 0)) return cap
  const centre = box.left + box.width / 2
  let half = box.width / 2
  for (const card of column.querySelectorAll<HTMLElement>('[data-chat-card]')) {
    if (card.closest('[inert]')) continue
    const r = card.getBoundingClientRect()
    if (r.width > 0) half = Math.max(half, centre - r.left, r.right - centre)
  }
  return Math.round((cap * 2 * half) / box.width)
}

/**
 * The row's space plan. Re-planned when the store changes (a toggle, For you
 * showing or hiding, the capture's notepad docking) and as the row resizes
 * (the chat's content measured again then). A render only when a panel's
 * mode changes: a resize that only changes how far the content moves writes
 * the strip's margins on the row's CSS variables (INSET_LEFT_VAR /
 * INSET_RIGHT_VAR) straight from the ResizeObserver, so the returned plan's
 * insets are as of its last render and the row's variables are the live
 * ones. After a toggle the chat goes back to where it was from its bottom,
 * before paint, and the crew hears whether the strip still holds it.
 */
export function useSidePanelPlan(rowRef: RefObject<HTMLElement | null>): SpacePlan {
  const state = useSidePanelState()
  const stateRef = useRef(state)
  stateRef.current = state
  const always = useForYouAlways()
  const alwaysRef = useRef(always)
  alwaysRef.current = always
  // The row's width and the chat's content in refs: a render only when they change the modes.
  const widthRef = useRef(0)
  const contentRef = useRef(CHAT_CONTENT_MAX_PX)
  // The plan on the row now: what the hysteresis holds to.
  const appliedRef = useRef<SpacePlan>(NO_PANELS)
  const [modesTick, setModesTick] = useState(0)

  const apply = useCallback(
    (plan: SpacePlan) => {
      appliedRef.current = plan
      const row = rowRef.current
      if (row) {
        setPxVar(row, INSET_LEFT_VAR, plan.insetLeft)
        setPxVar(row, INSET_RIGHT_VAR, plan.insetRight)
      }
      reportSpacePlan(plan.left !== 'off')
    },
    [rowRef],
  )

  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    const measure = () => {
      // The laid-out width (never the drawn one: a window gliding to a snap is drawn scaled).
      const width = el.clientWidth
      const content = measureChatContent(el)
      if (width === widthRef.current && content === contentRef.current) return
      widthRef.current = width
      contentRef.current = content
      const next = planFor(width, stateRef.current, { content, was: appliedRef.current, always: alwaysRef.current })
      if (planKeyOf(next) !== planKeyOf(appliedRef.current)) setModesTick((n) => n + 1)
      else apply(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [rowRef, apply])

  const computed = useMemo(
    () => planFor(widthRef.current, state, { content: contentRef.current, was: appliedRef.current, always }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- modesTick says the refs moved the modes
    [state, always, modesTick],
  )
  // On the row before paint; then the chat's re-wrapped text goes back to the
  // same distance from its bottom (after a toggle, in the commit that moved it).
  useLayoutEffect(() => {
    apply(computed)
    restoreChatAnchor()
  }, [computed, apply])
  // One reference while the plan is the same, whatever re-planned it.
  const key = `${planKeyOf(computed)}|${computed.insetLeft}|${computed.insetRight}`
  // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the plan
  return useMemo(() => computed, [key])
}

function setPxVar(el: HTMLElement, name: string, px: number): void {
  const value = `${px}px`
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
}

/**
 * The slide, on the compositor (motion-reduce: none). Tailwind 4's
 * `translate-x-*` sets the separate `translate` property, not `transform`,
 * so `translate` is what transitions: a `transform` transition would never
 * run and the panel would snap.
 */
export const SLIDE_CLASS = 'transition-[translate,visibility] ease-out motion-reduce:transition-none'
export const SLIDE_STYLE: CSSProperties = { transitionDuration: `${PANEL_SLIDE_MS}ms` }

/**
 * Both panels' top (this one's and For you's): below the top bar and clear of
 * its blur (TOP_BAR_FADE_PX), half a gutter after it. The window's gutter at
 * the other three sides.
 */
export const PANEL_TOP = `calc(var(--chat-top-inset, 0px) + ${TOP_BAR_FADE_PX + PANEL_GUTTER_PX / 2}px)`

/**
 * The right side panel. Always rendered by the row (its toggle's shortcut and
 * the connections' status read live here, for the toggle's dot), the panel
 * itself from its first open.
 */
export function RightSidePanel({ mode }: { mode: PanelMode }) {
  const state = useSidePanelState()
  const open = mode !== 'off'
  const [mounted, setMounted] = useState(open)
  if (open && !mounted) setMounted(true)

  // ⌘\ anywhere (the composer too: it's a chord, never typed text).
  useHotkeys([{ key: '\\', mod: true, allowInInput: true, handler: () => toggleRightPanel() }])

  // The connections: read at load (so the toggle's dot can show), when the
  // panel opens, on focus while it is open, and after a connect returns.
  const connections = useConnections({ active: open })
  useEffect(() => {
    setConnectionsAttention(connections.needsAttention)
  }, [connections.needsAttention])

  // Floating over the chat it ends above the composer, never over it.
  const composer = useComposerReserve(open && mode === 'float')
  const bottom = composer > 0 ? composer + PANEL_GUTTER_PX : PANEL_GUTTER_PX

  const panelRef = useRef<HTMLElement>(null)
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    e.preventDefault()
    setRightPanelOpen(false)
    document.querySelector<HTMLElement>('[data-side-panel-toggle]')?.focus()
  }

  if (!mounted) return null
  return (
    <aside
      ref={panelRef}
      id={RIGHT_PANEL_ID}
      aria-label="Side panel"
      data-side-panel={mode}
      tabIndex={-1}
      inert={!open}
      aria-hidden={!open || undefined}
      onKeyDown={onKeyDown}
      // No box of its own: a click-through column, its cards take the pointer.
      className={cn(
        'pointer-events-none absolute z-[25] flex flex-col focus-visible:outline-none',
        SLIDE_CLASS,
        open ? 'visible translate-x-0' : 'invisible translate-x-[calc(100%+1rem)]',
      )}
      style={{ ...SLIDE_STYLE, top: PANEL_TOP, right: PANEL_GUTTER_PX, bottom, width: RIGHT_PANEL_WIDTH_PX }}
    >
      {/* As tall as its cards (down to the panel's bottom, then it scrolls), a hair of room round them for their lift and focus rings. */}
      <div
        data-side-panel-cards=""
        className="pointer-events-none -mx-1 flex min-h-0 flex-col gap-2.5 overflow-y-auto overscroll-contain px-1 pb-1 scrollbar-hide-deep"
      >
        <PanelSections open={open} state={state} connections={connections} />
      </div>
    </aside>
  )
}

export const RIGHT_PANEL_ID = 'dial8-side-panel'

/** The main chat's composer dock (chat-panel.tsx): the composer and what rises above it. */
export const COMPOSER_DOCK_SELECTOR = '#dial8-chat-strip-slot [data-chat-composer-dock]'

/**
 * How tall the main chat's composer dock stands, px, followed while `active`
 * (a panel floating over the chat, which must end above the composer). Event
 * driven: a ResizeObserver on the dock, found again when its node goes (a
 * chat remount reports the old one shrinking to nothing). 0 while inactive.
 */
export function useComposerReserve(active: boolean): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (!active || typeof document === 'undefined') return
    let dock: HTMLElement | null = null
    let observer: ResizeObserver | null = null
    const measure = () => {
      if (!dock?.isConnected) {
        attach()
        return
      }
      const next = dock.offsetHeight
      setHeight((was) => (was === next ? was : next))
    }
    const attach = () => {
      const next = document.querySelector<HTMLElement>(COMPOSER_DOCK_SELECTOR)
      if (next !== dock) {
        if (dock) observer?.unobserve(dock)
        dock = next
        if (dock) observer?.observe(dock)
      }
      const h = dock?.offsetHeight ?? 0
      setHeight((was) => (was === h ? was : h))
    }
    observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    attach()
    return () => {
      observer?.disconnect()
      setHeight(0)
    }
  }, [active])
  return height
}

const SECTION_TITLE: Record<SectionId, string> = {
  computer: 'Computer',
  agents: 'Agents',
  plan: 'Plan',
  context: 'Context',
  environment: 'Environment',
  connections: 'Connectors',
}

/** One card's part in the column: what it says closed, and its body. */
interface SectionSpec {
  id: SectionId
  title: string
  summary: string | null
  tone?: SummaryTone
  /** A face before the title (the computer card's agent). */
  avatar?: ReactNode
  /** A control at the row's far right (the agent card's settings). */
  action?: ReactNode
  /** The body's padding, when its rows don't bring their own. */
  bodyClassName?: string
  body: ReactNode
}

function PanelSections({
  open,
  state,
  connections,
}: {
  open: boolean
  state: Pick<SidePanelState, 'sectionOpen' | 'order'>
  connections: ReturnType<typeof useConnections>
}) {
  const agents = useAgentsSummary()
  const { plan, conversationId, busy } = useChatFeed()
  // The main chat's context: read when the panel opens and after each reply.
  const context = useChatContext({ conversationId, active: open, busy })
  const { sectionOpen, order } = state
  const { groups, loading } = connections
  const connectors = useMemo(() => connectionsSummary({ groups, loading }), [groups, loading])
  // Where the main chat's work runs; a Mac's folders read every 30 s while the panel is open.
  const environment = useEnvironmentCard({ open, conversationId })
  // The agent's computer (its cloud browser): read every 15 s while the panel is open, its preview while it runs.
  const computer = useComputer()
  useComputerPolling(open)
  const { name: assistantName } = useAssistantName()

  const specs: Partial<Record<SectionId, SectionSpec>> = {}
  // The agent's card always shows (Liam, 10-24), its computer or not: with none yet, its row starts one.
  specs.computer = {
    id: 'computer',
    // The agent's own card: its bot (a click edits its look) and its name, its status under it (its computer's is on the row below).
    title: assistantName,
    summary: agentSummary(computer),
    avatar: <AgentLookButton name={assistantName} state={agentBotState(computer)} active={open} size={56} />,
    action: <AgentEditButton name={assistantName} />,
    bodyClassName: 'pb-1.5',
    body: (
      <>
        {/* Call: the main chat's voice mode (desktop only; nothing where there's no voice mode). */}
        <AgentCallButton name={assistantName} className="px-3 pb-1 pt-0.5" />
        <ComputerSection computer={computer} name={assistantName} />
      </>
    ),
  }
  if (agents.running > 0) {
    specs.agents = {
      id: 'agents',
      title: SECTION_TITLE.agents,
      summary: `${agents.running} running`,
      // Its once-a-minute redraw only while its rows can be seen.
      body: <AgentsSection summary={agents} active={open && sectionOpen.agents} />,
    }
  }
  if (plan) specs.plan = { id: 'plan', title: SECTION_TITLE.plan, summary: planHeaderCount(plan), body: <PlanSection plan={plan} /> }
  // Nothing measured yet (a new chat, or before the first read), no card.
  const contextLine = contextSummary(context.context)
  if (contextLine) {
    specs.context = {
      id: 'context',
      title: SECTION_TITLE.context,
      summary: contextLine,
      // Its body pads itself 12px (context-section.tsx).
      bodyClassName: 'pb-2',
      body: <ContextSection state={context} busy={busy} />,
    }
  }
  // Nothing to show, no card (the chat has no environment, or before the first read).
  if (environment) {
    specs.environment = {
      id: 'environment',
      title: SECTION_TITLE.environment,
      summary: environment.summary,
      // Its rows pad themselves 12px (environment-section.tsx), Add folder… under them.
      bodyClassName: 'pb-1.5',
      body: <EnvironmentSection card={environment} />,
    }
  }
  specs.connections = {
    id: 'connections',
    title: SECTION_TITLE.connections,
    summary: connectors?.text ?? null,
    tone: connectors?.tone,
    // Its rows pad themselves 12px (connections-section.tsx), Show more / Manage connectors under them.
    bodyClassName: 'pb-1.5',
    body: <ConnectionsSection connections={connections} />,
  }
  // The agent's card stays first, out of the order (Liam, 10-23: "the agent card should always be at the top ... I shouldn't
  // be able to move that one"); the others stand in the person's order beneath it, and move only among themselves.
  const pinned = specs.computer ?? null
  const shown = order.flatMap((id) => (id === 'computer' ? [] : (specs[id] ?? [])))
  const visible = shown.map((s) => s.id)

  // A keyboard move keeps the focus on the moved card's handle (React moves the
  // keyed cards, and a moved node loses its focus), and says where it went.
  const [announcement, setAnnouncement] = useState('')
  const refocus = useRef<SectionId | null>(null)
  const onMove = (id: SectionId, to: number) => {
    if (document.activeElement?.closest(`[data-side-panel-drag-handle="${id}"]`)) refocus.current = id
    moveSection(id, to, visible)
    setAnnouncement(`${specs[id]?.title ?? SECTION_TITLE[id]} moved to ${to + 1} of ${visible.length}`)
  }
  useLayoutEffect(() => {
    const id = refocus.current
    refocus.current = null
    if (!id) return
    const handle = document.querySelector<HTMLElement>(`#${RIGHT_PANEL_ID} [data-side-panel-drag-handle="${id}"]`)
    if (handle && document.activeElement !== handle) handle.focus()
  }, [order])

  return (
    <>
      {/* The agent's editor, opened from its card (its bot, its settings icon); hosted here so a draft outlives the card. */}
      <AgentEditorHost />
      {pinned && <PanelSection key={pinned.id} spec={pinned} open={sectionOpen[pinned.id]} index={0} count={1} onMove={onMove} pinned />}
      {shown.map((spec, index) => (
        <PanelSection key={spec.id} spec={spec} open={sectionOpen[spec.id]} index={index} count={shown.length} onMove={onMove} />
      ))}
      <div aria-live="polite" data-side-panel-announce="" className="sr-only">
        {announcement}
      </div>
    </>
  )
}

/**
 * One floating card in the panel's column: the For you cards' surface, the
 * pointer's (the column is not). A pinned card (the agent's) is not one of
 * the cards a drag moves among (card-drag.ts CARD_SELECTOR).
 */
function PanelCard({ id, title, pinned = false, children }: { id: SectionId; title: string; pinned?: boolean; children: ReactNode }) {
  return (
    <section
      data-side-panel-section={id}
      data-side-panel-card={pinned ? undefined : ''}
      data-side-panel-pinned={pinned ? '' : undefined}
      aria-label={title}
      className={cn('pointer-events-auto relative shrink-0', FLOATING_CARD_CLASS)}
    >
      {children}
    </section>
  )
}

/** A section's card: its row opens it (remembered per device), plain rows beneath. A pinned one has no handle. */
function PanelSection({
  spec,
  open,
  index,
  count,
  onMove,
  pinned = false,
}: {
  spec: SectionSpec
  open: boolean
  index: number
  count: number
  onMove: (id: SectionId, to: number) => void
  pinned?: boolean
}) {
  const { id, title, summary, tone, avatar, action, bodyClassName, body } = spec
  const bodyId = `side-panel-${id}`
  return (
    <PanelCard id={id} title={title} pinned={pinned}>
      <CardHeading id={id} title={title} summary={summary} tone={tone} avatar={avatar} action={action} open={open} bodyId={bodyId} index={index} count={count} onMove={onMove} />
      {/* Its rows pad themselves 8px: 4px more here keeps them 12px off the edge, under the row. */}
      <div id={bodyId} hidden={!open} className={bodyClassName ?? 'px-1 pb-1.5'}>
        {body}
      </div>
    </PanelCard>
  )
}
