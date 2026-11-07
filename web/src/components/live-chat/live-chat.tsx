'use client'

/**
 * LiveChat: the call's live agent's own chat (one-chat plan, Slice 3). During
 * a call the main chat stays the person's main agent; the live agent talks
 * here, in the HUD (the desktop's /hud/agent window, or the web's floating
 * panel: components/live-hud). Self-contained for ONE capture conversation —
 * its data is useLiveChat's (./use-live-chat.ts), never ChatPanel's.
 *
 * It wears the bot bubble's chat (components/bots: the glass, the person's
 * primary bubble, the agent's glass cards, the thinking orb, the glass pill
 * composer), fuller:
 *   - the rolling proposals card as one line at the top ("4 items captured"),
 *     opening into the full card (the main chat's ChatProposalsCard);
 *   - the thread: the person's messages, the agent's replies and its
 *     say_to_user heads-ups (the conversation's rows, plus any heads-up the
 *     host heard as a broadcast that the conversation doesn't hold yet).
 *     Collapsed, only the last two exchanges, at the foot; expanded, all of
 *     it, scrolling;
 *   - the ambient loop's open question (ask_user) above the box: a choice
 *     answers it, and so do words typed while it's open (flagged typed);
 *   - the composer. Expanded while it has focus (or while `expanded` says so,
 *     or the proposals card is open); Escape empties it, then collapses.
 *
 * The box wears the call's glow, which its host hands it (`glow`: the HUD's
 * audio-reactive HudAudioGlow, ./call-glow.tsx, moved here from the main
 * chat), so the call's audio level never re-renders the chat.
 *
 * Cheap for a card that's up all call: nothing of its own runs while nothing
 * changes — the only animation is the thinking orb, while a reply is on its way.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, Square, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Loader } from '@/components/ui/loader'
import { PromptInput, PromptInputActions, PromptInputTextarea } from '@/components/ui/prompt-input'
import { BubbleSendButton, BUBBLE_ROUND } from '@/components/agent-ui/send-button'
import { BOT_GLASS, BOT_GLASS_INSET, BOT_GLASS_MUTED, BOT_USER_BUBBLE } from '@/components/agent-ui/glass'
import { MessageIdentity } from '@/components/agent-ui/glass-backdrop'
import { ChatProposalsCard } from '@/app/account/(dashboard)/chat/chat-proposals-card'
import { QuestionPicker } from '@/app/account/(dashboard)/chat/question-picker'
import { useLiveChat, type LiveChatTarget } from './use-live-chat'
import {
  lastExchanges,
  liveChatRows,
  openQuestion,
  plainText,
  proposalsRow,
  withBroadcastSays,
  type BroadcastSay,
  type LiveChatRow,
  type ThreadRow,
} from './live-chat-model'

/** The most a message may say. */
export const LIVE_CHAT_MAX_CHARS = 2000

/** A heads-up the host heard as a broadcast (the HUD's nudge feed). */
export interface LiveChatNudge {
  id: string
  message: string
  kind?: string
}

/** A heads-up the chat drew, for the host's telemetry (components/live-hud/use-hud-telemetry.ts). */
export interface LiveChatSayShown {
  id: string
  kind: string
  /** Where its row came from: the conversation, or the broadcast (its row not in yet, or never written). */
  source: 'conversation' | 'broadcast'
}

