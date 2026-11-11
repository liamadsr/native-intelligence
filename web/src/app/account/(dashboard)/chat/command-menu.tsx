'use client'

/**
 * The composer's one menu: pages, skills and every record kind, `/` opening
 * and `@` mentioning (command-menu-model.ts says what it lists and why;
 * docs/plans/slash-search.md).
 *
 * Two frames, one body:
 *  • inline — above the composer, while `/` or `@` is typed in the box. The
 *    text in the box is the query and the caret never leaves it: the box's
 *    keys reach the menu through `menuRef` (handleKey), and a press anywhere
 *    on the menu keeps the box focused.
 *  • palette — centred over the app, with a search field of its own: `/`
 *    pressed anywhere outside a text field, ⌘K, or the top bar's search
 *    button (chat-input.tsx). The field is focused in the same task as the
 *    key that opened it, so nothing typed after the `/` can land anywhere
 *    else. Opened from the button it arrives flying out of it
 *    (`arriving`: card-reply-flight.ts) instead of fading in.
 */
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import {
  AppWindow,
  AudioLines,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  Building2,
  CalendarDays,
  CircleCheck,
  FileText,
  Hash,
  FlaskConical,
  FolderKanban,
  Handshake,
  LayoutList,
  Mail,
  Megaphone,
  Paperclip,
  Search,
  Send,
  Target,
  Telescope,
  User,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { LibraryItemIcon } from '@/components/library-item-icon'
import { cn } from '@/lib/utils'
import type { OfferedPage } from '@/lib/chat-cards/page-menu'
import type { MenuFileRow, MenuSearchKind, MenuSearchRow } from '@/lib/search/menu-search'
import { formatCaptureDate } from '../views/capture-utils'
import type { SkillCommand } from './chat-panel'
import { companySubline, contactSubline } from './mention-picker'
import {
  menuTabLabel,
  buildMenu,
  cycleTab,
  hostRecordOffer,
  isRecordKind,
  menuTakesEnter,
  mentionOptionsMenu,
  offeredKinds,
  searchedKinds,
  serverSearch,
  verbFor,
  type ComposerMentionList,
  type MenuItem,
  type MenuOffer,
  type MenuSection,
  type MenuTab,
  type MenuTrigger,
  type MenuVerb,
} from './command-menu-model'
import { useMenuSearch, usePrefetchMenuSearch } from './use-menu-search'
import { SEARCH_FLIGHT_KEY, landFlight } from '@/lib/chat/card-reply-flight'
import { measureChatReadingColumn } from './picker-popover'
import { useFloatingChatContainerRef } from './floating-chat'
import { useWorkspaceEdition } from '../../workspace-switcher'
import { frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { isDirectEntityAction, runEntityAction } from '@/lib/entities/actions'
import { entityActionsDescriptor, supportedEntityActions } from '@/lib/entities/entity-actions-registry'
import { ENTITY_ACTION_ICONS, ENTITY_ACTION_LABELS } from '@/components/entities/entity-actions-menu'
import type { RecordActionsSource } from './command-menu-model'
import { usePaletteFeed } from './use-palette-feed'
import { describeFeedEvent, feedActorLabel, sharedWithYouLine, type FeedEntry } from '@/lib/entities/feed-model'
import { entityOpenTarget } from '@/lib/entity-links/open-entity'
import { openTarget } from '@/lib/chat-cards/open-card'
import { format, formatDistanceToNowStrict } from 'date-fns'

/** What the composer's field hands the inline menu: its keys. */
export interface CommandMenuHandle {
  /** A key pressed in the field. True: the menu took it (the field does nothing with it). */
  handleKey: (e: KeyboardEvent | React.KeyboardEvent) => boolean
}

export interface CommandMenuProps {
  open: boolean
  /** Above the composer, read from the box ('inline'), or centred with its own field ('palette'). */
  variant?: 'inline' | 'palette'
  /** What opened it: `/` leads with pages and skills, `@` with people, companies and captures. */
  trigger?: MenuTrigger
  /** Inline: what's typed after the trigger. (The palette searches its own field.) */
  query: string
  skills: readonly SkillCommand[]
  /** Pages it may open (the main chat's). Absent: no pages. */
  pages?: readonly OfferedPage[]
  onSelectPage?: (page: OfferedPage) => void
  onSelectSkill: (skill: SkillCommand) => void
  /** Open a record's card (the main chat). Absent: records only mention. */
  onOpenRecord?: (row: MenuSearchRow) => void
  /** Put a record in the message: only the kinds in `mentionKinds`. */
  onMentionRecord?: (row: MenuSearchRow) => void
  mentionKinds?: readonly MenuSearchKind[]
  /** What's already attached to the turn, by kind: left out. */
  exclude?: Partial<Record<MenuSearchKind, readonly string[]>>
  /**
   * The host's own `@` list (team chat's agent and members): inline, `@`
   * lists these, narrowed by what's typed, in place of the record search
   * (none runs). Absent: the records, as ever.
   */
  mentionList?: ComposerMentionList
  /** Esc, a press outside the palette, Backspace in its empty field. */
  onDismiss: () => void
  /** The palette arrives flying from the top bar's search button (SEARCH_FLIGHT_KEY), not fading in. */
  arriving?: boolean
  /** An Enter the menu held for an answer that found nothing: the box's own (it sends). */
  onUnclaimedEnter?: () => void
  /** The composer (the inline menu opens above it). */
  anchorRef: React.RefObject<HTMLElement | null>
  menuRef?: React.Ref<CommandMenuHandle>
  /**
   * Inline, away from a chat (a document's `@`): which side of the anchor the
   * menu opens on, how wide it is, and what Enter says for a mention. Absent:
   * above the composer, the chat's reading column wide, "add to chat".
   */
  placement?: { side: 'top' | 'bottom'; width: number; mentionWord?: string }
}

const PAGE_ICONS: Record<string, LucideIcon> = {
  calendar: CalendarDays,
  actions: CircleCheck,
  captures: AudioLines,
  docs: BookOpen,
  knowledge: Brain,
  initiatives: Target,
  projects: FolderKanban,
  flows: Workflow,
  mail: Mail,
  contacts: Users,
  companies: Building2,
  prospecting: Telescope,
  sequences: Send,
  campaigns: Megaphone,
  evals: FlaskConical,
  browser: AppWindow,
  agents: Boxes,
  teams: Users,
}

/** How long Enter typed ahead of the answer waits for it before taking what's there. */
const ENTER_WAIT_MS = 2000

/** A verb as the footer and the highlighted row say it. */
const VERB_LABEL: Record<MenuVerb, string> = { open: 'open', use: 'use', mention: 'add to chat' }

/**
 * A verb as said for this item: a host's own option or record (team chat's)
 * is mentioned, not added to a chat; so is everything where the menu says so
 * (`mentionWord`: a document's).
 */
function verbLabel(verb: MenuVerb, item: MenuItem | undefined, mentionWord?: string): string {
  const host = item?.kind === 'option' || (item?.kind === 'record' && item.host)
  if (verb === 'mention' && mentionWord) return mentionWord
  return verb === 'mention' && host ? 'mention' : VERB_LABEL[verb]
}

/** The record kinds no composer mentions (nothing to attach them by). */
const NO_MENTIONS: readonly MenuSearchKind[] = []
/** A host's record search lists no pages or skills. */
const NO_PAGES: readonly OfferedPage[] = []
const NO_SKILLS: readonly SkillCommand[] = []

export function CommandMenu({
  open,
  variant = 'inline',
  trigger = '/',
  query: typedQuery,
  skills,
  pages,
  onSelectPage,
  onSelectSkill,
  onOpenRecord,
  onMentionRecord,
  mentionKinds = NO_MENTIONS,
  exclude,
  mentionList,
  onDismiss,
  onUnclaimedEnter,
  arriving = false,
  anchorRef,
  menuRef,
  placement,
}: CommandMenuProps) {
  const palette = variant === 'palette'
  const [tab, setTab] = useState<MenuTab>('all')
  const [search, setSearch] = useState('')
  // The palette is `/`: search, to open. Attaching (`@`) is a chat box's alone.
  // (A `/` in its field closes it: see onKey below.)
  const activeTrigger: MenuTrigger = palette ? '/' : trigger
  const query = palette ? search : typedQuery
  // The host's own `@` list, in place of the records (inline only).
  const hostOptions = !palette && activeTrigger === '@' && mentionList ? mentionList.options : null

  const offeredPages = useMemo(() => (pages && onSelectPage ? pages : []), [pages, onSelectPage])
  // The palette over a record's card: that record's own actions lead (the
  // entity actions menu's, less Rename and Share, which need more input).
  const front = useSyncExternalStore(subscribeFrontCard, frontCard, noFrontCard)
  const recordActions = useMemo(() => (palette ? recordActionsFor(front) : null), [palette, front])
  // The palette's first view: what's waiting on the person, and what they touched last.
  const feed = usePaletteFeed(palette && open)
  // The tabs and sections in the workspace's words ("Jobs", "Customers" in a service business).
  const edition = useWorkspaceEdition()
  const mentionKey = onMentionRecord ? mentionKinds.join(',') : ''
  const offer = useMemo<MenuOffer>(
    () => ({
      pages: offeredPages.length > 0,
      skills: skills.length > 0,
      open: !!onOpenRecord,
      mention: new Set(mentionKey ? (mentionKey.split(',') as MenuSearchKind[]) : []),
    }),
    [offeredPages.length, skills.length, onOpenRecord, mentionKey],
  )
  // `/` lists what opens; `@` what this composer can attach.
  const offered = useMemo(() => offeredKinds(activeTrigger, offer), [activeTrigger, offer])
  const currentTab = tab === 'all' || offered.includes(tab) ? tab : 'all'

  // A host's own list may also find records (team chat: mentionList.records),
  // listed under its options once something is typed.
  const hostRecordKey = hostOptions && mentionList?.records ? mentionList.records.kinds.join(',') : ''
  const hostOffer = useMemo(
    () => (hostRecordKey ? hostRecordOffer(hostRecordKey.split(',') as MenuSearchKind[]) : null),
    [hostRecordKey],
  )
  const hostOffered = useMemo(() => (hostOffer ? offeredKinds('@', hostOffer) : []), [hostOffer])
  const hostSearches = !!hostOffer && query.trim().length > 0

  // Records come from the server (one request a keystroke, debounced); pages
  // and skills are searched here, at once, on every key.
  const wanted = !open
    ? null
    : hostOptions
      ? hostSearches
        ? serverSearch('@', 'all', query, hostOffered)
        : null
      : serverSearch(activeTrigger, currentTab, query, offered)
  const found = useMenuSearch(wanted, query, exclude)
  // Closed: what each shows first (recent people…) is fetched ahead, so the first `/` or `@` doesn't shift under it.
  const firstSlash = useMemo(() => serverSearch('/', 'all', '', offeredKinds('/', offer)), [offer])
  const firstAt = useMemo(() => serverSearch('@', 'all', '', offeredKinds('@', offer)), [offer])
  usePrefetchMenuSearch(open || palette ? null : firstSlash)
  usePrefetchMenuSearch(open || palette || mentionList ? null : firstAt)

  const { sections, tabs } = useMemo(
    () =>
      hostOptions
        ? mentionOptionsMenu(
            hostOptions,
            query,
            hostOffer && hostSearches
              ? buildMenu('@', 'all', query, hostOffer, { pages: NO_PAGES, skills: NO_SKILLS, records: found.records, edition })
              : undefined,
          )
        : buildMenu(activeTrigger, currentTab, query, offer, {
            pages: offeredPages,
            skills,
            records: found.records,
            edition,
            recordActions,
            inbox: palette ? feed.inbox : null,
            recent: palette ? feed.recent : null,
          }),
    [hostOptions, hostOffer, hostSearches, activeTrigger, currentTab, query, offer, offeredPages, skills, found.records, edition, recordActions, palette, feed],
  )
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections])

  // The highlight starts over on the top row whenever the list changes under
  // it (a keystroke, a tab, the server's answer): kept with the list it was
  // for, so a stale index is never read, and no effect has to reset it.
  const listKey = `${activeTrigger}|${currentTab}|${query}|${items.length}`
  const [highlight, setHighlightState] = useState({ key: listKey, index: 0 })
  const highlighted = highlight.key === listKey ? Math.min(highlight.index, Math.max(items.length - 1, 0)) : 0
  const setHighlight = useCallback((index: number) => setHighlightState({ key: listKey, index }), [listKey])

  // The inline menu shows while it has rows, or is finding the first ones, or
  // was turned to a tab of its own. Nothing matching what's typed: it steps
  // aside, and the keys are the box's again (Enter sends `/usr/bin`).
  // Loading counts only where records show (a Pages tab never waits on the server).
  // A host's records never hold the keys while they load: its Enter picks its
  // own option at once, or sends (team chat's "@Joseph what changed?⏎").
  const showsRecords = !hostOptions && searchedKinds(activeTrigger, currentTab, query, offered).some(isRecordKind)
  const loadingFirst = found.loading && items.length === 0 && showsRecords
  // The answer for what's typed is still on its way: it may put a better row on top.
  const searching = found.searching && showsRecords
  // Finding the first rows shows ("Searching…") whatever is typed, so an Enter
  // pressed then is the menu's (it waits) and never sends a half-typed `/tom`.
  const visible = open && (palette || items.length > 0 || currentTab !== 'all' || loadingFirst)

  // The list and its rows, by id: the field (the palette's, or the box while
  // the inline menu shows) points at the highlighted row (aria-activedescendant).
  const baseId = useId()
  const listId = `${baseId}-list`
  const rowId = useCallback((index: number) => `${baseId}-row-${index}`, [baseId])
  const activeId = visible && items.length ? rowId(highlighted) : undefined

  const pick = useCallback(
    (item: MenuItem | undefined, verb: MenuVerb) => {
      if (!item) return
      if (item.kind === 'entity_action') {
        void runEntityAction(item.action, item.entity, { from: 'palette' })
        onDismiss()
      } else if (item.kind === 'feed') {
        const target = entityOpenTarget(item.entry.type, item.entry.id, item.entry.label)
        if (target) openTarget(target, { from: 'palette' })
        onDismiss()
      } else if (item.kind === 'page') onSelectPage?.(item.page)
      else if (item.kind === 'skill') onSelectSkill(item.skill)
      else if (item.kind === 'option') mentionList?.onPick(item.option)
      else if (verb === 'open') onOpenRecord?.(item.row)
      else onMentionRecord?.(item.row)
    },
    [onSelectPage, onSelectSkill, onOpenRecord, onMentionRecord, mentionList, onDismiss],
  )
  const verbs = useCallback((item: MenuItem) => verbFor(activeTrigger, item), [activeTrigger])

  // Enter typed straight after the words (`/tom⏎`), before their answer is
  // back: it waits for that answer and picks what's on top then, so it opens
  // Tom rather than the page that happened to match first. A row arrowed to
  // is picked at once; a new keystroke or Esc lets the wait go, and an answer
  // that never comes lets it go after ENTER_WAIT_MS with what's there.
  const [waitingEnter, setWaitingEnter] = useState<{ query: string } | null>(null)
  const pickNow = useCallback((item: MenuItem | undefined) => item && pick(item, verbs(item)), [verbs, pick])
  const waitingFor = waitingEnter && waitingEnter.query === query ? waitingEnter : null
  useEffect(() => {
    if (!waitingFor) return
    const settle = () => {
      setWaitingEnter(null)
      // Nothing found after all: the Enter was the box's (it sends what's typed).
      if (items[0]) pickNow(items[0])
      else onUnclaimedEnter?.()
    }
    if (!searching) {
      settle()
      return
    }
    const t = setTimeout(settle, ENTER_WAIT_MS)
    return () => clearTimeout(t)
  }, [waitingFor, searching, items, pickNow, onUnclaimedEnter])

  const handleKey = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent): boolean => {
      if (!visible) return false
      const native = 'nativeEvent' in e ? e.nativeEvent : e
      if (native.isComposing || native.keyCode === 229) return false
      const n = items.length
      switch (e.key) {
        case 'ArrowDown':
          if (n) setHighlight((highlighted + 1) % n)
          return true
        case 'ArrowUp':
          if (n) setHighlight((highlighted - 1 + n) % n)
          return true
        case 'Enter': {
          // Shift+Enter is still a new line (it ends the trigger, too); ⌘↵ is the box's own.
          if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return false
          // No rows: the box's own Enter (send), unless the first rows are
          // still loading, when it waits (menuTakesEnter).
          if (!menuTakesEnter(n, loadingFirst)) return false
          // The answer for what's typed isn't back and no row was chosen: wait for it.
          if (searching && highlighted === 0) {
            setWaitingEnter({ query })
            return true
          }
          const item = items[highlighted]
          if (!item) return true
          pick(item, verbs(item))
          return true
        }
        case 'Tab':
          if (e.altKey || e.metaKey || e.ctrlKey) return false
          // One kind only: no tabs shown, nothing to switch (the key still
          // stays in the menu rather than moving the focus on).
          if (tabs.length > 2) setTab(cycleTab(tabs, currentTab, e.shiftKey ? -1 : 1))
          return true
        case 'Escape':
          setWaitingEnter(null)
          onDismiss()
          return true
        default:
          return false
      }
    },
    [visible, items, highlighted, setHighlight, pick, verbs, tabs, currentTab, onDismiss, loadingFirst, searching, query],
  )
  useImperativeHandle(menuRef, () => ({ handleKey }), [handleKey])

  // The inline menu's field is the composer's box, which the menu doesn't
  // render: while the menu shows, the box is marked as its combobox here, on
  // the element, so the highlight moving re-renders the menu alone, not the
  // composer (the palette's own field takes the same attributes as props).
  const inlineShown = !palette && visible
  useLayoutEffect(() => {
    if (!inlineShown) return
    const field = anchorRef.current?.querySelector('textarea')
    if (!field) return
    field.setAttribute('role', 'combobox')
    field.setAttribute('aria-expanded', 'true')
    field.setAttribute('aria-controls', listId)
    field.setAttribute('aria-autocomplete', 'list')
    return () => {
      for (const name of ['role', 'aria-expanded', 'aria-controls', 'aria-autocomplete', 'aria-activedescendant']) {
        field.removeAttribute(name)
      }
    }
  }, [inlineShown, anchorRef, listId])
  useLayoutEffect(() => {
    if (!inlineShown) return
    const field = anchorRef.current?.querySelector('textarea')
    if (!field) return
    if (activeId) field.setAttribute('aria-activedescendant', activeId)
    else field.removeAttribute('aria-activedescendant')
  }, [inlineShown, anchorRef, activeId])

  const body = (
    <MenuBody
      tabs={tabs}
      tab={currentTab}
      onTab={setTab}
      sections={sections}
      items={items}
      highlighted={highlighted}
      onHighlight={setHighlight}
      onPick={(item) => pick(item, verbs(item))}
      verbs={verbs}
      loading={loadingFirst}
      query={query}
      palette={palette}
      listId={listId}
      rowId={rowId}
      mentionWord={placement?.mentionWord}
    />
  )

  if (palette) {
    if (!open) return null
    return (
      <PaletteFrame
        search={search}
        onSearch={setSearch}
        onKey={(e) => {
          // `/` again closes it: `/` opens and closes the palette (Liam, 10-20).
          if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            e.stopPropagation()
            onDismiss()
            return
          }
          if (handleKey(e)) {
            e.preventDefault()
            e.stopPropagation()
          } else if (e.key === 'Backspace' && !search) {
            e.preventDefault()
            onDismiss()
          }
        }}
        onDismiss={onDismiss}
        listId={listId}
        activeId={activeId}
        arriving={arriving}
      >
        {body}
      </PaletteFrame>
    )
  }
  return (
    <InlineFrame open={visible} anchorRef={anchorRef} fitAnchor={!!mentionList} placement={placement}>
      {body}
    </InlineFrame>
  )
}

