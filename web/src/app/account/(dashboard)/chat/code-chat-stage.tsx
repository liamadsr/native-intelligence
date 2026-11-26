'use client'

/**
 * The Code view's middle (Liam, 11-16: the coding chat in the dashboard, as
 * the agent's chat is): the selected coding chat's conversation where the
 * agent's thread stands, in the chat's own reading column, between the top
 * bar and the composer.
 *
 * It is the local agent's panel as it draws everywhere (LocalAgentPanel:
 * the request, everything since, the branch card), the conversation only
 * (Liam, 11-25: "it should just be the conversation, and changes should show
 * on their own panel"): its Changes open in the right panel (side-panel-store.ts
 * openCodeChanges; code-chat-sections.tsx CodeChangesPanel), from the branch
 * card here or the Changes card there, with "Open pull request" on that card.
 * Without its own box: the main composer under it messages the chat
 * (composer-code.tsx). The same for every coding agent, ours or the
 * person's own (Liam, 11-16). It is the session's one reader: what it holds
 * goes to the Code view's store for the composer and the right panel
 * (code-chat-live.ts).
 *
 * Nothing while the agent's chat is the current one. While a coding chat (or
 * a new one) is, the agent's thread is out of sight (Liam, 11-16:
 * "everything clears up"), mounted and where it was for the way back: by the
 * thread's own props, set by the same render that draws this (chat-panel.tsx,
 * thread-hidden.ts), never by a rule in a stylesheet or an injected style element,
 * which can be a commit apart from what it hides (Liam, 11-16: "the main chat
 * and the agents chats are showing at the same time").
 * Mounted in the thread's stage (chat-panel.tsx).
 *
 * Its turn's summary (the `finish`) is drawn in the conversation, as the
 * agent's own words: the right panel no longer shows the job's record with
 * its "What happened" (Liam, 11-26: "I'm not sure we need the summary and the
 * steps, details"), so the conversation is where it is read (it was left out
 * here while the panel carried it: Liam, 11-20).
 */
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { LocalAgentPanel } from '@/components/local-agent/local-agent-panel'
import { SESSION_GONE_MESSAGE } from '@/components/local-agent/session-api'
import { useSidePanelState } from '../side-panels/side-panels'
import { setCodeChatError, setCodeChatLive, type CodeChatLive } from './code-chat-live'
import { rightShown } from '../side-panels/side-panel-store'
import { CodeChatsRows, useCodeChats } from '../page-panel/code-chats'
import { useCodeView } from './use-code-view'
import { backToAgent, forgetCodingChat, syncCurrentChatWorkspace } from './current-chat-store'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import { FIRST_TIME_KEY, FIRST_TIME_LINE } from './one-home-decisions'
import { showOnlyCoding } from '../page-panel/use-recents-filter'
import { setHomeSide } from '../page-panel/home-side'
import { openCodeChanges, setPagePanelOpen } from '../side-panels/side-panel-store'

export function CodeChatStage() {
  const state = useSidePanelState()
  const onCode = state.chatKind !== 'agent'
  const { selected, attempt } = useCodeView()
  // The selection belongs to the window's workspace (the store's own check: this
  // panel remounts on a workspace switch, so it could not see one): another
  // workspace's chat never shows here, and this one's last chat comes back.
  const workspaceId = getClientWorkspaceId()
  useEffect(() => {
    syncCurrentChatWorkspace()
  }, [workspaceId])
  const onError = useCallback(
    (message: string) => {
      if (!selected) return
      setCodeChatError(selected, message)
      // Gone: no longer the chat a reload comes back to. A read that only failed keeps it.
      if (message === SESSION_GONE_MESSAGE) forgetCodingChat(selected)
    },
    [selected],
  )
  const onLive = useCallback(
    (live: CodeChatLive | null) => {
      if (selected) setCodeChatLive(selected, live)
    },
    [selected],
  )
  if (!onCode) return null
  // Recent isn't on screen beside the navigation (a narrow window, a phone,
  // the panel closed): a new chat's middle lists the coding chats, so one can
  // always be picked, and a chat on screen has its way back to the agent
  // here ("‹ Joseph"; the pinned row and the toggle are the other two).
  const listHere = !state.pagePanelShown
  // The right panel shows the chat's agent, folder, status and Stop: the conversation's own header would say them twice.
  const detailsShown = rightShown(state)
  return (
    <>
      {selected ? (
        <Stage key={attempt} selected={selected} onLive={onLive} onError={onError} header={!detailsShown} back={listHere} />
      ) : (
        <NewChat listHere={listHere} />
      )}
    </>
  )
}

