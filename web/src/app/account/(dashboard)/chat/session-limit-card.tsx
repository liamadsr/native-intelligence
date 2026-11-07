'use client'

/**
 * eve's session-limit prompt as a card in the reply: Continue or Stop.
 *
 * At a session's token budget eve holds the turn before its next model call
 * and asks the person whether to keep going (eve 0.79.1
 * harness/hitl/budget-request.js: a `session-limit` input request whose action
 * is `session_limit_continuation`, input `{ kind, limit, usedTokens }`, or
 * `{ kind: 'token-cost', limitUsd, usedCostUsd }`). Until 10-27 the chat drew
 * it as a tool row stuck on "Running…" with nothing to press, and the chat
 * waited for good.
 *
 * Continue grants a fresh budget and the reply carries on; Stop ends it. The
 * main chat no longer has an input budget (agents/chat-agent/agent.ts), so
 * this is the Mac body's caps, and prompts parked before that.
 * The chat panel answers (MessageInteractions.answerSessionLimit); a host
 * that doesn't says what to type instead. Only the prompt still holding the
 * session has buttons (OpenSessionLimitContext, openSessionLimitCallId): an
 * older one's answer may never have reached its saved copy, and pressing it
 * would send the agent a bare "continue". The card flips once eve has the answer, never before: eve holds
 * every other message behind an open prompt.
 */
import { createContext, useContext, useState } from 'react'
import { Gauge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HOME_TURN_ID_PREFIX } from '@/lib/chat/home-turn'
import { EVE_REPLY_ID_PREFIX } from '@/lib/chat/eve-turn-parts'
import { formatTokens } from '../side-panels/context-section'
import { MessageInteractionsContext } from './message-interactions'

/** The tool name eve gives a session-limit prompt's action. */
export const SESSION_LIMIT_TOOL_NAME = 'session_limit_continuation'

export type SessionLimitChoice = 'continue' | 'stop'

/**
 * The one prompt the chat can still answer: its tool call id, or null. The
 * chat panel provides it (openSessionLimitCallId over its messages); only
 * the cards read it, so a change re-renders them, not the thread.
 */
export const OpenSessionLimitContext = createContext<OpenSessionLimit | null>(null)

/** The prompt still holding the session, and whether the chat is answering it itself right now. */
export interface OpenSessionLimit {
  toolCallId: string
  /** The chat's own Continue is on its way (continuesOnItsOwn): no buttons to race it. */
  continuing: boolean
}

type PartLike = { type: string; toolName?: string; toolCallId?: string; state?: string; input?: unknown }

/**
 * Whether a message is a reply from one of the session's own turns: the chat's
 * (EVE_REPLY_ID_PREFIX) or a server-started home turn's (HOME_TURN_ID_PREFIX).
 * Everything else the server writes into the thread (an agent's report, a
 * guest's answer, another person's agent) comes from outside the session.
 */
function isTurnReply(id: string | undefined): boolean {
  return typeof id === 'string' && (id.startsWith(EVE_REPLY_ID_PREFIX) || id.startsWith(HOME_TURN_ID_PREFIX))
}

/**
 * The newest unanswered session-limit prompt that no later turn reply follows.
 * An open prompt holds every turn of the session (eve queues each message
 * behind it), so a reply from a later turn means it was answered, and a
 * prompt before that reply is history. Messages written from outside the
 * session (an agent's report, 10-27: two of them hid the prompt's buttons on
 * PROD) and the person's own queued messages say nothing about it.
 */
export function openSessionLimitCallId(
  messages: ReadonlyArray<{ id?: string; role: string; parts: ReadonlyArray<PartLike> }>,
): string | null {
  return openSessionLimitOf(messages)?.toolCallId ?? null
}

/** The open prompt (openSessionLimitCallId) with the budget it hit, or null. */
export function openSessionLimitOf(
  messages: ReadonlyArray<{ id?: string; role: string; parts: ReadonlyArray<PartLike> }>,
): { toolCallId: string; limit: SessionLimit | null } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]
      const name = p.type === 'dynamic-tool' ? p.toolName : p.type.startsWith('tool-') ? p.type.slice(5) : undefined
      if (name !== SESSION_LIMIT_TOOL_NAME) continue
      return p.state === 'input-available' && p.toolCallId ? { toolCallId: p.toolCallId, limit: sessionLimitFromInput(p.input) } : null
    }
    if (isTurnReply(m.id)) return null
  }
  return null
}