// ── Frames ───────────────────────────────────────────────────────────────────

/** Above the composer, as wide as the chat's reading column; never takes the box's focus. */
function InlineFrame({
  open,
  anchorRef,
  fitAnchor = false,
  placement,
  children,
}: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  /** No wider than the composer (a host's own list, in a narrow view: a phone, a card). */
  fitAnchor?: boolean
  /** Away from a chat: the side and width it opens with (CommandMenuProps.placement). */
  placement?: { side: 'top' | 'bottom'; width: number }
  children: ReactNode
}) {
  const floatingContainerRef = useFloatingChatContainerRef()
  const [room, setRoom] = useState(420)
  const side = placement?.side ?? 'top'
  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return
    const rect = anchorRef.current.getBoundingClientRect()
    setRoom(Math.max(side === 'top' ? rect.top - 24 : window.innerHeight - rect.bottom - 24, 200))
  }, [open, anchorRef, side])
  // A press on the menu (a row, a tab, its scrollbar) leaves the caret where it is.
  const keepFocus = (e: { preventDefault: () => void }) => e.preventDefault()
  return (
    <Popover open={open}>
      <PopoverAnchor virtualRef={anchorRef as React.RefObject<HTMLElement>} />
      <PopoverContent
        side={side}
        align={placement ? 'start' : 'center'}
        sideOffset={6}
        data-command-menu="inline"
        className="flex flex-col overflow-hidden rounded-3xl border border-border bg-popover p-0 text-popover-foreground shadow-lg"
        style={{
          // The chat's reading column, inset from the card walls (as the
          // other pickers above the composer: picker-popover.tsx).
          width: placement
            ? placement.width
            : Math.min(
                measureChatReadingColumn(
                  floatingContainerRef.current?.getBoundingClientRect().width ??
                    anchorRef.current?.getBoundingClientRect().width ??
                    360,
                ) - 36,
                fitAnchor ? (anchorRef.current?.getBoundingClientRect().width || 360) - 16 : Infinity,
              ),
          maxHeight: Math.min(room, 440),
        }}
        // The box keeps the focus, and decides when the menu goes: a press
        // outside blurs the box (the menu steps aside), Esc reaches it as a key.
        onOpenAutoFocus={keepFocus}
        onCloseAutoFocus={keepFocus}
        onInteractOutside={keepFocus}
        onEscapeKeyDown={keepFocus}
        onMouseDown={keepFocus}
      >
        <Entrance from={{ opacity: 0, transform: 'translateY(4px)' }} duration={140} className="flex min-h-0 flex-1 flex-col">
          {children}
        </Entrance>
      </PopoverContent>
    </Popover>
  )
}

