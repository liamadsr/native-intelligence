'use client'

/**
 * The Team chat page's panel: its sub-nav (Liam, 11-11: "make the team-chat
 * one look like this"). PAGE_PANELS['team-chat'] (page-panel.tsx): it holds
 * the slot while Team chat is the selected page.
 *
 *   What    an All | Recent switch at the top (remembered on this device).
 *           All: Favorites (what the person starred), Team channels,
 *           Channels (the whole workspace's), DMs, Meetings (where calling
 *           is on), each only when it has a row (./team-chat-panel-model.ts).
 *           Meetings are the page's own section (components/meeting-links/
 *           meetings-section.tsx, `dense`): the person's meetings from the
 *           moment they are made, live first, each with Join and its menu
 *           (Copy link; New link and Revoke for the host).
 *           Recent: every conversation in one list, latest activity first.
 *   Heading Team channels, Channels and DMs each have their order (recent
 *           activity or A–Z, remembered per section on this device) and a +
 *           opening the page's own dialog: New channel (Team channels': with
 *           a team picked), New message. Favorites and Meetings have
 *           neither.
 *   A row   the page's own list's rules (views/team-chat-view.tsx
 *           ChannelRow): bold while unread, its mentions or unread count, a
 *           muted one's bell; a DM's other person's avatar. A press opens
 *           that conversation in the card in front, as its own list does. A
 *           star on hover or focus, and the row's right-click menu, add it to
 *           Favorites or take it out (./team-chat-panel-prefs.ts: on this
 *           device for now).
 *   Look    the Tasks and Mail sub-navs' (tasks-panel.tsx): the same floating
 *           card (page-panel-frame.tsx), small muted headings, 32px rows, a
 *           plain muted glyph; no title row, no empty state.
 *   Lit     the conversation on screen in the card, from what the card says,
 *           never from a click (the rail's tint, `aria-current`).
 *   One     the card's one list: full screen from `md` up the card draws
 *           none of its own (views/team-chat-view.tsx), the conversation
 *           taking its width (Liam, 11-11: "did you actually clean up the
 *           old one and remove it from the panel complely"), so this shows
 *           while it is open, room or not (page-panel.tsx).
 *   Kept    it wears KEEP_PLACE_ATTR (rail/selected-place.ts): what a press
 *           in it opens keeps the page selected.
 *
 *   At once its switch and headings (Channels and DMs with their +; Meetings
 *           where calling was on) come with the page, before the card has
 *           loaded (Liam, 11-11: "it goes away completely and reappears every
 *           time" … "only on first load"), with the conversations this
 *           workspace's card last said (kept by the bridge,
 *           team-chat-card-controls.ts lastTeamChat), so a visit again lists
 *           them at once; the card's own list and the lit row replace them
 *           when it says. A row or a + pressed before there is a card waits
 *           for it (pending-move.ts).
 *
 * Flat cost: no fetch, no realtime, no timer of its own. The conversations
 * are the card's own list, kept current by the card's realtime.
 */
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUpDown, BellOff, Hash, Lock, Plus, Star, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import type { FrontCard } from '@/components/chat-cards/front-card'
import {
  useLastTeamChat,
  useTeamChatCard,
  type TeamChatCardControls,
  type TeamChatPanelConversation,
} from '@/components/chat-cards/team-chat-card-controls'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { MeetingsSection } from '@/components/meeting-links/meetings-section'
import { usePendingMove } from './pending-move'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { PagePanelFrame } from './page-panel-frame'
import { PAGE_PANEL_LABELS, type PagePanelProps } from './page-panel-types'
import {
  SORT_WORDS,
  teamChatPanelSections,
  teamChatRecentRows,
  teamChatRowBadge,
  type TeamChatPanelMode,
  type TeamChatPanelRow,
  type TeamChatPanelSection,
} from './team-chat-panel-model'
import {
  setTeamChatPanelMode,
  setTeamChatSort,
  toggleTeamChatFavorite,
  useTeamChatFavorites,
  useTeamChatPanelMode,
  useTeamChatSorts,
} from './team-chat-panel-prefs'

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), as tasks-panel.tsx's ROW_LIT. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'
const LABEL = PAGE_PANEL_LABELS['team-chat']

