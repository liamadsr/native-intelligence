'use client'

/**
 * RunFollowUpChat — talk to a settled work run's PARKED eve session (Loops v3
 * interactive work runs, INTERACTIVE-WORK-RUNS-DESIGN.md §"Follow-up chat"). Shown
 * on terminal runs where `can_chat` (the session parked with its full working
 * context and never completed). The user can ask about what the run did or request
 * adjustments; the agent answers with its tools (drafts, doc edits — never a
 * second finish_work).
 *
 * Transport: POST /api/account/agent-runs/[id]/chat streams the turn back as
 * NDJSON reduced events (W2's run-chat-events vocabulary — text-delta / tool /
 * question / done / error). On mount, GET /chat replays prior follow-up turns so a
 * reloaded page reconstructs the conversation. There is NO chat_messages
 * persistence in v1 — eve's durable stream IS the transcript. The line-reading +
 * event-folding lives in run-chat-stream.ts (pure, unit-tested).
 *
 * Rendering deliberately uses the light Message/MessageContent + shared Markdown
 * primitives (NOT chat-message.tsx's heavy machinery): tool use is a muted
 * "Used <tool>" line, and a `question` event drops an inline QuestionPicker whose
 * answer posts back over the same /chat proxy with `inputResponses`.
 *
 * Mounted in BOTH run surfaces (the Activity drill-in and the standalone
 * /account/agent-runs/[id] page).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Boxes, CircleAlert, User, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
} from '@/components/ui/prompt-input'
import { Message, MessageContent } from '@/components/ui/message'
import { QuestionPicker } from '@/app/account/(dashboard)/chat/question-picker'
import { cn } from '@/lib/utils'
import type { AgentQuestion } from '@/lib/chat/eve/agent-question'
import type { RunChatQuestionPayload } from '@/lib/agent-run/run-chat-events'
import {
  applyEventToTurn,
  reduceError,
  readChatStream,
  type FollowUpTurn,
  type RunChatStreamEvent,
} from './run-chat-stream'

/**
 * The eve `inputResponses` element the /chat POST forwards to `session.send`
 * (W2's route parses `{ requestId, optionId?, text? }`). eve will not release an
 * approval-shaped request without its own optionId, and it DISCARDS text on an
 * approval response — so the answer resolves by requestId + optionId (approve for
 * an answer, deny for a skip, both carried on the reduced `question` event), and
 * the formatted answers ride as the follow-up `message` the model actually reads.
 * Same choreography as the mid-run resume driver (run-work-eve.ts, Trap #2).
 */
interface InputResponse {
  requestId: string
  optionId: string
}

let turnSeq = 0
function nextTurnId(): string {
  turnSeq += 1
  return `t${turnSeq}`
}

/**
 * Finalize the replayed transcript: drop empty turns and mark every
 * already-answered question turn as `answered` so its picker renders INERT.
 *
 * The parked session waits on the user AFTER a question, so a still-pending
 * follow-up question can only ever be the FINAL renderable turn. Any question
 * turn that has a later turn following it was therefore already answered in a
 * prior session — re-arming its picker would POST a stale, already-resolved
 * requestId. So: keep the last turn's question live; force every earlier one
 * inert. Exported for unit testing (pure over the built list).
 */
export function finalizeReplay(built: FollowUpTurn[]): FollowUpTurn[] {
  const kept = built.filter((t) => t.text || t.tools.length > 0 || t.question)
  const lastIndex = kept.length - 1
  return kept.map((t, i) =>
    t.question && i < lastIndex ? { ...t, answered: true } : t,
  )
}

/** True for the assistant turn `id` that never produced any content — the bubble
 *  left stranded on "Thinking…" when a send failed before streaming. */
function isEmptyAssistant(t: FollowUpTurn, id: string): boolean {
  return (
    t.id === id &&
    t.role === 'assistant' &&
    !t.text &&
    t.tools.length === 0 &&
    !t.question
  )
}