/** Centred over the app, its own field focused at once. */
function PaletteFrame({
  search,
  onSearch,
  onKey,
  onDismiss,
  listId,
  activeId,
  arriving,
  children,
}: {
  search: string
  onSearch: (value: string) => void
  onKey: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onDismiss: () => void
  listId: string
  activeId?: string
  arriving: boolean
  children: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // Focused while it mounts (the opener flushes the mount in its key event).
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])
  // Opened from the search button: the button's copy flies here and the box
  // grows out of it, shown when it lands (before this first paint).
  useLayoutEffect(() => {
    if (!arriving) return
    return landFlight(SEARCH_FLIGHT_KEY, dialogRef.current)
    // Once, as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-4 pt-[14vh]" data-command-menu="palette">
      <Entrance
        aria-hidden
        from={{ opacity: 0 }}
        duration={120}
        className="absolute inset-0 bg-black/20 backdrop-blur-[2px] dark:bg-black/40"
        onMouseDown={(e) => {
          e.preventDefault()
          onDismiss()
        }}
      />
      <Entrance
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        from={{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }}
        duration={160}
        // Flying in, the flight is its entrance.
        still={arriving}
        className="relative flex max-h-[min(72vh,560px)] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onMouseDown={(e) => {
          // A press on a row or a tab keeps the field focused.
          if (e.target !== inputRef.current) e.preventDefault()
        }}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
          <input
            ref={inputRef}
            data-command-menu-input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search everything…"
            className="h-[52px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          <Kbd>esc</Kbd>
        </div>
        {children}
      </Entrance>
    </div>,
    document.body,
  )
}