export function TeamChatPanel({ active, mode, front, onContent }: PagePanelProps) {
  const card = useTeamChatCard(front?.id ?? null)
  // Its switch and headings are always there: something to show from its first commit, card or not.
  useLayoutEffect(() => {
    onContent('team-chat', true)
  }, [onContent])

  const run = usePendingMove<TeamChatCardControls>(card, active)
  return (
    <PagePanelFrame mode={mode} active={active} label={LABEL} page="team-chat">
      <TeamChatPanelRows card={card} run={run} front={front} />
    </PagePanelFrame>
  )
}

const NO_CONVERSATIONS: readonly TeamChatPanelConversation[] = []
const NO_LIVE: ReadonlySet<string> = new Set()

function TeamChatPanelRows({
  card,
  run,
  front,
}: {
  card: TeamChatCardControls | null
  /** A move on the card: now, or once there is one (pending-move.ts). */
  run: (move: (card: TeamChatCardControls) => void) => void
  front: FrontCard | null
}) {
  const view = useTeamChatPanelMode()
  const sorts = useTeamChatSorts()
  const shellWorkspace = useWorkspaceId()
  const workspaceId = card ? card.workspaceId : shellWorkspace
  // What this workspace's card last said: the list until the card says its own, and whether Meetings was on.
  const kept = useLastTeamChat(workspaceId)
  const favorites = useTeamChatFavorites(workspaceId)
  const conversations = card ? card.conversations : (kept?.conversations ?? NO_CONVERSATIONS)
  const meetingsOn = card && !card.pending ? !!card.newMeeting : !!card?.newMeeting || !!kept?.meetings
  const openId = card?.openId ?? null
  const sections = useMemo(() => teamChatPanelSections(conversations, favorites, sorts, { meetings: meetingsOn }), [conversations, favorites, sorts, meetingsOn])
  const recent = useMemo(() => teamChatRecentRows(conversations), [conversations])
  const starred = useMemo(() => new Set(favorites), [favorites])
  // An ended meeting with unread messages stays in its section.
  const unreadOf = (id: string) => {
    const c = conversations.find((x) => x.channel.id === id)?.channel
    return c ? c.unread + (c.thread_unread ?? 0) : 0
  }

  // A record opened over the page as its own card is in front: the page's card comes back first.
  const frontRef = useRef(front)
  frontRef.current = front
  const inFront = (c: TeamChatCardControls) => c.cardId === frontRef.current?.id
  const bringBack = (c: TeamChatCardControls) => {
    if (!inFront(c)) c.show()
  }
  const press = (id: string) =>
    run((c) => {
      if (id === c.openId && inFront(c)) return
      bringBack(c)
      c.open(id)
    })
  const toggleStar = (id: string) => toggleTeamChatFavorite(workspaceId, id)
  const add = (section: TeamChatPanelSection) =>
    run((c) => {
      bringBack(c)
      if (section.key === 'dms') return c.newDm()
      if (section.key === 'meetings') return c.newMeeting?.()
      if (section.key !== 'team') return c.newChannel(null)
      // Team channels': the open conversation's team when it is a team channel, else the first listed one's.
      const open = c.conversations.find((x) => x.channel.id === c.openId)
      c.newChannel(open?.channel.team_id ?? section.rows[0]?.conversation.channel.team_id ?? null)
    })

  const row = (r: TeamChatPanelRow) => (
    <li key={r.conversation.channel.id}>
      <ConversationRow
        row={r}
        lit={r.conversation.channel.id === openId}
        starred={starred.has(r.conversation.channel.id)}
        onPress={press}
        onStar={toggleStar}
      />
    </li>
  )

  return (
    <nav
      aria-label={LABEL}
      data-team-chat-panel=""
      {...{ [KEEP_PLACE_ATTR]: '' }}
      className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
    >
      <div className="px-0.5 pb-2.5">
        <ModeSwitch value={view} onChange={setTeamChatPanelMode} />
      </div>
      {/* Sections as blocks, as the Tasks sub-nav's: 12px between one's last row and the next heading. */}
      <div className="ph-no-capture flex flex-col gap-3">
        {view === 'recent' ? (
          recent.length > 0 && (
            <section data-team-chat-section="recent" aria-label="Recent conversations">
              <ul className="flex flex-col">{recent.map(row)}</ul>
            </section>
          )
        ) : (
          sections.map((section) => (
            <section key={section.key} data-team-chat-section={section.key} aria-labelledby={`team-chat-${section.key}`}>
              <SectionHeading section={section} sort={section.sort ? sorts[section.sort] : null} onAdd={add} meetingsOn={meetingsOn} />
              {section.key === 'meetings' && meetingsOn ? (
                <MeetingsSection
                  dense
                  refreshKey={card?.meetingsKey ?? null}
                  liveChannels={card?.liveMeetings ?? NO_LIVE}
                  unread={unreadOf}
                  activeChannelId={openId}
                  onOpen={press}
                />
              ) : (
                <ul className="flex flex-col">{section.rows.map(row)}</ul>
              )}
            </section>
          ))
        )}
      </div>
    </nav>
  )
}

