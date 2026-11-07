'use client'

/**
 * A bot's page in item view (docs/plans/bots-v4.md "An item opens on its bot's
 * page", Phase 2): one of its teammate's work items, open on the page. The
 * page's tab entry carries the item (`itemId`); Back returns to the bot's
 * lists.
 *
 *   ItemPane   the work side, on the page's right: the way back to the bot's
 *              lists, then one of the page's cards (BotPageCard, filling the
 *              column, titled by the item's kind) holding the work item panel
 *              as an embedded view (work-item-detail-panel.tsx `embedded`):
 *              what happened, what it has for you, what it delivered,
 *              everything it looked at, the task, log and steps, handoffs,
 *              held contacts, Stop, and its properties, in the column's narrow
 *              sizes. It's stamped opened only while it's drawn, shown on the
 *              page (a narrow page shows its work or its chat: `shown`), and
 *              focused, and only for its owner (the panel's rule).
 *   ItemChat   the chat side, on the page's left (its main column): the
 *              conversation about the item, found from the item
 *              (rowConversation, the bubble's rule): a work run's chat (its
 *              parked session, /api/account/agent-runs/[id]/chat) or a loop
 *              run's (`loop:<work item id>`, /api/account/activity/[id]/chat),
 *              shown once, by RunChat (its question picker included): the
 *              run's own view (CloudRunByIdView), whose details the panel
 *              already shows, isn't drawn. While its run waits on an answer,
 *              what's sent answers it; a run whose chat the route refuses
 *              (someone else started it, it's still running, it has no
 *              session), and an item with no run chat, talk to the teammate's
 *              own thread with the item attached (TeammateChat `about`).
 *              "<name>'s own chat" switches to that thread for this item, and
 *              back. The main chat's composer either way. A person's own run
 *              a bot was routed to (bots-v4 Phase 5, rowConversation `own`)
 *              reads "Your run’s chat": it runs on the run's own limits, not
 *              the bot's. A local agent's turn (`kind: 'local_agent'`,
 *              local-agents contract G) is a conversation of its own: the
 *              Dial8 agent's and yours with the agent working on your Mac,
 *              the whole session across its turns (LocalAgentPanel), with
 *              its box to message it as you. It isn't remounted when the
 *              turn settles (the session goes on), and the work side doesn't
 *              draw it again (`conversationBeside`).
 */
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, MessageCircle } from 'lucide-react'
import { WorkItemDetailPanel } from '@/components/work/work-item-detail-panel'
import { RunChat } from '@/components/agent-run/run-chat'
import { useRunChat } from '@/hooks/use-run-chat'
import { aboutLineLabel, aboutTitle, rowConversation } from '@/lib/bots/item-run-chat'
import type { BubbleRow } from '@/lib/bots/bubble-items'
import { isWorkLive, type WorkItem } from '@/lib/work/types'
import { localAgentSessionIdOf } from '@/lib/local-agent/transcript-view'
import { LocalAgentPanel } from '@/components/local-agent/local-agent-panel'
import { TeammateChat, type TeammateChatAbout, type TeammateChatVoice } from '../teammate-chat'
import { BotPageCard } from './bot-page-card'

/** The work side: back to the bot's lists, then the item as a card (the page's cards: BotPageCard). */
export function ItemPane({
  itemId,
  name,
  label,
  shown,
  onBack,
  onItem,
}: {
  itemId: string
  /** The bot's name, for the way back. */
  name: string
  /** The card's title: what kind of work it is ("Work run", "Loop run"). */
  label: string
  /** The page shows this side now (a narrow page shows Work or Chat). */
  shown: boolean
  /** Back to the bot's lists. */
  onBack: () => void
  /** The item as the panel loads it (null until then); `failed` once it couldn't. */
  onItem: (item: WorkItem | null, failed: boolean) => void
}) {
  return (
    // The cards' stack insets (bot-work.tsx): the column clips, and the card's shadow fades out in them.
    <div data-bot-page-item={itemId} className="flex h-full min-h-0 flex-col gap-2 px-4 pb-6 pt-2">
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          data-bot-page-item-back=""
          onClick={onBack}
          aria-label={`Back to ${name}’s work`}
          className="inline-flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
        >
          <ChevronLeft aria-hidden className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{name}’s work</span>
        </button>
      </div>
      <BotPageCard section="item" title={label} fill>
        <WorkItemDetailPanel key={itemId} itemId={itemId} embedded shown={shown} onItem={onItem} conversationBeside />
      </BotPageCard>
    </div>
  )
}

/** The conversation's key fields, so a pushed row that changes none of them changes nothing. */
function conversationKey(row: BubbleRow | null): string {
  if (!row) return ''
  const c = rowConversation(row)
  return c ? JSON.stringify([c.runId ?? null, c.context?.workItemId ?? c.context?.cardId ?? null, !!c.asking, c.workspaceId ?? null]) : 'none'
}

