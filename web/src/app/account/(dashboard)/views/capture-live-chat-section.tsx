'use client'

/**
 * The capture page's "Live chat" section (one-chat plan, Slice 3, "After the
 * call"): the call's thread with its live agent, read-only. During the call the
 * person talked to the live agent in its HUD (components/live-chat); after it,
 * the thread is read here, on the capture's own page: there is no history list
 * anywhere.
 *
 *   - useCaptureLiveChat says whether the capture has a thread worth a section
 *     (GET /api/account/chat-history/live: its conversation and how many
 *     messages it holds), read once per capture, and again when its recording
 *     stops. No thread, or an empty one: no section (nothing to show, nothing
 *     drawn).
 *   - CaptureLiveChatSection reads the thread itself (GET
 *     /api/account/chat-history/[id]) when the section is opened, and draws it
 *     with the live chat's own model (live-chat-model.ts): the person's
 *     messages, the agent's replies and heads-ups, the questions it asked, and
 *     how many items it captured. Nothing here sends a message.
 *   - The agent's heads-ups (say_to_user rows) take thumbs here, after the
 *     call: the chat's own feedback store and route (useMessageFeedback,
 *     MessageFeedbackButtons, /api/account/chat/feedback), keyed by the row's
 *     ui_message id in this conversation; a thumbs-down offers the nudge's
 *     quick reason chips. Muted, shown on hover or focus, and kept shown once
 *     rated so the rating reads. A call with no heads-ups draws no rating UI
 *     and reads no ratings.
 */
import { useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { cn } from '@/lib/utils'
import { liveChatRows, plainText, type LiveChatRow } from '@/components/live-chat/live-chat-model'
import { MessageActions } from '@/components/ui/message'
import { useMessageFeedback } from '@/hooks/use-message-feedback'
import { canRateMessage, MessageFeedbackButtons, MessageFeedbackContext } from '../chat/message-feedback-buttons'

/** The capture's live thread, when it has one with messages in it; null otherwise (or until known). */
export function useCaptureLiveChat(captureId: string, recording: boolean): string | null {
  const [conversationId, setConversationId] = useState<{ captureId: string; id: string | null } | null>(null)
  useEffect(() => {
    // Read after the call, never during it: the HUD is where it's talked in then.
    if (recording) return
    let live = true
    void fetch(`/api/account/chat-history/live?capture_id=${encodeURIComponent(captureId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { conversationId?: unknown; messageCount?: unknown } | null) => {
        if (!live) return
        const id = typeof body?.conversationId === 'string' && Number(body.messageCount) > 0 ? body.conversationId : null
        setConversationId({ captureId, id })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [captureId, recording])
  return !recording && conversationId?.captureId === captureId ? conversationId.id : null
}

type LoadState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; messages: UIMessage[] }

const KIND_LABEL: Record<string, string> = { insight: 'Insight', reminder: 'Reminder', suggestion: 'Suggestion' }

export function CaptureLiveChatSection({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    void fetch(`/api/account/chat-history/${encodeURIComponent(conversationId)}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { messages?: unknown }) => {
        if (live) setState({ status: 'ready', messages: Array.isArray(body.messages) ? (body.messages as UIMessage[]) : [] })
      })
      .catch(() => {
        if (live) setState({ status: 'failed' })
      })
    return () => {
      live = false
    }
  }, [conversationId])

  const rows = useMemo(() => (state.status === 'ready' ? liveChatRows(state.messages) : []), [state])
  // The heads-ups that take thumbs: say_to_user rows the chat would rate (canRateMessage).
  const rateable = useMemo(() => {
    if (state.status !== 'ready') return new Set<string>()
    const sayIds = new Set(rows.flatMap((r) => (r.kind === 'say' ? [r.id] : [])))
    return new Set(state.messages.filter((m) => sayIds.has(m.id) && canRateMessage(m, false)).map((m) => m.id))
  }, [state, rows])
  // No heads-ups: no store, so no ratings read and no thumbs drawn.
  const feedback = useMessageFeedback(rateable.size > 0 ? conversationId : null)

  return (
    <MessageFeedbackContext.Provider value={feedback}>
      <div data-capture-live-chat="" className="mx-auto flex w-full max-w-[736px] flex-col gap-2.5 px-8 py-6">
        {state.status === 'loading' && <p className="text-sm text-muted-foreground">Loading the live chat…</p>}
        {state.status === 'failed' && <p className="text-sm text-muted-foreground">Couldn&rsquo;t load the live chat.</p>}
        {state.status === 'ready' && rows.length === 0 && <p className="text-sm text-muted-foreground">Nothing was said in the live chat.</p>}
        {rows.map((row) =>
          row.kind === 'say' && row.text && rateable.has(row.id) ? (
            <RateableNudge key={row.id} row={row} />
          ) : (
            <ReadOnlyRow key={row.id} row={row} />
          ),
        )}
      </div>
    </MessageFeedbackContext.Provider>
  )
}

/** A heads-up with its thumbs beneath it: muted, on hover or focus, kept once rated or while asking why. */
function RateableNudge({ row }: { row: Extract<LiveChatRow, { kind: 'say' }> }) {
  return (
    <div className="group/nudge flex max-w-[85%] flex-col items-start gap-0.5 self-start" data-nudge-row={row.id}>
      <ReadOnlyRow row={row} className="max-w-full self-auto" />
      <MessageActions
        data-nudge-feedback=""
        className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/nudge:opacity-100 has-[[aria-pressed=true]]:opacity-100 has-[[data-feedback-open]]:opacity-100"
      >
        <MessageFeedbackButtons messageId={row.id} nudge />
      </MessageActions>
    </div>
  )
}

function ReadOnlyRow({ row, className }: { row: LiveChatRow; className?: string }) {
  if (row.kind === 'user') {
    return (
      <div className="flex justify-end" data-row-kind="user">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-sm text-primary-foreground [overflow-wrap:anywhere]">
          {row.text}
        </div>
      </div>
    )
  }
  if (row.kind === 'proposals') {
    return (
      <p className="text-xs text-muted-foreground" data-row-kind="proposals">
        {row.proposalIds.length === 1 ? '1 item captured' : `${row.proposalIds.length} items captured`}
      </p>
    )
  }
  if (row.kind === 'question') {
    const asked = row.questions.map((q) => q.question).filter(Boolean).join(' ')
    if (!asked) return null
    return (
      <div className={cn(AGENT_ROW)} data-row-kind="question">
        <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Asked</span>
        {asked}
      </div>
    )
  }
  if (!row.text) return null
  return (
    <div className={cn(AGENT_ROW, 'whitespace-pre-wrap', className)} data-row-kind={row.kind}>
      {row.kind === 'say' && (
        <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {KIND_LABEL[row.nudgeKind] ?? 'Insight'}
        </span>
      )}
      {row.kind === 'reply' ? plainText(row.text) : row.text}
    </div>
  )
}

const AGENT_ROW = 'max-w-[85%] self-start rounded-2xl border border-border/60 bg-muted/30 px-3 py-2 text-sm [overflow-wrap:anywhere]'