const MODES: ReadonlyArray<{ id: TeamChatPanelMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'recent', label: 'Recent' },
]

/**
 * All | Recent: a radio group (one tab stop, the arrow keys move), the chosen one raised, as the app's other switches.
 * Its corners follow the panel's (Liam, 11-11: "make sure that the roundness of this matches the roundness of that main
 * container"): concentric with the panel card's 24px, from 9px inside its outer edge, 15px; its options, 2px inside, 13px.
 */
function ModeSwitch({ value, onChange }: { value: TeamChatPanelMode; onChange: (mode: TeamChatPanelMode) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const at = (MODES.findIndex((m) => m.id === value) + step + MODES.length) % MODES.length
    onChange(MODES[at].id)
    refs.current[at]?.focus()
  }
  return (
    <div role="radiogroup" aria-label="Show" onKeyDown={onKeyDown} data-team-chat-mode={value} className="flex items-center gap-0.5 rounded-[15px] bg-muted p-0.5">
      {MODES.map((m, i) => {
        const checked = value === m.id
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-team-chat-mode-option={m.id}
            onClick={() => !checked && onChange(m.id)}
            className={cn(
              'h-7 flex-1 rounded-[13px] text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
              checked ? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

const HEAD_BUTTON =
  'flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

function SectionHeading({
  section,
  sort,
  onAdd,
  meetingsOn,
}: {
  section: TeamChatPanelSection
  sort: 'recent' | 'az' | null
  onAdd: (section: TeamChatPanelSection) => void
  /** Calling is on: Meetings' "+" opens the card's New meeting link dialog. */
  meetingsOn: boolean
}) {
  const addLabel =
    section.key === 'dms'
      ? 'New message'
      : section.key === 'meetings'
        ? meetingsOn
          ? 'New meeting link'
          : null
        : section.key === 'team' || section.key === 'channels'
          ? 'New channel'
          : null
  // Nothing to sort with fewer than two rows (an empty Channels or DMs shows only its "+").
  const sortKey = section.rows.length > 1 ? section.sort : null
  return (
    <div className="flex items-center gap-0.5 pb-1 pl-2 pr-0.5 pt-0.5">
      <h3 id={`team-chat-${section.key}`} className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
        {section.heading}
      </h3>
      {sortKey && sort && (
        <button
          type="button"
          data-team-chat-sort={sortKey}
          data-sort={sort}
          aria-label={`${section.heading}: sorted by ${SORT_WORDS[sort]}. Sort by ${SORT_WORDS[sort === 'az' ? 'recent' : 'az']}`}
          title={`Sorted by ${SORT_WORDS[sort]}`}
          onClick={() => setTeamChatSort(sortKey, sort === 'az' ? 'recent' : 'az')}
          className={HEAD_BUTTON}
        >
          <ArrowUpDown className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
      {addLabel && (
        <button type="button" data-team-chat-add={section.key} aria-label={addLabel} title={addLabel} onClick={() => onAdd(section)} className={HEAD_BUTTON}>
          <Plus className="size-3.5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  )
}

/** A name's initials ("Rosa Lind": RL), as the page's avatars. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  return (words[0].charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : '')).toUpperCase()
}

function Glyph({ conversation }: { conversation: TeamChatPanelConversation }): ReactNode {
  const { channel, person, privateTeam, title } = conversation
  if (channel.kind === 'dm') {
    const name = person?.name ?? title
    return (
      <Avatar data-team-chat-avatar="" className="h-4 w-4">
        {person?.url && <AvatarImage src={person.url} alt="" className="object-cover" />}
        <AvatarFallback className="bg-muted text-[7px] font-semibold text-muted-foreground">{initials(name)}</AvatarFallback>
      </Avatar>
    )
  }
  const Icon = channel.kind === 'meeting' ? Video : privateTeam ? Lock : Hash
  return <Icon className="size-4" strokeWidth={1.75} />
}

function ConversationRow({
  row,
  lit,
  starred,
  onPress,
  onStar,
}: {
  row: TeamChatPanelRow
  lit: boolean
  starred: boolean
  onPress: (id: string) => void
  onStar: (id: string) => void
}) {
  const { conversation, hint } = row
  const id = conversation.channel.id
  const badge = teamChatRowBadge(conversation, lit)
  const starLabel = starred ? 'Remove from favorites' : 'Add to favorites'
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div className="group/row relative" data-team-chat-item={id}>
          <button
            type="button"
            data-team-chat-panel-row={id}
            data-unread={badge.unread || undefined}
            aria-current={lit ? 'true' : undefined}
            onClick={() => onPress(id)}
            title={hint ? `${conversation.title} · ${hint}` : conversation.title}
            className={cn(
              'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
              'group-hover/row:pr-8 group-focus-within/row:pr-8',
              lit ? ROW_LIT : 'hover:bg-muted/60',
            )}
          >
            <span aria-hidden data-team-chat-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
              <Glyph conversation={conversation} />
            </span>
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
              <span
                data-team-chat-title=""
                className={cn('min-w-0 truncate text-[13px]', badge.muted && !badge.unread ? 'text-muted-foreground' : 'text-foreground', badge.unread && 'font-semibold')}
              >
                {conversation.title}
              </span>
              {hint && (
                <span data-team-chat-hint="" className="shrink-0 truncate text-[11px] text-muted-foreground">
                  {hint}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center group-hover/row:hidden group-focus-within/row:hidden">
              {badge.mentions ? (
                <span
                  data-team-chat-mentions=""
                  className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                  title={`${badge.mentions} mention${badge.mentions === 1 ? '' : 's'}`}
                >
                  @{badge.mentions}
                </span>
              ) : badge.count ? (
                <span data-team-chat-count="" className="text-[11px] tabular-nums text-muted-foreground">
                  <span aria-hidden>{badge.count}</span>
                  <span className="sr-only">, {badge.count} unread</span>
                </span>
              ) : badge.muted ? (
                <BellOff data-team-chat-muted="" className="size-3.5 text-muted-foreground/70" aria-label="Muted" />
              ) : null}
            </span>
          </button>
          <button
            type="button"
            data-team-chat-star={id}
            // The conversation's name in it: every row has a star, so "Add to favorites" alone can't say which.
            aria-label={starred ? `Remove ${conversation.title} from favorites` : `Add ${conversation.title} to favorites`}
            title={starLabel}
            onClick={() => onStar(id)}
            className={cn(
              'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100 motion-reduce:transition-none',
            )}
          >
            <Star className={cn('size-3.5', starred && 'fill-current')} strokeWidth={1.75} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent data-team-chat-menu={id} className="min-w-44">
        <ContextMenuItem data-team-chat-menu-item="favorite" onSelect={() => onStar(id)}>
          {starLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