export interface LiveChatProps extends LiveChatTarget {
  /** Runs before each send (the transcript flush), capped by the hook; never blocks the send. */
  beforeSend?: () => Promise<void>
  /** Expanded by the host (a controlled hold); the chat is also expanded while its box has focus. */
  expanded?: boolean
  /** Whether it's expanded, each time that changes (the host makes room). */
  onExpandedChange?: (expanded: boolean) => void
  /** Bumped by the host to collapse it (the web HUD's Escape with focus elsewhere). */
  collapseRequest?: number
  /** Whether a reply is on its way, each time that changes (the host's header says so). */
  onBusyChange?: (busy: boolean) => void
  /** Heads-ups heard as broadcasts: shown as the agent's, unless the conversation holds them already. */
  nudges?: readonly LiveChatNudge[]
  /** Each heads-up the first time it's drawn (stable: the chat is memoized). */
  onSayShown?: (say: LiveChatSayShown) => void
  /** Who it is: the name on its replies and in the box ("Message Sales Coach…"). */
  agentName?: string | null
  /** Its face, beside its name on its replies. */
  agentAvatar?: ReactNode
  /** Worn inside the box (the call's glow: ./call-glow.tsx). The box is `relative isolate`. */
  glow?: ReactNode
  className?: string
}

/**
 * The thread's own look, collapsed (the last exchanges at the foot, the room
 * above them empty) or expanded (scrolling). Shared with the landing page's
 * scripted HUD (components/landing/hud-tips-demo.tsx), so it draws the same.
 */
export function liveChatThreadClass(expanded: boolean): string {
  return cn(
    // Room at its foot (pb-4, given back by -mb-4) for the last card's shadow:
    // the thread clips (its scroll, or its mask and overflow), and a shadow cut
    // at its edge showed as a straight line under the card's round corners (Liam, 10-19).
    'flex min-h-0 flex-1 flex-col gap-2 px-0.5 pb-4 -mb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
    expanded
      ? 'overflow-y-auto overscroll-contain'
      : 'justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent_0,#000_24px)]',
  )
}

/** The bubble's composer: the glass pill (`isolate`: the call's glow keeps its layers inside the box). */
export const LIVE_CHAT_COMPOSER_CLASS = cn(BOT_GLASS, 'pointer-events-auto relative isolate flex shrink-0 items-end gap-1 rounded-[22px] p-[5px] pl-3.5')

/** The composer's box: one line growing to four. */
export const LIVE_CHAT_TEXTAREA_CLASS = 'min-h-0 min-w-0 flex-1 px-0 py-1.5 text-[13px] leading-5'

const KIND_LABEL: Record<string, string> = { insight: 'Insight', reminder: 'Reminder', suggestion: 'Suggestion' }

/**
 * Memoized: the HUD re-renders for Voice ID and who spoke last, and the chat
 * never needs to for those. Its hosts hand it stable props (primitives,
 * memoized callbacks and avatar, the nudge list's own identity).
 */