/**
 * A div that eases in from `from` as it mounts, through the browser's own Web
 * Animations API: no animation library on the shell's first load
 * (shell-heavy-deps.test.ts), and none at all under reduced motion.
 */
function Entrance({
  from,
  duration,
  still = false,
  ref: outerRef,
  ...props
}: HTMLAttributes<HTMLDivElement> & { from: Keyframe; duration: number; still?: boolean; ref?: React.Ref<HTMLDivElement> }) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(outerRef, () => ref.current as HTMLDivElement, [])
  useLayoutEffect(() => {
    const el = ref.current
    if (still || !el || typeof el.animate !== 'function') return
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.animate([from, { opacity: 1, transform: 'none' }], { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' })
    // Once, as it mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={ref} {...props} />
}

// ── The body: tabs, rows, footer ────────────────────────────────────────────

function MenuBody({
  tabs,
  tab,
  onTab,
  sections,
  items,
  highlighted,
  onHighlight,
  onPick,
  verbs,
  loading,
  query,
  palette,
  listId,
  rowId,
  mentionWord,
}: {
  tabs: readonly MenuTab[]
  tab: MenuTab
  onTab: (tab: MenuTab) => void
  sections: MenuSection[]
  items: MenuItem[]
  highlighted: number
  onHighlight: (index: number) => void
  onPick: (item: MenuItem) => void
  verbs: (item: MenuItem) => MenuVerb
  loading: boolean
  query: string
  palette: boolean
  listId: string
  rowId: (index: number) => string
  /** What Enter says for a mention here (verbLabel). */
  mentionWord?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // Tabs named in the workspace's words, as the sections are (menuTabLabel).
  const edition = useWorkspaceEdition()
  // The keys move the highlight; the list follows it.
  useEffect(() => {
    const row = listRef.current?.querySelector(`[data-menu-index="${highlighted}"]`)
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [highlighted, items])

  const empty = items.length === 0
  const q = query.trim()
  const active = items[highlighted] ? verbs(items[highlighted]) : null
  return (
    <>
      {tabs.length > 2 && (
        <div
          role="tablist"
          aria-label="Show"
          className="flex shrink-0 items-center gap-1 overflow-x-auto px-2.5 pb-1 pt-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              data-menu-tab={t}
              onClick={() => onTab(t)}
              className={cn(
                'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                t === tab ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {menuTabLabel(t, edition)}
            </button>
          ))}
        </div>
      )}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Results"
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2"
      >
        {empty ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            {loading
              ? 'Searching…'
              : q
                ? `Nothing matches “${q}”`
                : tab === 'all'
                  ? 'Type to search everything'
                  : `No ${menuTabLabel(tab, edition).toLowerCase()} yet`}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.label}>
              <div className="flex items-center justify-between px-2.5 pb-1 pt-2.5 text-[11px] font-medium text-muted-foreground">
                <span>{section.label}</span>
                {tab === 'all' && section.total > section.items.length && (
                  <button
                    type="button"
                    data-menu-see-all={section.key}
                    onClick={() => onTab(section.key)}
                    className="rounded px-1 transition-colors hover:text-foreground"
                  >
                    See all{section.totalKnown ? ` ${section.total}` : ''}
                  </button>
                )}
              </div>
              {section.items.map((item, i) => {
                const index = section.offset + i
                return (
                  <MenuRow
                    key={rowKey(item)}
                    id={rowId(index)}
                    item={item}
                    index={index}
                    active={index === highlighted}
                    verb={index === highlighted && active ? active : null}
                    onHighlight={onHighlight}
                    onPick={onPick}
                    mentionWord={mentionWord}
                  />
                )
              })}
            </div>
          ))
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border px-3.5 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span className="ml-0.5">move</span>
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd>
          <span className="ml-0.5">{active ? verbLabel(active, items[highlighted], mentionWord) : 'select'}</span>
        </span>
        {tabs.length > 2 && (
          <span className="flex items-center gap-1">
            <Kbd>tab</Kbd>
            <span className="ml-0.5">switch</span>
          </span>
        )}
        {!palette && (
          <span className="ml-auto flex items-center gap-1">
            <Kbd>esc</Kbd>
            <span className="ml-0.5">close</span>
          </span>
        )}
      </div>
    </>
  )
}

const noFrontCard = () => null

/** The record whose card is in front, and its actions the palette can run on their own; null for none. */
export function recordActionsFor(front: ReturnType<typeof frontCard>): RecordActionsSource | null {
  const spec = front?.spec
  if (!spec || spec.kind !== 'record') return null
  const entity = { type: spec.record.type, id: spec.record.id, label: spec.title }
  // A card doesn't say what the record's status is, so an archive whose undo
  // puts back the status it had (an initiative's planned/active/completed)
  // isn't offered here: its undo could only guess.
  const archive = entityActionsDescriptor(entity.type)?.archive
  const undoNeedsStatus = archive?.kind === 'status' && archive.restorePrevious
  const actions = supportedEntityActions(entity.type)
    .filter(isDirectEntityAction)
    .filter((id) => id !== 'open')
    .filter((id) => !(undoNeedsStatus && (id === 'archive' || id === 'restore')))
    .map((id) => ({ id, label: ENTITY_ACTION_LABELS[id] }))
  if (!actions.length) return null
  return { entity, label: spec.title, actions }
}

function rowKey(item: MenuItem): string {
  switch (item.kind) {
    case 'page':
      return `page:${item.page.slug}`
    case 'skill':
      return `skill:${item.skill.id}`
    case 'record':
      return `${item.row.kind}:${recordId(item.row)}`
    case 'option':
      return `option:${item.option.id}`
    case 'entity_action':
      return `entity_action:${item.action}`
    case 'feed':
      return `feed:${item.entry.type}:${item.entry.id}`
  }
}

function recordId(row: MenuSearchRow): string {
  if (row.kind === 'capture') return row.capture.id
  if (row.kind === 'contact') return row.contact.id
  if (row.kind === 'company') return row.company.id
  return row.id
}

/** The row's data-* hooks (UI automation and tests find a row by what it is). */
function rowData(item: MenuItem): Record<string, string> {
  switch (item.kind) {
    case 'page':
      return { 'data-page-item': item.page.slug }
    case 'skill':
      return { 'data-skill-item': item.skill.slug }
    case 'record': {
      const row = item.row
      const id = recordId(row)
      const byKind: Partial<Record<MenuSearchRow['kind'], string>> = {
        contact: 'data-contact-item',
        company: 'data-company-item',
        capture: 'data-capture-item',
      }
      const named = byKind[row.kind]
      return { 'data-record-item': `${row.kind}:${id}`, ...(named ? { [named]: id } : {}) }
    }
    case 'option':
      return { 'data-mention-option': item.option.id }
    case 'entity_action':
      return { 'data-entity-action': item.action }
    case 'feed':
      return { 'data-feed-item': `${item.entry.type}:${item.entry.id}` }
  }
}

function MenuRow({
  id,
  item,
  index,
  active,
  verb,
  onHighlight,
  onPick,
  mentionWord,
}: {
  id: string
  item: MenuItem
  index: number
  active: boolean
  /** What Enter does to it: said on the highlighted row only. */
  verb: MenuVerb | null
  onHighlight: (index: number) => void
  onPick: (item: MenuItem) => void
  mentionWord?: string
}) {
  const { title, detail, meta } = rowText(item)
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      data-menu-index={index}
      data-command-item
      {...rowData(item)}
      // Moving the pointer takes the highlight; the list changing under a
      // resting one (new rows arriving) does not: the browser's mousemove for
      // that carries no movement.
      onMouseMove={(e) => {
        if (!active && (e.movementX || e.movementY)) onHighlight(index)
      }}
      onClick={() => onPick(item)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left text-sm outline-none',
        active ? 'bg-accent text-accent-foreground' : 'text-foreground',
      )}
    >
      <RowIcon item={item} />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 truncate font-medium [max-width:70%]" data-row-title>
          {title}
        </span>
        {detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>}
      {verb && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" data-menu-row-verb={verb}>
          <Kbd>↵</Kbd>
          {verbLabel(verb, item, mentionWord)}
        </span>
      )}
    </button>
  )
}