/**
 * Whether the chat answers this prompt itself: eve's lifetime INPUT budget.
 * The main chat has none (agents/chat-agent/agent.ts); a chat created before
 * that keeps eve's 40M default, and Continue is the only right answer, so the
 * person never has to press it (or can't: on a phone, by text). Any other
 * budget is a real guardrail and keeps its card.
 *
 * Only a prompt this tab holds live (the chat panel checks): one drawn from
 * history may already be answered (in another window, by a Stop, or before
 * its saved copy caught up), and answering it by text would hand the agent a
 * bare "continue". It keeps its card for a deliberate press.
 */
export function continuesOnItsOwn(limit: SessionLimit | null): boolean {
  return limit?.kind === 'input'
}

/** What the prompt says it hit, from its action input. */
export type SessionLimit =
  | { kind: 'input' | 'output'; limit: number; used: number }
  | { kind: 'token-cost'; limitUsd: number; usedUsd: number }

export function sessionLimitFromInput(input: unknown): SessionLimit | null {
  if (!input || typeof input !== 'object') return null
  const i = input as Record<string, unknown>
  if (i.kind === 'token-cost') {
    return typeof i.limitUsd === 'number' && typeof i.usedCostUsd === 'number'
      ? { kind: 'token-cost', limitUsd: i.limitUsd, usedUsd: i.usedCostUsd }
      : null
  }
  if ((i.kind === 'input' || i.kind === 'output') && typeof i.limit === 'number' && typeof i.usedTokens === 'number') {
    return { kind: i.kind, limit: i.limit, used: i.usedTokens }
  }
  return null
}

/** "40M input tokens", "150k output tokens", "$5.00 of model spend": the budget it hit. */
export function sessionLimitBudget(limit: SessionLimit): string {
  if (limit.kind === 'token-cost') return `$${limit.limitUsd.toFixed(2)} of model spend`
  return `${formatTokens(limit.limit)} ${limit.kind} tokens`
}

/** The choice an answered prompt's part records: a Stop is answered as a dismissal (`{ response }`). */
export function sessionLimitChoiceOf(output: unknown): SessionLimitChoice {
  return output && typeof output === 'object' && typeof (output as { response?: unknown }).response === 'string' ? 'stop' : 'continue'
}

export function SessionLimitCard({
  toolCallId,
  limit,
  answered,
}: {
  toolCallId: string
  limit: SessionLimit | null
  /** The choice made, once the part has its answer; null while the prompt is open. */
  answered: SessionLimitChoice | null
}) {
  const answer = useContext(MessageInteractionsContext)?.answerSessionLimit
  const openPrompt = useContext(OpenSessionLimitContext)
  const open = openPrompt?.toolCallId === toolCallId
  const continuing = open && openPrompt?.continuing === true
  // The choice on its way to eve: buttons wait until it lands (the part flips)
  // or come back when it didn't.
  const [pending, setPending] = useState<SessionLimitChoice | null>(null)
  const budget = limit ? sessionLimitBudget(limit) : 'its usage budget'

  if (answered || (answer && !open)) {
    return (
      <div data-session-limit={answered ?? 'past'} className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Gauge aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {answered === 'stop' ? `Stopped at ${budget}` : answered === 'continue' ? `Continued past ${budget}` : `Paused at ${budget}`}
        </span>
      </div>
    )
  }

  if (continuing) {
    return (
      <div data-session-limit="continuing" className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Gauge aria-hidden className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">Continuing past {budget}…</span>
      </div>
    )
  }

  const choose = (choice: SessionLimitChoice) => {
    if (!answer || pending) return
    setPending(choice)
    void Promise.resolve(answer(toolCallId, choice)).then((taken) => {
      if (!taken) setPending(null)
    }, () => setPending(null))
  }

  return (
    <div data-session-limit="open" className="w-full max-w-md self-start rounded-xl border border-border/60 bg-background">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Gauge aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-foreground">Paused at {budget}</p>
          <p className="text-[12px] text-muted-foreground">
            {answer
              ? 'This chat reached its usage budget. Continue gives it a fresh one and the reply carries on.'
              : 'This chat reached its usage budget. Send “continue” to give it a fresh one.'}
          </p>
        </div>
      </div>
      {answer && (
        <div className="flex justify-end gap-1 border-t border-border/60 px-2 py-1.5">
          <button
            type="button"
            data-session-limit-action="stop"
            disabled={pending !== null}
            onClick={() => choose('stop')}
            className={cn(BUTTON, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
          >
            {pending === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
          <button
            type="button"
            data-session-limit-action="continue"
            disabled={pending !== null}
            onClick={() => choose('continue')}
            className={cn(BUTTON, 'bg-foreground text-background hover:bg-foreground/90')}
          >
            {pending === 'continue' ? 'Continuing…' : 'Continue'}
          </button>
        </div>
      )}
    </div>
  )
}

const BUTTON =
  'inline-flex items-center rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:transition-none'
