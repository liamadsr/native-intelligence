'use client'

/**
 * An agent's page (docs/plans/bots-v4.md, "A bot's page"): one teammate's chat
 * and its work. It opens as a card in the chat (the `bot` page kind,
 * src/components/chat-cards/pages/bot-card.tsx), full screen, from a click on
 * the Library (Agents & skills), a work item or a notice (openBotPage,
 * src/lib/bots/bot-page.ts).
 *
 *   header   the agent mark (AgentIcon; its state in a tooltip: working while one of
 *            its runs runs; asleep while it's switched off, its attempts are
 *            paused, or the AI limit stopped it: teammateBotState), its name,
 *            which of those it is when it sleeps (bots-v4 Phase 4b), its
 *            workspace, the item open on it (Phase 2), and the switcher when
 *            the same agent is in several workspaces (switcherChips,
 *            switcherOrder), which opens the one picked.
 *   Chat     on the left, the page's main column: its chat (#611's).
 *   Work     on the right, a narrower column of floating cards (Liam, Oct 7:
 *            "like how Claude Code does this"): For you, Working on, Done
 *            lately, Notices and About (bot-page/bot-work.tsx), read through
 *            useBotWork while the page is drawn, and kept BOT_PAGE_LINGER_MS
 *            after it leaves the screen, so a quick look away and back reloads
 *            nothing.
 *
 * An item open on the page (`itemId`, kept with its card: bots-v4.md "An item
 * opens on its bot's page", Phase 2; bot-page/item-view.tsx) takes the Work
 * side's place with the item, and the Chat side's with the conversation about
 * it. Its way back returns the page to the lists. Its rows open their items on
 * this page (useBotPageOpen, through onOpenItem); an item of another bot opens
 * on that bot's page.
 *
 * A card narrower than both columns need (usePageColumns) shows Chat and Work
 * as two tabs, in that order. The bot's own page shows what opened it asked
 * (onBotPageFocus: Work for "open its page"), else Chat. An item always opens
 * on the item (Work). Switching layout never remounts either column.
 *
 * The name is the roster's (the shared source), the card's name
 * until it has loaded. A teammate the loaded roster doesn't hold (deleted, or
 * behind a private team) isn't opened: the page says it's not available.
 *
 * "Refine in chat" on one of its cards in For you (bots-v4.md Phase 3) talks to
 * this bot in the page's chat, never the main chat.
 *
 * One face (always-on-agent §2c): an area face's page is the agent's, so a
 * page asked for one (an old card, a deep link) shows its workspace's
 * Assistant's (agentTeammateIdFor). The agent's page runs no Chat on the home
 * thread (the chat strip's home tab is its one Chat in a window): what's said
 * on it, and Refine, are handed there (TeammateChat `home`, openHomeThread).
 * Its work column adds What I've learned, area by area. Customize isn't
 * offered on it (bot-page/about.tsx). Until the roster knows the teammate the
 * page is pending: nothing opens a chat for an id it can't place yet.
 *
 * The chat (bots-v2.md, bots v3 Phase 4, #611) is the teammate's own thread
 * (TeammateChat over useTeammateChat), with the main chat's composer. In the desktop app it has
 * the mic and the bot's own voice.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useAgentWorkShared } from '@/components/work/agent-work-provider'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { ViewHeader } from '@/app/account/(dashboard)/views/view-header'
import { useBotWork } from '@/hooks/use-bot-work'
import { useBotVoice } from '@/lib/bots/bot-voice'
import { BOT_PAGE_LINGER_MS, onBotPageFocus, stoppedByAiLimit, type BotPagePart } from '@/lib/bots/bot-page'
import { bubbleTeammates, sameAgentIds, switcherChips, switcherOrder } from '@/lib/bots/teammate-switcher'
import { asBotCharacter } from '@/lib/bots/teammate-faces'
import { TEAMMATE_REST_WORDS, teammateBotState, teammateRest } from '@/lib/bots/teammate-state'
import { useTeammateChatUser, type TeammateChatItem } from '@/lib/bots/teammate-chat-tab'
import { refineTarget, refineText, sendRefine } from '@/lib/bots/refine-in-chat'
import type { BubbleItem } from '@/lib/bots/bubble-items'
import type { AttentionItem } from '@/hooks/use-attention-items'
import { teammateKey } from '@/lib/work/agent-work-lanes'
import { kindLabel } from '@/lib/work/presentation'
import type { WorkItem } from '@/lib/work/types'
import { isDesktopApp } from '@/lib/platform'
import { AgentIcon } from '@/components/agents/agent-icon'
import { BotWork } from './bot-page/bot-work'
import { ItemChat, ItemPane } from './bot-page/item-view'
import { useLinger } from './bot-page/use-linger'
import { BOT_PAGE_COLUMNS_MIN_PX, BOT_PAGE_ITEM_COLUMNS_MIN_PX, usePageColumns } from './bot-page/use-page-columns'
import { BotPageNavContext, type BotPageNav } from './bot-page/bot-page-nav'
import { TeammateChat, type TeammateChatAbout, type TeammateChatVoice } from './teammate-chat'
import { areaOfTeammate } from '@/lib/bots/area-faces'
import { agentTeammateIdFor, isAgentTeammate } from '@/lib/bots/agent-face'

export interface TeammateChatPageProps {
  teammateId: string
  /** The teammate's name as the tab has it (the roster's wins once loaded). */
  name: string
  /** The teammate's workspace as the tab has it (the roster's wins once loaded). */
  workspaceId: string | null
  /** One of its work items, open on the page (Phase 2): the item on the work side, the conversation about it on the chat side. */
  itemId?: string
  /** The item's title, as the entry has it. */
  itemTitle?: string
  /** The page is on screen (its card drawn): its work is read while it is. */
  drawn: boolean
  /** Open one of this teammate's items on the page, or (null) go back to its lists. */
  onOpenItem: (item: TeammateChatItem | null) => void
  /** This agent in another workspace (the switcher), on its own page. */
  onSwitchTeammate: (teammateId: string, focus: BotPagePart) => void
}