function rowText(item: MenuItem): { title: string; detail: string | null; meta: ReactNode } {
  if (item.kind === 'page') {
    return { title: item.page.label, detail: item.page.description, meta: <span className="font-mono">/{item.page.shownSlug ?? item.page.slug}</span> }
  }
  if (item.kind === 'skill') {
    return { title: item.skill.name, detail: item.skill.description, meta: <span className="font-mono">/{item.skill.slug}</span> }
  }
  if (item.kind === 'option') return { title: item.option.label, detail: item.option.hint || null, meta: null }
  if (item.kind === 'entity_action') return { title: item.label, detail: null, meta: null }
  if (item.kind === 'feed') return feedRowText(item.entry)
  const row = item.row
  switch (row.kind) {
    case 'action':
      return { title: row.title, detail: row.status, meta: row.identifier ? <span className="font-mono">{row.identifier}</span> : null }
    case 'document':
      return { title: row.title, detail: null, meta: row.updatedAt ? formatCaptureDate(row.updatedAt) : null }
    case 'project':
    case 'initiative':
      return { title: row.title, detail: row.status ? statusLabel(row.status) : null, meta: null }
    case 'deal':
    case 'flow':
      return { title: row.title, detail: row.status, meta: null }
    case 'attachment':
      return { title: row.title, detail: row.parent ? FILE_ON[row.parent.type] : null, meta: row.createdAt ? formatCaptureDate(row.createdAt) : null }
    case 'calendar_event':
      return { title: row.title, detail: eventWhen(row.start, row.allDay), meta: null }
    case 'agent':
      return { title: row.title, detail: row.description, meta: null }
    case 'team_chat_message':
      // The words that matched, then who said it where, and when.
      // A DM's other person wrote it: "Ben Ortiz · DM", never the name twice.
      return { title: row.title, detail: row.author === row.place ? `${row.author} · DM` : `${row.author} · ${row.place}`, meta: formatCaptureDate(row.createdAt) }
    case 'contact':
      return {
        title: row.contact.full_name || row.contact.email || 'Unnamed contact',
        detail: contactSubline(row.contact),
        meta: row.contact.is_member ? <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium">Teammate</span> : null,
      }
    case 'company':
      return { title: row.company.name, detail: companySubline(row.company), meta: null }
    case 'capture': {
      const c = row.capture
      return { title: c.title, detail: c.summary ?? null, meta: formatCaptureDate(c.started_at || c.recorded_at || c.created_at) }
    }
  }
}