export const LiveChat = memo(function LiveChat({
  captureId,
  conversationId,
  agentId,
  workspaceId,
  beforeSend,
  expanded,
  onExpandedChange,
  collapseRequest,
  onBusyChange,
  nudges,
  onSayShown,
  agentName,
  agentAvatar,
  glow,
  className,
}: LiveChatProps) {
  const target = useMemo<LiveChatTarget>(
    () => ({ captureId, conversationId, agentId, workspaceId }),
    [captureId, conversationId, agentId, workspaceId],
  )
  const chat = useLiveChat(target, { beforeSend })
  const baseRows = useMemo(() => liveChatRows(chat.messages), [chat.messages])
  const says = useBroadcastSays(nudges, baseRows, !chat.loading)
  const rows = useMemo(() => withBroadcastSays(baseRows, says), [baseRows, says])
  const question = openQuestion(rows)
  const proposals = proposalsRow(rows)
  const busy = chat.status === 'submitted' || chat.status === 'streaming'
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])

  const [focused, setFocused] = useState(false)
  const [cardOpen, setCardOpen] = useState(false)
  const isExpanded = (expanded ?? false) || focused || cardOpen
  const lastReported = useRef<boolean | null>(null)
  useEffect(() => {
    if (lastReported.current === isExpanded) return
    lastReported.current = isExpanded
    onExpandedChange?.(isExpanded)
  }, [isExpanded, onExpandedChange])

  const visible = useMemo(
    () =>
      (isExpanded ? rows : lastExchanges(rows)).filter(
        (r): r is ThreadRow => r.kind === 'user' || r.kind === 'reply' || r.kind === 'say',
      ),
    [rows, isExpanded],
  )
  const lastRow = rows.at(-1) ?? null
  const name = agentName || 'Live agent'

  // Each heads-up the first time it's drawn (collapsed, only the last
  // exchanges are), told to the host once.
  const saysShown = useRef(new Set<string>())
  useEffect(() => {
    if (!onSayShown) return
    for (const row of visible) {
      if (row.kind !== 'say' || saysShown.current.has(row.id)) continue
      saysShown.current.add(row.id)
      const source = baseRows.some((r) => r.id === row.id) ? 'conversation' : 'broadcast'
      onSayShown({ id: row.id, kind: row.nudgeKind, source })
    }
  }, [visible, baseRows, onSayShown])

  // The thread follows the newest words while you're at its foot (always, collapsed).
  const threadRef = useRef<HTMLDivElement>(null)
  const atFoot = useRef(true)
  useLayoutEffect(() => {
    const el = threadRef.current
    if (el && (atFoot.current || !isExpanded)) el.scrollTop = el.scrollHeight
  }, [visible, isExpanded, busy])
  const onScroll = useCallback(() => {
    const el = threadRef.current
    if (el) atFoot.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')
  const send = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    atFoot.current = true
    if (question) {
      chat.answerQuestion(question.toolCallId, { typed: text })
      return
    }
    void chat.send(text).then((sent) => {
      // Didn't go out: give it back if the box is still empty.
      if (!sent) setDraft((cur) => cur || text)
    })
  }, [draft, question, chat])

  const collapse = useCallback(() => {
    setCardOpen(false)
    const active = document.activeElement
    if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur()
    // Held open by the host: ask it to let go (otherwise the change reports itself).
    if (expanded) onExpandedChange?.(false)
  }, [expanded, onExpandedChange])

  const asked = useRef(collapseRequest)
  useEffect(() => {
    if (asked.current === collapseRequest) return
    asked.current = collapseRequest
    collapse()
  }, [collapseRequest, collapse])

  // Presses on the chat's own buttons keep the box's focus (WebKit never
  // focuses a button on click), so the card doesn't collapse under the click.
  const keepFocus = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const t = e.target as Element | null
      if (focused && t?.closest?.('button') && !t.closest('input, textarea')) e.preventDefault()
    },
    [focused],
  )

  return (
    <div
      ref={rootRef}
      className={cn('flex min-h-0 flex-1 flex-col gap-2', className)}
      data-live-chat
      data-expanded={isExpanded ? 'true' : 'false'}
      onMouseDown={keepFocus}
      onKeyDown={(e) => {
        // Escape anywhere in it (the box handles its own first).
        if (e.key !== 'Escape' || e.defaultPrevented || !isExpanded) return
        e.preventDefault()
        e.stopPropagation()
        collapse()
      }}
      onFocus={(e) => {
        if (e.target instanceof HTMLTextAreaElement) setFocused(true)
      }}
      onBlur={(e) => {
        if (e.target instanceof HTMLTextAreaElement) setFocused(false)
      }}
    >
      {proposals && (
        <ProposalsLine count={proposals.proposalIds.length} open={cardOpen} onToggle={() => setCardOpen((v) => !v)}>
          <ChatProposalsCard captureId={proposals.captureId} proposalIds={proposals.proposalIds} />
        </ProposalsLine>
      )}

      <div
        ref={threadRef}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-label={`Chat with ${name}`}
        data-live-thread
        // Expanded, it scrolls: the hosts' drag-anywhere leaves it alone.
        data-scrolls={isExpanded ? '' : undefined}
        className={liveChatThreadClass(isExpanded)}
      >
        {visible.length === 0 && !chat.loading && !busy ? (
          <p className={cn('mt-auto px-1 py-1 text-center text-[12px] leading-snug', BOT_GLASS_MUTED)}>
            Ask {agentName || 'the live agent'} anything about the call.
          </p>
        ) : (
          visible.map((row) => (
            <LiveChatRowView key={row.id} row={row} name={name} avatar={agentAvatar} thinking={busy && row.id === lastRow?.id} />
          ))
        )}
        {busy && (lastRow?.kind === 'user' || !lastRow) && <LiveChatThinkingCard name={name} avatar={agentAvatar} />}
      </div>

      {chat.error && !busy && (
        <p role="alert" className={cn(BOT_GLASS, 'self-start rounded-2xl px-3 py-1.5 text-xs text-destructive')}>
          That didn&rsquo;t reach {agentName || 'the live agent'}. Try again.
        </p>
      )}

      {question && (
        <QuestionCard
          question={question}
          onAnswer={(answers) => chat.answerQuestion(question.toolCallId, { answers })}
          onTyped={(typed) => chat.answerQuestion(question.toolCallId, { typed })}
          onDismiss={() => chat.answerQuestion(question.toolCallId, { dismissed: true })}
        />
      )}

      {/* The bubble's composer: the glass pill, one line growing to four. */}
      <PromptInput
        value={draft}
        onValueChange={setDraft}
        onSubmit={send}
        isLoading={busy}
        maxHeight={96}
        // `isolate`: the call's glow keeps its layers inside the box.
        className={LIVE_CHAT_COMPOSER_CLASS}
      >
        {glow}
        <PromptInputTextarea
          aria-label={`Message ${name}`}
          placeholder={question ? 'Type your answer…' : `Message ${agentName || 'the live agent'}…`}
          maxLength={LIVE_CHAT_MAX_CHARS}
          className={LIVE_CHAT_TEXTAREA_CLASS}
          rows={1}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            // Words in it: cleared. Empty: collapse.
            if (draft) setDraft('')
            else collapse()
          }}
        />
        <PromptInputActions className="shrink-0 gap-1">
          {busy && !draft.trim() ? (
            <button
              type="button"
              aria-label="Stop"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => chat.stop()}
              className={cn(BUBBLE_ROUND, BOT_GLASS_INSET, 'text-foreground hover:bg-black/[0.08] dark:hover:bg-white/[0.12]')}
            >
              <Square className="h-3 w-3 fill-current" />
            </button>
          ) : (
            draft.trim() && <BubbleSendButton onClick={send} />
          )}
        </PromptInputActions>
      </PromptInput>
    </div>
  )
})

