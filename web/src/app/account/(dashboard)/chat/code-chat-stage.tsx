'use client'

/**
 * The Code view's middle (Liam, 11-16: the coding chat in the dashboard, as
 * the agent's chat is): the selected coding chat's conversation where the
 * agent's thread stands, in the chat's own reading column, between the top
 * bar and the composer.
 *
 * It is the local agent's panel as it draws everywhere (LocalAgentPanel:
 * the request, everything since, Conversation and Changes, the branch card),
 * without its own box: the main composer under it messages the chat
 * (composer-code.tsx). The same for every coding agent, ours or the
 * person's own (Liam, 11-16). It is the session's one reader: what it holds
 * goes to the Code view's store for the composer and the right panel
 * (code-view-store.ts).
 *
 * Nothing while the composer is on the agent's tab. On Code it stops the
 * agent's thread painting (Liam, 11-16: "everything clears up"; mounted and
 * where it was for the way back), with a chat selected or not: with none
 * the Code view is clear, and the next send starts a chat. The rule is its
 * own <style>, here, not the app's stylesheet: it comes and goes with the
 * view in the same commit, and is never a stale copy of a big file (Liam,
 * 11-16: "the main chat and the agents chats are showing at the same time").
 * Mounted in the thread's stage (chat-panel.tsx).
 *
 * Its turn's summary (the `finish` card) is not drawn while the right panel
 * shows the job's record (Liam, 11-20: "remove that finished message from the
 * main chat and just keep the one on the side panel"): the Review card's
 * "What happened" says the same, its action ids as live chips. With the panel
 * closed, or no record yet, the card is drawn as everywhere else.
 */
import { useCallback, useEffect } from 'react'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { getClientWorkspaceId } from '@/lib/workspace-fetch'
import { LocalAgentPanel } from '@/components/local-agent/local-agent-panel'
import { SESSION_GONE_MESSAGE } from '@/components/local-agent/session-api'
import { useSidePanelState } from '../side-panels/side-panels'
import { setCodeChatError, setCodeChatLive, syncCodeViewWorkspace, type CodeChatLive } from './code-view-store'
import { rightShown } from '../side-panels/side-panel-store'
import { CodeChatsRows, useCodeChats } from '../page-panel/code-chats'
import { useCodeView } from './use-code-view'
import { newCodingChat } from './current-chat-store'
import { useOptionalAgentWorkShared } from '@/components/work/agent-work-provider'

export function CodeChatStage() {
  const state = useSidePanelState()
  const { codeView } = state
  const { selected, attempt, live } = useCodeView()
  // As code-chat-sections.tsx decides it: the Review card is drawn only in the shell, once the job has its record.
  const inShell = useOptionalAgentWorkShared() !== null
  // The selection belongs to the window's workspace (the store's own check: this
  // panel remounts on a workspace switch, so it could not see one): another
  // workspace's chat never shows here, and this one's last chat comes back.
  const workspaceId = getClientWorkspaceId()
  useEffect(() => {
    syncCodeViewWorkspace()
  }, [workspaceId])
  const onError = useCallback(
    (message: string) => {
      if (selected) setCodeChatError(selected, message, message === SESSION_GONE_MESSAGE)
    },
    [selected],
  )
  const onLive = useCallback(
    (live: CodeChatLive | null) => {
      if (selected) setCodeChatLive(selected, live)
    },
    [selected],
  )
  if (!codeView) return null
  // The list isn't on screen beside the navigation (a narrow window, or the
  // panel closed): it is offered here, so a chat can always be picked, and a
  // chat on screen has a way back to it.
  const listHere = !state.pagePanelShown
  // The right panel shows the chat's agent, folder, status and Stop: the conversation's own header would say them twice.
  const detailsShown = rightShown(state)
  // The right panel's Review card carries the summary: the conversation doesn't repeat it.
  const summaryBeside = detailsShown && inShell && !!live?.session.trackedJobId
  return (
    <>
      <style data-code-view-style="">{HIDE_THREAD_CSS}</style>
      {selected ? (
        <Stage key={attempt} selected={selected} onLive={onLive} onError={onError} header={!detailsShown} back={listHere} hideFinish={summaryBeside} />
      ) : listHere ? (
        <ListHere />
      ) : null}
    </>
  )
}

/**
 * Everything of the thread's stage but this conversation and the stage full
 * screen pages draw on: out of sight and out of the pointer's way. Opacity
 * too: a child with a visibility of its own (the scroll button) would show.
 */
export const HIDE_THREAD_CSS =
  '#ni-chat-strip-slot [data-chat-thread-stage] > :not([data-code-chat-stage]):not([data-chat-card-stage]):not(style){visibility:hidden!important;opacity:0!important;pointer-events:none!important}'

const STAGE = 'absolute inset-x-0 bottom-[var(--chat-bottom-inset,0px)] top-[var(--chat-top-inset,0px)] z-20 flex min-h-0 justify-center'

function Stage({
  selected,
  onLive,
  onError,
  header,
  back,
  hideFinish,
}: {
  selected: string
  onLive: (live: CodeChatLive | null) => void
  onError: (message: string) => void
  header: boolean
  back: boolean
  hideFinish: boolean
}) {
  return (
    <div data-code-chat-stage={selected} className={STAGE}>
      <div className="chat-reading-col flex h-full min-h-0 w-full flex-col px-5 pb-2 pt-1">
        {back && (
          <button
            type="button"
            data-code-chat-back=""
            onClick={() => newCodingChat({ from: 'stage' })}
            className="mb-1 inline-flex h-7 shrink-0 items-center gap-1 self-start rounded-full px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft aria-hidden className="size-3.5" />
            Coding chats
          </button>
        )}
        {/* Keyed by the chat: another one is another conversation, read afresh. */}
        <LocalAgentPanel key={selected} sessionId={selected} composer={false} header={header} onLive={onLive} onError={onError} hideScrollbar hideFinish={hideFinish} className="min-h-0 flex-1" />
      </div>
    </div>
  )
}

/** The coding chats, in the middle, where the panel beside the navigation isn't on screen. Nothing with none yet. */
function ListHere() {
  const { items, readAt } = useCodeChats(true, null)
  if (!readAt || items.length === 0) return null
  return (
    <div data-code-chat-stage="list" className={STAGE}>
      <div className="chat-reading-col flex h-full min-h-0 w-full flex-col px-5 pb-2 pt-1">
        <div data-code-chats="" className={cn('ph-no-capture flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-2 scrollbar-hide-deep', FLOATING_CARD_CLASS)}>
          <CodeChatsRows items={items} readAt={readAt} />
        </div>
      </div>
    </div>
  )
}