/** A feed row: the record, what happened (and where), and how long ago. */
function feedRowText(entry: FeedEntry): { title: string; detail: string | null; meta: ReactNode } {
  // "Ana shared this with you": who did it is the line itself.
  const shared = sharedWithYouLine(entry.last)
  if (shared) return { title: entry.label, detail: shared, meta: formatDistanceToNowStrict(new Date(entry.last.at)) }
  const what = describeFeedEvent(entry.last)
  // Who did it, unless it was the person themselves (Recent is theirs by definition).
  const by = entry.last.actor.me && entry.last.actor.kind === 'member' ? null : feedActorLabel(entry.last.actor)
  return {
    title: entry.label,
    detail: [what, by, entry.context].filter(Boolean).join(' · '),
    meta: formatDistanceToNowStrict(new Date(entry.last.at)),
  }
}

/** Where a file hangs, as its row says it. */
const FILE_ON: Record<NonNullable<MenuFileRow['parent']>['type'], string> = {
  capture: 'On a capture',
  action: 'On a task',
  project: 'On a project',
}

/** An event's start, short: "Thu, Nov 12 · 10:00" ("Thu, Nov 12" all day). */
function eventWhen(start: string, allDay: boolean): string | null {
  const at = new Date(start)
  if (Number.isNaN(at.getTime())) return null
  return format(at, allDay ? 'EEE, MMM d' : 'EEE, MMM d · HH:mm')
}