/** Where a heads-up goes while the thread's history is still loading: at its foot. */
const AT_FOOT = '\u0000foot'

/**
 * The broadcast heads-ups, each placed after the row it arrived after
 * (remembered the first time it's seen once the history is in; before that,
 * at the foot, since the thread it would be placed in isn't there yet).
 */
function useBroadcastSays(nudges: readonly LiveChatNudge[] | undefined, rows: readonly LiveChatRow[], ready: boolean): BroadcastSay[] {
  const anchors = useRef(new Map<string, string | null>())
  const lastId = rows.at(-1)?.id ?? null
  return useMemo(() => {
    if (!nudges || nudges.length === 0) return []
    return nudges.map((n) => {
      if (ready && !anchors.current.has(n.id)) anchors.current.set(n.id, lastId)
      const after = anchors.current.has(n.id) ? (anchors.current.get(n.id) ?? null) : AT_FOOT
      return { id: n.id, text: n.message, kind: n.kind, after }
    })
    // Anchors are read at first sight only: a later row never moves one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudges, ready])
}

/** The agent's glass card (the bot bubble's reply card). */
const AGENT_CARD = cn(BOT_GLASS, 'pointer-events-auto min-w-0 rounded-[18px] px-3 py-2 text-[13px] leading-5 text-foreground [overflow-wrap:anywhere]')

/** One row of the thread: the person's bubble, a heads-up, or a reply (pure: the landing page's HUD draws it too). */
export function LiveChatRowView({ row, name, avatar, thinking }: { row: ThreadRow; name: string; avatar?: ReactNode; thinking: boolean }) {
  if (row.kind === 'user') {
    return (
      <div className="flex justify-end" data-row-kind="user" data-row-id={row.id}>
        <div className={cn(BOT_USER_BUBBLE, 'whitespace-pre-wrap text-[13px] leading-5 [overflow-wrap:anywhere]')}>{row.text}</div>
      </div>
    )
  }
  if (row.kind === 'say') {
    return (
      <div className={AGENT_CARD} data-row-kind="say" data-row-id={row.id}>
        <MessageIdentity avatar={avatar} name={`${name} · ${KIND_LABEL[row.nudgeKind] ?? 'Insight'}`} />
        {row.text}
      </div>
    )
  }
  if (!row.text) return thinking ? <LiveChatThinkingCard name={name} avatar={avatar} /> : null
  return (
    <div className={cn(AGENT_CARD, 'whitespace-pre-wrap')} data-row-kind="reply" data-row-id={row.id}>
      <MessageIdentity avatar={avatar} name={name} />
      {plainText(row.text)}
    </div>
  )
}

/** A reply on its way: the bubble's thinking orb, the one animation, and only while it lasts. */
export function LiveChatThinkingCard({ name, avatar }: { name: string; avatar?: ReactNode }) {
  return (
    <div className={cn(AGENT_CARD, 'self-start')} aria-label="Thinking" data-live-thinking>
      <MessageIdentity avatar={avatar} name={name} />
      <Loader variant="orb" orbState="working" size="sm" />
    </div>
  )
}

function ProposalsLine({
  count,
  open,
  onToggle,
  children,
}: {
  count: number
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className={cn(BOT_GLASS, 'shrink-0 overflow-hidden rounded-[18px]')} data-live-proposals>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] font-medium text-foreground transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{count === 1 ? '1 item captured' : `${count} items captured`}</span>
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', BOT_GLASS_MUTED, open && 'rotate-180')} aria-hidden />
      </button>
      {/* Mounted only while open: its live row feed runs only then. */}
      {open && <div className="max-h-44 overflow-y-auto overscroll-contain px-1.5 pb-1.5 [scrollbar-width:none]">{children}</div>}
    </div>
  )
}

/**
 * The ambient loop's question. Its own kind (one question, a few short
 * choices) as chips; anything richer in the main chat's picker.
 */
function QuestionCard({
  question,
  onAnswer,
  onTyped,
  onDismiss,
}: {
  question: Extract<LiveChatRow, { kind: 'question' }>
  onAnswer: (answers: Record<string, string>) => void
  onTyped: (typed: string) => void
  onDismiss: () => void
}) {
  const [first] = question.questions
  const simple =
    question.questions.length === 1 && !!first && !first.multiSelect && Array.isArray(first.options) && first.options.length > 0
  return (
    <div data-live-question={question.toolCallId} className={cn(AGENT_CARD, 'relative shrink-0')}>
      <button
        type="button"
        aria-label="Dismiss question"
        onClick={onDismiss}
        className={cn('absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/[0.06] dark:hover:bg-white/[0.1]', BOT_GLASS_MUTED)}
      >
        <X className="h-3 w-3" />
      </button>
      {simple ? (
        <>
          <span className={cn('block text-[10px] font-semibold uppercase tracking-[0.06em]', BOT_GLASS_MUTED)}>
            {first.header || 'Quick question'}
          </span>
          <p className="mb-2 pr-6">{first.question}</p>
          <div className="flex flex-wrap gap-1">
            {first.options.map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => onAnswer({ [first.question]: o.label })}
                className={cn(BOT_GLASS_INSET, 'rounded-full px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-black/[0.08] dark:hover:bg-white/[0.12]')}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <QuestionPicker
          bare
          autoFocus={false}
          questions={question.questions}
          onSubmit={onAnswer}
          onSkip={(response) => (response?.trim() ? onTyped(response) : onDismiss())}
        />
      )}
    </div>
  )
}