interface ItemChatProps {
  teammateId: string
  name: string
  /** The teammate's workspace (its own thread is sent there). */
  workspaceId: string | null
  /** The item's row: the panel's once loaded, else one the page holds; null until either has it. */
  row: BubbleRow | null
  /** The item couldn't be loaded: its teammate's own thread, about nothing. */
  failed: boolean
  /** The item's title, for "About: <title>". */
  title: string
  voice?: TeammateChatVoice
  userAvatarUrl: string | null
  userInitials: string
  /** The agent's face (one face): its own chat is the home thread, handed off to the chat strip's home tab (TeammateChat `home`). */
  home?: boolean
}

/**
 * The chat side: the conversation about the item. A run still going has no
 * chat to be had (the route refuses it while the run isn't settled); once it
 * settles, its chat is asked for again (the conversation remounts on the
 * change, and a refused replay is read again on the next mount), so a run
 * that finishes while its item is open brings its chat.
 */
export function ItemChat(props: ItemChatProps) {
  // Back on the teammate's own thread for this item (the line's switch), kept across a remount.
  const [off, setOff] = useState(false)
  const live = !!props.row && isWorkLive(props.row.status)
  // A local agent's session outlives its turn's row: its conversation stays mounted as the turn settles.
  const local = !!props.row && props.row.kind === 'local_agent'
  return <ItemConversation key={local ? 'local' : live ? 'live' : 'settled'} {...props} off={off} setOff={setOff} />
}

function ItemConversation({
  teammateId,
  name,
  workspaceId,
  row,
  failed,
  title,
  voice,
  userAvatarUrl,
  userInitials,
  home = false,
  off,
  setOff,
}: ItemChatProps & { off: boolean; setOff: (off: boolean) => void }) {
  const key = conversationKey(row)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is what the conversation reads of the row
  const conversation = useMemo(() => (row ? rowConversation(row) : null), [key])
  const about = aboutTitle(title)
  const runId = conversation?.runId ?? null
  // Its run's chat, where it can be had: the replay says (the same conversation as the bubble's).
  const run = useRunChat(runId && !conversation?.asking && !off ? runId : null)
  // What the last settled read said holds while a re-read is out. A refused
  // replay is read again (the fallback's TeammateChat asks a moment after it
  // mounts), and that re-read clears the refusal while it's out: without this,
  // the side would flip to RunChat and back, re-reading every second or so.
  const [refused, setRefused] = useState(false)
  const hasRun = !!run
  const runLoading = run?.loading ?? false
  const runRefusal = run?.refusal ?? null
  useEffect(() => {
    if (hasRun && !runLoading) setRefused(!!runRefusal)
  }, [hasRun, runLoading, runRefusal])
  const onRun = !!runId && !conversation?.asking && !off && !!run && !runRefusal && !(refused && runLoading)

  const teammateAbout = useMemo<TeammateChatAbout | null>(
    () => (conversation ? { ...conversation, title: about, off } : null),
    [conversation, about, off],
  )

  if (!row && !failed) {
    return (
      <p data-bot-page-item-chat="loading" className="py-6 text-center text-xs text-muted-foreground">
        Loading…
      </p>
    )
  }
  // A local agent's turn: the session's own conversation (the Dial8 agent, you, and the agent on your Mac).
  const localSessionId = row ? localAgentSessionIdOf(row) : null
  if (localSessionId) {
    return (
      <div data-bot-page-item-chat="local-agent" className="flex min-h-0 flex-1 flex-col">
        <LocalAgentPanel key={localSessionId} sessionId={localSessionId} autoFocus />
      </div>
    )
  }
  if (onRun && runId) {
    return (
      <div data-bot-page-item-chat="run" data-bot-page-item-run={runId} className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate" title={about}>
            {aboutLineLabel({ own: !!conversation?.own })}: {about}
          </span>
          <button
            type="button"
            data-bot-page-item-own-chat=""
            onClick={() => setOff(true)}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
          >
            <MessageCircle aria-hidden className="h-3 w-3" />
            {name}’s own chat
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <RunChat
            key={runId}
            runId={runId}
            userAvatarUrl={userAvatarUrl}
            userInitials={userInitials}
            workspaceId={conversation?.workspaceId ?? workspaceId}
            // A person's own run is its own agent, not the bot's ("the run's own").
            agentName={conversation?.own ? null : name}
            voice={voice}
            autoFocus
          />
        </div>
      </div>
    )
  }
  return (
    <div data-bot-page-item-chat={teammateAbout ? 'teammate' : 'own'} className="flex min-h-0 flex-1 flex-col">
      <TeammateChat
        key={teammateId}
        teammateId={teammateId}
        workspaceId={workspaceId}
        userAvatarUrl={userAvatarUrl}
        userInitials={userInitials}
        className="h-full max-h-none w-full flex-1"
        voice={voice}
        autoFocus
        composer="full"
        about={failed ? null : teammateAbout}
        onAboutChange={(on) => setOff(!on)}
        home={home}
      />
    </div>
  )
}