/** `in_progress` → "In progress". */
function statusLabel(status: string): string {
  const s = status.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const TILE = 'flex size-7 shrink-0 items-center justify-center rounded-lg'
/** A neutral tile; on the highlighted row it lifts off the highlight. */
const MUTED_TILE = 'bg-muted group-aria-selected:bg-background'

/** The record kinds drawn as a plain glyph on a tile. */
const RECORD_ICONS: Partial<Record<MenuSearchRow['kind'], LucideIcon>> = {
  action: CircleCheck,
  document: FileText,
  project: FolderKanban,
  initiative: Target,
  capture: AudioLines,
  deal: Handshake,
  flow: Workflow,
  attachment: Paperclip,
  calendar_event: CalendarDays,
  agent: Boxes,
  team_chat_message: Hash,
}

/** A feed row's kind, as a glyph on a tile. */
const FEED_ICONS: Partial<Record<FeedEntry['type'], LucideIcon>> = {
  ...RECORD_ICONS,
  contact: User,
  company: Building2,
  team_chat_message: Hash,
}

function RowIcon({ item }: { item: MenuItem }) {
  if (item.kind === 'page') {
    const Icon = PAGE_ICONS[item.page.slug] ?? LayoutList
    return (
      <span className={cn(TILE, MUTED_TILE, 'text-muted-foreground')}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
    )
  }
  if (item.kind === 'skill') {
    return item.skill.icon ? (
      <span className={cn(TILE, MUTED_TILE, 'text-base leading-none')}>{item.skill.icon}</span>
    ) : (
      <LibraryItemIcon color={item.skill.color} seed={item.skill.id} size="sm" />
    )
  }
  if (item.kind === 'entity_action') {
    const Icon = ENTITY_ACTION_ICONS[item.action]
    return (
      <span className={cn(TILE, MUTED_TILE, 'text-muted-foreground')}>
        <Icon className="size-4" />
      </span>
    )
  }
  if (item.kind === 'option') {
    return item.option.agent ? (
      <span className={cn(TILE, 'rounded-full bg-primary/10 text-primary')}>
        <Bot className="size-4" strokeWidth={1.75} />
      </span>
    ) : (
      <span className={cn(TILE, 'rounded-full bg-primary/10 text-[11px] font-semibold text-primary')}>{initials(item.option.label)}</span>
    )
  }
  if (item.kind === 'feed') {
    const Icon = FEED_ICONS[item.entry.type] ?? Building2
    return (
      <span className={cn(TILE, MUTED_TILE, 'text-muted-foreground')}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
    )
  }
  const row = item.row
  if (row.kind === 'contact') {
    return (
      <span className={cn(TILE, 'rounded-full bg-primary/10 text-[11px] font-semibold text-primary')}>
        {initials(row.contact.full_name || row.contact.email || '?')}
      </span>
    )
  }
  if (row.kind === 'company' && row.company.logo_url) {
    return <img src={row.company.logo_url} alt="" className={cn(TILE, MUTED_TILE, 'object-contain p-0.5')} />
  }
  const Icon = RECORD_ICONS[row.kind] ?? Building2
  return (
    <span className={cn(TILE, MUTED_TILE, 'text-muted-foreground')}>
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  )
}

function initials(name: string): string {
  const words = name.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase()
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted/60 px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}