const STAGE = 'absolute inset-x-0 bottom-[var(--chat-bottom-inset,0px)] top-[var(--chat-top-inset,0px)] z-20 flex min-h-0 justify-center'

function Stage({
  selected,
  onLive,
  onError,
  header,
  back,
}: {
  selected: string
  onLive: (live: CodeChatLive | null) => void
  onError: (message: string) => void
  header: boolean
  back: boolean
}) {
  const { name: agentName } = useAssistantName()
  return (
    <div data-code-chat-stage={selected} className={STAGE}>
      <div className="chat-reading-col flex h-full min-h-0 w-full flex-col px-5 pb-2 pt-1">
        {back && (
          <button
            type="button"
            data-code-chat-back=""
            onClick={() => backToAgent({ from: 'stage' })}
            className="mb-1 inline-flex h-7 shrink-0 items-center gap-1 self-start rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
            {agentName}
          </button>
        )}
        {/* Keyed by the chat: another one is another conversation, read afresh. */}
        <LocalAgentPanel key={selected} sessionId={selected} composer={false} header={header} onLive={onLive} onError={onError} hideScrollbar onOpenChanges={openCodeChanges} className="min-h-0 flex-1" />
      </div>
    </div>
  )
}

function firstTimeSeen(): boolean {
  try {
    return typeof window === 'undefined' || window.localStorage.getItem(FIRST_TIME_KEY) === '1'
  } catch {
    return true
  }
}

/**
 * A new coding chat's clear middle (Liam, 11-16: "everything clears up").
 * Once per device, until dismissed, one line for someone used to the Code
 * tab's own list (docs/plans/one-home.md, "The first time"): the coding chats
 * are in Recent now, with a press that shows only them. And where Recent
 * isn't on screen, the coding chats themselves, so one can always be picked.
 */
function NewChat({ listHere }: { listHere: boolean }) {
  const { items, readAt } = useCodeChats(listHere, null)
  const [hint, setHint] = useState(false)
  // After mount: the server and the first client render agree (no line), then the device says.
  useEffect(() => setHint(!firstTimeSeen()), [])
  // Only beside Recent itself: where it is not on screen (a phone, the panel closed) the line would point at nothing, and the chats are listed right here.
  const showHint = hint && !listHere
  const dismiss = () => {
    try {
      window.localStorage.setItem(FIRST_TIME_KEY, '1')
    } catch {
      // Storage blocked: it is gone for this page.
    }
    setHint(false)
  }
  const list = listHere && readAt !== null && items.length > 0
  if (!showHint && !list) return null
  return (
    <div data-code-chat-stage={list ? 'list' : 'new'} className={STAGE}>
      <div className="chat-reading-col flex h-full min-h-0 w-full flex-col gap-2 px-5 pb-2 pt-1">
        {showHint && (
          <div data-code-first-time="" className={cn('flex shrink-0 items-center gap-2 self-start px-3 py-2 text-xs text-muted-foreground', FLOATING_CARD_CLASS)}>
            <span>{FIRST_TIME_LINE}</span>
            <button
              type="button"
              data-code-first-time-show=""
              onClick={() => {
                // Recent, on its coding chats only, on screen.
                showOnlyCoding()
                setHomeSide('recent')
                setPagePanelOpen(true)
                dismiss()
              }}
              className="shrink-0 rounded-full px-2 py-0.5 font-medium text-foreground hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show only coding
            </button>
            <button
              type="button"
              data-code-first-time-dismiss=""
              aria-label="Dismiss"
              onClick={dismiss}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        )}
        {list && readAt && (
          <div data-code-chats="" className={cn('ph-no-capture flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-2 scrollbar-hide-deep', FLOATING_CARD_CLASS)}>
            <CodeChatsRows items={items} readAt={readAt} />
          </div>
        )}
      </div>
    </div>
  )
}
