'use client'

import { memo, useMemo, useState, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { isOpenedCardMessage } from '@/lib/chat-cards/opened-card'
import { reactionTurnOfMetadata } from '@/lib/chat/message-reactions'
import { withDayLines } from '@/lib/chat/message-time'
import { Button } from '@/components/ui/button'
import { ChatMessage } from './chat-message'
import { ChatDayLine, MessageTimeGutter } from './chat-day-line'
import { NewestPlanContext, newestPlanCallId } from './chat-plan-thread'
import { replyCopyFor } from './reply-link'

/**
 * How many trailing messages render by default. A DOM/fiber cap, NOT data
 * loss: the full array stays in useChat state (auto-save, snapshots, the
 * pending-question scan and latestUserMessageId all read the complete array) —
 * only the RENDERED window is bounded, so a session-long conversation stops
 * mounting thousands of ChatMessage subtrees (2026-08-05 incident: the whole
 * 1.5h conversation's DOM + fibers stayed mounted with no cap).
 */
export const CHAT_MESSAGE_WINDOW = 100

/**
 * Pure windowing: the visible tail of `messages` plus how many earlier
 * messages are hidden behind the expander. `showAll` (the expander clicked)
 * or a list at/under the window renders everything with zero hidden.
 */
export function windowChatMessages(
  messages: UIMessage[],
  showAll: boolean,
): { visible: UIMessage[]; hiddenCount: number } {
  if (showAll || messages.length <= CHAT_MESSAGE_WINDOW) {
    return { visible: messages, hiddenCount: 0 }
  }
  return {
    visible: messages.slice(messages.length - CHAT_MESSAGE_WINDOW),
    hiddenCount: messages.length - CHAT_MESSAGE_WINDOW,
  }
}

/**
 * The rendered message list, split out of ChatPanel and memoized. ChatPanel
 * re-renders on every keystroke (the `input` state lives there) and — while a
 * reply streams — on every throttled token; none of that changes the message
 * list's inputs. Its props (`messages` array, derived `latestUserMessageId`, and
 * the two stable user strings) only change when useChat actually mutates the
 * conversation, so shallow-prop memo bails on every keystroke, and the memoized
 * ChatMessage children then bail per-message on the streaming path. Pure
 * presentational — no closures over ChatPanel state, so extracting it is
 * behavior-neutral.
 *
 * Long conversations render only the last CHAT_MESSAGE_WINDOW messages, with a
 * "Show earlier messages" expander at the top of the visible window. Expansion
 * is sticky for the mounted list; a New chat / conversation load shrinks the
 * array back under the window, which renders everything anyway.
 *
 * A reaction's own turn (message-reactions.ts) is never drawn either (Liam,
 * 10-20: "this can go in the background to the agent, but I don't want to see
 * it"): its reaction is on the bubble already, and the agent's answer shows.
 *
 * `hideOpenedCards` (the main chat): a page the person opened is a message of
 * its own (lib/chat-cards/opened-card.ts) that is never drawn in the chat (it
 * opens full screen, and is mounted outside the list, kept-card-host.tsx), so
 * it takes no row here, and no gap. The agent's own cards in its replies still
 * draw here.
 *
 * A line marks the first message of each day, and each message the agent
 * posted on its own (lib/chat/message-time.ts withDayLines), over the DRAWN
 * messages, so a hidden opened card never makes one. `dayBefore` is the time
 * of the message drawn just above the list (the earlier pages' last), so a day
 * across that seam gets one line; with the expander up, the first message
 * shown gets its own. `messageTimes`: each message's time on hover, in the
 * gutter beside it (a host with a reading column's gutter: the main chat).
 */
export const ChatMessageList = memo(function ChatMessageList({
  messages,
  latestUserMessageId,
  userAvatarUrl,
  userInitials,
  streamingMessageId = null,
  hideOpenedCards = false,
  topSlot = null,
  dayBefore = null,
  messageTimes = false,
}: {
  messages: UIMessage[]
  latestUserMessageId: string | null
  userAvatarUrl: string | null
  userInitials: string
  /** The reply streaming in right now (its turn hasn't settled), or null. */
  streamingMessageId?: string | null
  /** Leave out the pages the person opened (they never draw in the chat). */
  hideOpenedCards?: boolean
  /**
   * Drawn above the list once every message it holds is shown (no expander):
   * the earlier pages read from the server (earlier-messages.tsx, A3), which
   * are older than anything here.
   */
  topSlot?: ReactNode
  /** The time of the message drawn just above the list, or null. */
  dayBefore?: number | null
  /** Show each message's time on hover, in the gutter beside it. */
  messageTimes?: boolean
}) {
  const [showAll, setShowAll] = useState(false)
  const drawn = useMemo(
    () => messages.filter((m) => !(hideOpenedCards && isOpenedCardMessage(m)) && !(m.role === 'user' && reactionTurnOfMetadata(m.metadata))),
    [messages, hideOpenedCards],
  )
  const { visible, hiddenCount } = windowChatMessages(drawn, showAll)
  // One pass over at most the window: the same cost however long the thread.
  const rows = useMemo(() => withDayLines(visible, { dayBefore: hiddenCount === 0 ? dayBefore : null }), [visible, hiddenCount, dayBefore])
  // Only the conversation's newest plan draws in full (chat-plan-thread.ts).
  const newestPlan = useMemo(() => newestPlanCallId(messages), [messages])
  // The drawn messages by id: what a reply's capsule can copy (reply-link.ts).
  const drawnById = useMemo(() => new Map(visible.map((m) => [m.id, m])), [visible])
  return (
    <NewestPlanContext.Provider value={newestPlan}>
      {hiddenCount === 0 && topSlot}
      {hiddenCount > 0 && (
        <div className="flex justify-center py-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-3 text-xs text-muted-foreground"
            onClick={() => setShowAll(true)}
          >
            Show earlier messages ({hiddenCount})
          </Button>
        </div>
      )}
      {rows.map((row) => {
        if (row.type === 'line') return <ChatDayLine key={row.key} label={row.label} />
        // What a reply's capsule copies: the message (or bubble) it answers, when drawn here (reply-link.ts).
        const replyCopy = row.message.role === 'user' ? replyCopyFor(row.message, drawnById) : null
        return (
          <div
            key={row.message.id}
            data-latest-user-message={row.message.id === latestUserMessageId ? '' : undefined}
            // What a swipe replies to and a quote goes back to (use-swipe-to-reply.ts, message-interactions.ts).
            data-message-row={row.message.id}
            data-message-role={row.message.role}
            className="group/msg relative touch-pan-y"
          >
            {messageTimes && row.time !== null && <MessageTimeGutter time={row.time} side={row.message.role === 'user' ? 'right' : 'left'} />}
            <ChatMessage
              message={row.message}
              userAvatarUrl={userAvatarUrl}
              userInitials={userInitials}
              streaming={row.message.id === streamingMessageId}
              wholeReadAloud
              replyCopy={replyCopy}
            />
          </div>
        )
      })}
    </NewestPlanContext.Provider>
  )
})