/** The narrow window's two tabs, in order: the main column first. */
const PARTS: ReadonlyArray<{ part: BotPagePart; label: string }> = [
  { part: 'chat', label: 'Chat' },
  { part: 'work', label: 'Work' },
]

/** How the face's state is said, for a tooltip and assistive tech. */
const STATE_WORDS: Record<string, string | null> = { working: 'Working', sleeping: 'Asleep', default: null }

export function TeammateChatPage({
  teammateId: askedTeammateId,
  name: savedName,
  workspaceId: savedWorkspaceId,
  itemId,
  itemTitle,
  drawn,
  onOpenItem,
  onSwitchTeammate,
}: TeammateChatPageProps) {
  const { work, counts } = useAgentWorkShared()
  const { workspaces, currentId } = useWorkspaces()
  const user = useTeammateChatUser()
  // An area face's page is the agent's (one face).
  const teammateId = useMemo(() => agentTeammateIdFor(work.roster, askedTeammateId), [work.roster, askedTeammateId])
  const mate = useMemo(() => work.roster.find((t) => t.id === teammateId) ?? null, [work.roster, teammateId])
  // The roster has loaded (it comes with the first rows): a teammate it doesn't hold isn't there.
  const known = work.rows !== null
  const missing = !teammateId || (known && !mate)
  // Not in the roster yet (it loads with the first rows): pending, so nothing
  // opens a chat for a teammate it can't place yet (an area face's id before
  // it maps to the agent, the agent before its home hand-off is known).
  const pending = !missing && !mate
  const name = mate?.name?.trim() || savedName || 'Teammate'
  const workspaceId = mate?.workspace_id ?? savedWorkspaceId
  const workspaceName = useCallback(
    (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? null) : null),
    [workspaces],
  )
  const workspace = workspaceName(workspaceId)
  // Its face id: only its voice reads it (useBotVoice); nothing draws it.
  const face = asBotCharacter(mate?.bot_character)
  // The agent's face (one face): its page's chat hands off to the strip's home thread.
  const home = isAgentTeammate(mate)
  // An area face (one-agent S3; redirected above whenever its Assistant is
  // known): its page's chat is your main-chat conversation focused on its area.
  const area = home ? null : areaOfTeammate(mate)

  // Its work, read while the page is drawn and for a moment after (a card
  // folded away, or in a background tab, lets it go).
  const asked = useLinger(drawn ? teammateId : null, BOT_PAGE_LINGER_MS)
  const botWork = useBotWork(!missing && !pending && asked === teammateId ? teammateId : null)
  const running = counts.get(teammateKey(teammateId))?.running ?? 0
  // Stopped by the AI limit: one rule with its bot beside the chat. The shared
  // source's word whenever it holds an answer (crew-state.ts
  // aiLimitedTeammates: a later run of any kind wakes it); its own last
  // finished row only until then (bots-v4 Phase 4b).
  const aiLimit = work.aiLimited ? work.aiLimited.has(teammateId) : stoppedByAiLimit(botWork.lastFinished)
  const shownMate = botWork.teammate ?? mate
  const state = teammateBotState(shownMate ?? { autonomy: null, breaker: null }, running, aiLimit)
  // Asleep, it says which (switched off, attempts paused, the AI limit).
  const rest = state === 'sleeping' && shownMate ? teammateRest(shownMate, aiLimit) : null
  const stateWords = rest ? TEAMMATE_REST_WORDS[rest] : (STATE_WORDS[state] ?? null)

  // The switcher: this agent in the person's other workspaces (never grouped by face).
  const mates = useMemo(() => bubbleTeammates(sameAgentIds(mate, work.roster), work.roster, counts), [mate, work.roster, counts])
  const chips = useMemo(() => switcherChips(mates, workspaceName), [mates, workspaceName])
  const chipOrder = useMemo(() => switcherOrder(mates, currentId ?? null, workspaceName), [mates, currentId, workspaceName])

  // Two columns, or Work and Chat as tabs in a narrow window. An item's
  // column is wider, so it takes a wider page.
  const rootRef = useRef<HTMLDivElement>(null)
  const columns = usePageColumns(rootRef, itemId ? BOT_PAGE_ITEM_COLUMNS_MIN_PX : BOT_PAGE_COLUMNS_MIN_PX)
  const tabs = !columns
  // An item opens on the item (mounting on one, or moving to one), even in a
  // window that showed the bot's Chat.
  const [part, setPart] = useState<BotPagePart>(itemId ? 'work' : 'chat')
  const [partItem, setPartItem] = useState(itemId)
  if (partItem !== itemId) {
    setPartItem(itemId)
    if (itemId) setPart('work')
  }
  // Only the bot's lists hear what opened them asked; they take the ask.
  useEffect(() => (itemId ? undefined : onBotPageFocus(teammateId, setPart)), [teammateId, itemId])

  // The item open on it (Phase 2): its row as the panel loads it, else as the
  // page holds it (its own read, the shell's rows), for its chat.
  const [loaded, setLoaded] = useState<{ id: string; row: WorkItem | null; failed: boolean } | null>(null)
  const onItem = useCallback(
    (row: WorkItem | null, failed: boolean) => {
      if (itemId) setLoaded((had) => (had && had.id === itemId && had.row === row && had.failed === failed ? had : { id: itemId, row, failed }))
    },
    [itemId],
  )
  const own = loaded && loaded.id === itemId ? loaded : null
  const heldRow = useMemo(
    () => (itemId ? (botWork.rows?.find((r) => r.id === itemId) ?? work.rows?.find((r) => r.id === itemId) ?? null) : null),
    [itemId, botWork.rows, work.rows],
  )
  const itemRow = own?.row ?? heldRow
  const rowTitle = itemRow && 'title' in itemRow && typeof itemRow.title === 'string' ? itemRow.title : null
  const shownTitle = rowTitle || itemTitle || 'Work item'
  // Its card's title: what kind of work it is.
  const itemLabel = itemRow ? kindLabel(itemRow.kind) : 'Work item'
  // Back to its lists.
  const toLists = useCallback(() => onOpenItem(null), [onOpenItem])
  // What its rows open on this page (bot-page/use-bot-page-open.ts).
  const nav = useMemo<BotPageNav>(() => ({ openItem: (item) => onOpenItem(item) }), [onOpenItem])
  const ids = useId()
  const tabId = (p: BotPagePart) => `${ids}-${p}-tab`
  const panelId = (p: BotPagePart) => `${ids}-${p}-panel`
  const tabRefs = useRef<Partial<Record<BotPagePart, HTMLButtonElement | null>>>({})
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = PARTS.findIndex((p) => p.part === part)
    const to =
      e.key === 'ArrowRight' ? (at + 1) % PARTS.length : e.key === 'ArrowLeft' ? (at - 1 + PARTS.length) % PARTS.length : e.key === 'Home' ? 0 : e.key === 'End' ? PARTS.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    setPart(PARTS[to].part)
    tabRefs.current[PARTS[to].part]?.focus()
  }

  // In the desktop app, talking out loud: the mic, and replies read aloud in
  // the bot's own voice (always: the Preferences setting that could turn it
  // off went with the bots' section).
  const desktop = isDesktopApp()
  const botVoice = useBotVoice(face ?? '', mate?.voice)
  const voice = useMemo<TeammateChatVoice | undefined>(
    () => (desktop ? { ttsVoice: botVoice ?? null, readReplies: true } : undefined),
    [desktop, botVoice],
  )

  // A card refined in the chat (bots-v4.md Phase 3): the chat is about it (its
  // run's chat, or the bot's own thread with the card attached) until its
  // line's button goes back to the bot's own thread.
  const [refined, setRefined] = useState<{ teammateId: string; about: TeammateChatAbout } | null>(null)
  const chatAbout = refined?.teammateId === teammateId ? refined.about : null
  const refine = useCallback(
    (card: AttentionItem, item: BubbleItem | null) => {
      const target = refineTarget(item, card)
      setRefined({
        teammateId,
        about: target.runId
          ? { runId: target.runId, ...(target.context ? { context: target.context } : {}), title: target.title, workspaceId: target.workspaceId }
          : { context: target.context, title: target.title },
      })
      // A narrow window shows the chat it went to.
      setPart('chat')
      void sendRefine({ id: teammateId, workspaceId, focusArea: area, home }, target, refineText(card))
    },
    [teammateId, workspaceId, area, home, setPart],
  )
  const changeAbout = useCallback(
    (on: boolean) => setRefined((r) => (r ? { ...r, about: { ...r.about, off: !on } } : null)),
    [],
  )

  const chat = itemId ? (
    <div className="mx-auto flex min-h-0 w-full max-w-[var(--chat-reading-width,634px)] flex-1 flex-col px-4 pb-4 pt-3">
      <ItemChat
        key={itemId}
        teammateId={teammateId}
        name={name}
        workspaceId={workspaceId}
        row={itemRow}
        failed={!!own?.failed && !itemRow}
        title={shownTitle}
        voice={voice}
        userAvatarUrl={user.avatarUrl}
        userInitials={user.initials}
        home={home}
      />
    </div>
  ) : (
    <div className="mx-auto flex min-h-0 w-full max-w-[var(--chat-reading-width,634px)] flex-1 flex-col px-4 pb-4">
      <TeammateChat
        key={teammateId}
        teammateId={teammateId}
        workspaceId={workspaceId}
        userAvatarUrl={user.avatarUrl}
        userInitials={user.initials}
        className="h-full max-h-none w-full flex-1"
        voice={voice}
        autoFocus
        // The main chat's composer: this chat is as capable as the main one.
        composer="full"
        about={chatAbout}
        onAboutChange={chatAbout ? changeAbout : undefined}
        focusArea={area}
        home={home}
      />
    </div>
  )

  return (
    <BotPageNavContext.Provider value={nav}>
    <div
      ref={rootRef}
      data-teammate-chat-page={teammateId}
      data-teammate-chat-page-item={itemId}
      data-bot-page-layout={tabs ? 'tabs' : 'columns'}
      className="flex h-full min-h-0 flex-col"
    >
      <ViewHeader
        title={
          <div className="flex min-w-0 items-center gap-2">
            <span
              data-bot-page-face={state}
              title={stateWords ?? undefined}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]"
            >
              <AgentIcon />
            </span>
            <h1 data-teammate-chat-page-name="" title={name} className="min-w-0 truncate text-sm font-semibold">
              {name}
              {stateWords && !rest && <span className="sr-only">, {stateWords.charAt(0).toLowerCase() + stateWords.slice(1)}</span>}
            </h1>
            {rest && (
              <span data-bot-page-status={rest} className="shrink-0 text-xs font-medium text-amber-700 dark:text-amber-400">
                {TEAMMATE_REST_WORDS[rest]}
              </span>
            )}
            {workspace && (
              <span data-teammate-chat-page-workspace="" title={workspace} className="min-w-0 truncate text-xs text-muted-foreground">
                {workspace}
              </span>
            )}
            {!missing && mates.length > 1 && (
              <div role="group" aria-label="This agent in other workspaces" data-bot-page-switcher="" className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {chipOrder.map((i) => {
                  const other = mates[i]
                  const current = other.id === teammateId
                  return (
                    <button
                      key={other.id}
                      type="button"
                      aria-pressed={current}
                      title={chips[i].title}
                      // That teammate's own page.
                      onClick={current ? undefined : () => onSwitchTeammate(other.id, part)}
                      className={cn(
                        'relative inline-flex h-6 max-w-[10rem] shrink-0 items-center rounded-full border px-2 text-[11px] transition-colors',
                        current ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border/60 text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <span className="truncate">{chips[i].label}</span>
                      {other.hasNew && !current && <span aria-label="Something new" className="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                    </button>
                  )
                })}
              </div>
            )}
            {itemId && (
              <>
                <span aria-hidden className="text-muted-foreground/50">
                  /
                </span>
                <span data-teammate-chat-page-item-title="" title={shownTitle} className="min-w-0 truncate text-xs text-muted-foreground">
                  {shownTitle}
                </span>
              </>
            )}
          </div>
        }
      />
      {missing ? (
        <div role="status" data-teammate-chat-page-missing="" className="flex flex-1 items-center justify-center px-4 pb-4 text-sm text-muted-foreground">
          This teammate isn’t available any more.
        </div>
      ) : pending ? (
        <div role="status" data-teammate-chat-page-pending="" className="flex flex-1 items-center justify-center px-4 pb-4 text-sm text-muted-foreground">
          Loading…
        </div>
      ) : (
        <div className={cn('flex min-h-0 flex-1', tabs ? 'flex-col' : 'flex-row')}>
          {tabs && (
            <div role="tablist" aria-label={`${name}’s page`} data-bot-page-tabs="" className="flex shrink-0 gap-1 px-4 pb-2">
              {PARTS.map(({ part: p, label }) => (
                <button
                  key={p}
                  ref={(el) => {
                    tabRefs.current[p] = el
                  }}
                  type="button"
                  role="tab"
                  id={tabId(p)}
                  aria-selected={part === p}
                  aria-controls={panelId(p)}
                  tabIndex={part === p ? 0 : -1}
                  onClick={() => setPart(p)}
                  onKeyDown={onTabKey}
                  className={cn(
                    'inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition-colors',
                    part === p ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {/* The chat: the main column, on the left (with an item open, the conversation about it). */}
          <div
            id={panelId('chat')}
            role={tabs ? 'tabpanel' : 'region'}
            aria-labelledby={tabs ? tabId('chat') : undefined}
            aria-label={tabs ? undefined : 'Chat'}
            hidden={tabs && part !== 'chat'}
            data-bot-page-chat=""
            className="flex min-h-0 min-w-0 flex-1 flex-col"
          >
            {chat}
          </div>
          {/* Its work: floating cards in a narrower column on the right, scrolling as a whole;
              with an item open, the item as a card, in a wider column, scrolling inside its card. */}
          <div
            id={panelId('work')}
            role={tabs ? 'tabpanel' : 'region'}
            aria-labelledby={tabs ? tabId('work') : undefined}
            aria-label={tabs ? undefined : 'Work'}
            hidden={tabs && part !== 'work'}
            data-bot-page-work={itemId ? 'item' : 'lists'}
            className={cn(
              'min-h-0',
              itemId ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
              tabs ? 'flex-1' : cn('shrink-0', itemId ? 'w-[clamp(22rem,46%,34rem)]' : 'w-[clamp(20rem,36%,25rem)]'),
            )}
          >
            {itemId ? (
              <ItemPane key={itemId} itemId={itemId} name={name} label={itemLabel} shown={!tabs || part === 'work'} onBack={toLists} onItem={onItem} />
            ) : (
              <BotWork teammateId={teammateId} name={name} mate={mate} work={botWork} aiLimit={aiLimit} onRefine={refine} />
            )}
          </div>
        </div>
      )}
    </div>
    </BotPageNavContext.Provider>
  )
}