/** WorkRunQuestion → AgentQuestion for the picker (structurally identical). */
function toAgentQuestions(payload: RunChatQuestionPayload): AgentQuestion[] {
  return (payload.questions ?? []).map((q) => ({
    question: q.question,
    header: q.header,
    options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    multiSelect: q.multiSelect,
  }))
}

/** Format the picker's answers map into the plain-text follow-up message the
 *  parked model reads (mirrors the server's answer formatter). */
function formatAnswers(payload: RunChatQuestionPayload, answers: Record<string, string>): string {
  const lines = (payload.questions ?? []).map((q) => {
    const label = (q.header?.trim() || q.question.trim() || 'Question').replace(/\s+/g, ' ')
    const value = (answers[q.question] ?? '').trim() || '(no selection)'
    return `- ${label}: ${value}`
  })
  return `Here are my answers:\n${lines.join('\n')}`
}

export interface RunFollowUpChatProps {
  runId: string
  /** Compact spacing for the Activity drill-in (a tighter surface than the page). */
  compact?: boolean
}

export function RunFollowUpChat({ runId, compact }: RunFollowUpChatProps) {
  const [turns, setTurns] = useState<FollowUpTurn[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [replaying, setReplaying] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the newest turn as it grows.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  // Fold one reduced event into the open assistant turn (`assistantId`). An error
  // (including an in-band BUSY on a 200 stream) is surfaced separately and prunes
  // the empty assistant bubble so it never hangs on "Thinking…".
  const dispatchEvent = useCallback((assistantId: string, event: RunChatStreamEvent) => {
    const err = reduceError(event)
    if (err) {
      setError(err)
      setTurns((prev) => prev.filter((t) => !isEmptyAssistant(t, assistantId)))
      return
    }
    setTurns((prev) => prev.map((t) => (t.id === assistantId ? applyEventToTurn(t, event) : t)))
  }, [])

  // On mount, replay prior follow-up turns from GET /chat. The replay is the same
  // reduced NDJSON vocabulary; a text/tool run between question/done boundaries is
  // one assistant turn, and a `user-message` opens the user's own turn (only the
  // replay stream carries it — a live send renders its user turn optimistically).
  useEffect(() => {
    let canceled = false
    ;(async () => {
      setReplaying(true)
      try {
        const res = await fetch(`/api/account/agent-runs/${runId}/chat`, { cache: 'no-store' })
        if (!res.ok || !res.body) {
          setReplaying(false)
          return
        }
        const built: FollowUpTurn[] = []
        let open: FollowUpTurn | null = null
        const openAssistant = (): FollowUpTurn => {
          if (!open) {
            open = { id: nextTurnId(), role: 'assistant', text: '', tools: [] }
            built.push(open)
          }
          return open
        }
        await readChatStream(res.body, (event) => {
          switch (event.type) {
            case 'text-delta':
              if (event.delta) openAssistant().text += event.delta
              return
            case 'tool':
              if (event.name) openAssistant().tools.push(event.name)
              return
            case 'question':
              openAssistant().question = event.question
              open = null // a question closes the turn
              return
            case 'user-message':
              // The user's own reply — a distinct user turn (closes the open
              // assistant turn). Replay is the ONLY place this is honoured.
              open = null
              built.push({ id: nextTurnId(), role: 'user', text: event.text, tools: [] })
              return
            case 'done':
              open = null
              return
            case 'error':
              return
          }
        })
        if (!canceled) {
          setTurns(finalizeReplay(built))
        }
      } catch {
        // Replay is best-effort; a failure just means no prior turns render.
      } finally {
        if (!canceled) setReplaying(false)
      }
    })()
    return () => {
      canceled = true
    }
  }, [runId])

  // Send a message (or a question answer) into the parked session and stream the
  // agent's turn back. `inputResponse` is set only when answering an inline
  // follow-up question (rides the eve requestId).
  const send = useCallback(
    async (message: string, inputResponse?: InputResponse) => {
      const text = message.trim()
      // Not while the replay is loading: it replaces the whole transcript when
      // it lands, which would wipe this turn and the bubble its reply streams into.
      if (!text || streaming || replaying) return
      setError(null)
      setStreaming(true)
      const assistantId = nextTurnId()
      setTurns((prev) => [
        ...prev,
        { id: nextTurnId(), role: 'user', text, tools: [] },
        { id: assistantId, role: 'assistant', text: '', tools: [] },
      ])
      try {
        const res = await fetch(`/api/account/agent-runs/${runId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(
            inputResponse ? { message: text, inputResponses: [inputResponse] } : { message: text },
          ),
        })
        if (!res.ok) {
          const detail = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(detail.error || `Failed (${res.status})`)
        }
        if (!res.body) {
          throw new Error('The agent returned no response.')
        }
        // Live sends already rendered the user turn optimistically, so the
        // echoed `user-message` on the POST stream is ignored (applyEventToTurn
        // no-ops it into the open assistant turn).
        await readChatStream(res.body, (event) => dispatchEvent(assistantId, event))
        // Finalize on EOF: if the stream closed and the assistant turn is still
        // EMPTY (eve parked without producing a reply — e.g. a model-call
        // failure parks the session "for retry"), drop the perpetual Thinking…
        // bubble and say so. The session stays parked, so sending again retries.
        setTurns((prev) => {
          const open = prev.find((t) => t.id === assistantId)
          if (!open || open.text || open.tools.length > 0 || open.question) return prev
          setError('The agent could not respond this time — send again to retry.')
          setInput((cur) => cur || text)
          return prev.filter((t) => t.id !== assistantId)
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to reach the agent')
        // Drop the empty assistant bubble so it doesn't hang on "Thinking…"
        // forever; restore the typed message so a BUSY/error retry isn't lost.
        setTurns((prev) => prev.filter((t) => !isEmptyAssistant(t, assistantId)))
        setInput((cur) => cur || text)
      } finally {
        setStreaming(false)
      }
    },
    [runId, streaming, replaying, dispatchEvent],
  )

  const handleSubmit = useCallback(() => {
    const text = input.trim()
    // The textarea stays enabled while streaming (main-chat behavior); don't
    // clear the draft into a send() that will no-op mid-stream.
    if (!text || streaming || replaying) return
    setInput('')
    void send(text)
  }, [input, streaming, replaying, send])

  // Answer an inline question raised by an assistant turn. Clears the question off
  // that turn (it's been answered) and sends the formatted answers back.
  const answerQuestion = useCallback(
    (turnId: string, payload: RunChatQuestionPayload, answers: Record<string, string>) => {
      const message = formatAnswers(payload, answers)
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, question: undefined } : t)))
      void send(message, { requestId: payload.requestId, optionId: payload.approveOptionId })
    },
    [send],
  )

  const skipQuestion = useCallback(
    (turnId: string, payload: RunChatQuestionPayload) => {
      const message = 'The user skipped this question.'
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, question: undefined } : t)))
      void send(message, { requestId: payload.requestId, optionId: payload.denyOptionId })
    },
    [send],
  )

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        Ask about this run
      </p>

      <div
        ref={scrollRef}
        role="log"
        aria-label="Conversation with the run agent"
        aria-live="polite"
        aria-busy={streaming}
        className={cn(
          'space-y-3 overflow-y-auto rounded-xl border border-border/60 bg-muted/20 p-3',
          compact ? 'max-h-[260px]' : 'max-h-[420px]',
        )}
      >
        {turns.length === 0 ? (
          <p className="py-4 text-center text-[11px] text-muted-foreground">
            {replaying
              ? 'Loading…'
              : 'Ask a question or request a change — the agent still has the full context of this run.'}
          </p>
        ) : (
          turns.map((turn) => (
            <TurnRow
              key={turn.id}
              turn={turn}
              onAnswer={answerQuestion}
              onSkip={skipQuestion}
              disabled={streaming}
            />
          ))
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-1.5 text-[11px] text-destructive"
        >
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {/* Composer — the main chat's PromptInput shell (same container classes as
          chat-input.tsx), stripped to just textarea + send. */}
      <PromptInput
        value={input}
        onValueChange={setInput}
        onSubmit={handleSubmit}
        isLoading={streaming}
        className="rounded-3xl border border-border bg-background shadow-sm"
      >
        <div className="px-1">
          <PromptInputTextarea
            placeholder="Ask about this run…"
            aria-label="Ask about this run"
            className="min-h-0 w-full py-1.5"
            rows={1}
          />
        </div>
        <div className="flex items-center gap-1.5 px-1 pb-0.5">
          <div className="min-w-0 flex-1" />
          <PromptInputActions className="shrink-0">
            <PromptInputAction tooltip="Send message">
              <Button
                variant="default"
                size="icon"
                className="h-8 w-8 rounded-full"
                disabled={streaming || replaying || !input.trim()}
                onClick={handleSubmit}
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </div>
      </PromptInput>
    </div>
  )
}

function TurnRow({
  turn,
  onAnswer,
  onSkip,
  disabled,
}: {
  turn: FollowUpTurn
  onAnswer: (turnId: string, payload: RunChatQuestionPayload, answers: Record<string, string>) => void
  onSkip: (turnId: string, payload: RunChatQuestionPayload) => void
  disabled: boolean
}) {
  const isUser = turn.role === 'user'
  return (
    <Message className={cn('gap-2', isUser && 'flex-row-reverse')}>
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          isUser ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {isUser ? <User className="h-3 w-3" /> : <Boxes className="h-3 w-3" />}
      </span>
      <div className={cn('min-w-0 flex-1 space-y-1.5', isUser && 'flex flex-col items-end')}>
        {/* Tool-use lines — muted "Used <tool>" receipts (assistant only). */}
        {turn.tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {turn.tools.map((name, i) => (
              <span
                key={`${name}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <Wrench className="h-2.5 w-2.5" />
                Used {name}
              </span>
            ))}
          </div>
        )}
        {turn.text ? (
          isUser ? (
            <MessageContent className="max-w-[85%] bg-primary/10 text-xs">{turn.text}</MessageContent>
          ) : (
            <MessageContent
              markdown
              className="max-w-full bg-transparent p-0 text-xs text-foreground/90 prose-sm"
            >
              {turn.text}
            </MessageContent>
          )
        ) : (
          !isUser &&
          turn.tools.length === 0 &&
          !turn.question && <span className="text-[11px] text-muted-foreground">Thinking…</span>
        )}
        {/* An inline clarifying question raised by this assistant turn. A replayed,
            already-answered question renders as an INERT receipt — never a live
            picker (re-submitting would POST a stale, resolved requestId). */}
        {turn.question &&
          (turn.answered ? (
            <AnsweredQuestionReceipt payload={turn.question} />
          ) : (
            <div className="w-full">
              <QuestionPicker
                questions={toAgentQuestions(turn.question)}
                onSubmit={(answers) => onAnswer(turn.id, turn.question!, answers)}
                onSkip={() => onSkip(turn.id, turn.question!)}
                disabled={disabled}
                bare
              />
            </div>
          ))}
      </div>
    </Message>
  )
}

/** An inert receipt for a follow-up question that was already answered in a prior
 *  session — shown on replay in place of a live picker. The user's own answer
 *  replays as the following `user-message` turn, so this just records what was
 *  asked (muted, non-interactive). */
function AnsweredQuestionReceipt({ payload }: { payload: RunChatQuestionPayload }) {
  return (
    <div className="w-full space-y-1 rounded-xl border border-border/50 bg-muted/20 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
        Asked
      </p>
      {(payload.questions ?? []).map((q, i) => (
        <p key={i} className="text-[11px] leading-snug text-muted-foreground">
          {q.header?.trim() || q.question}
        </p>
      ))}
    </div>
  )
}
