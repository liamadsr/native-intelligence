'use client'

/**
 * Thumbs up and down beside Copy and Read aloud on a finished reply (the evals
 * flywheel, docs/plans/always-on-agent.md §8: a thumbs-down becomes a
 * candidate test case; a thumbs-up a "keep doing this" one).
 *
 * ChatPanel provides the conversation's store (MessageFeedbackContext); a host
 * that doesn't shows no thumbs, and a chat of its own that can render inside
 * the main chat (RunChat, TeammateChat) clears it for its messages.
 * Clicking the active thumb clears it. A thumbs-down saves at once and opens
 * "What went wrong?" for an optional reason: Send adds it, Skip (or closing
 * the popover) keeps the rating without one.
 *
 * `data-feedback-open` keeps the actions row pinned while the popover is
 * open, as Read aloud pins it while speaking (chat-message.tsx).
 *
 * A live nudge (`nudge`: the capture page's call chat, rated after the call)
 * also offers quick reason chips in that popover (NUDGE_REASON_LABELS: Not
 * useful · Repeated · Wrong · Too late), sent as `nudge_reason` beside the
 * optional words. Chat replies keep the words box alone.
 */

import { createContext, memo, useContext, useState } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import type { UIMessage } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { MessageAction } from '@/components/ui/message'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { HOME_TURN_KIND } from '@/lib/chat/home-turn'
import { cn } from '@/lib/utils'
import { NUDGE_REASONS, NUDGE_REASON_LABELS, type NudgeReason } from '@/lib/evals/flywheel/types'
import {
  FEEDBACK_REASON_MAX,
  useMessageRating,
  type MessageFeedbackStore,
} from '@/hooks/use-message-feedback'

export const MessageFeedbackContext = createContext<MessageFeedbackStore | null>(null)

/**
 * The `metadata.kind`s of replies the agent wrote itself with nobody typing:
 * a server-written home turn (src/lib/chat/home-turn.ts) and the live agent's
 * say_to_user nudge (src/lib/live-agent/tools.ts). Every other kind is a
 * notice row Native Intelligence templated into the thread: a teammate's report, a job's
 * notice (src/lib/work/notify.ts), an approval's outcome, the live greeting,
 * the packages ack. The feedback route builds these turns' evidence the same
 * way (src/lib/evals/flywheel/chat-evidence.ts SERVER_STARTED_KINDS).
 */
const AGENT_REPLY_KINDS: ReadonlySet<string> = new Set([HOME_TURN_KIND, 'say_to_user'])

/**
 * Whether a message takes thumbs: a reply of the agent's own that has settled
 * (not streaming) and has text. Not the person's messages, and not a notice
 * row (a `metadata.kind` outside AGENT_REPLY_KINDS).
 */
export function canRateMessage(message: UIMessage, streaming: boolean): boolean {
  if (message.role !== 'assistant' || streaming) return false
  const kind = (message.metadata as { kind?: unknown } | null | undefined)?.kind
  if (typeof kind === 'string' && kind && !AGENT_REPLY_KINDS.has(kind)) return false
  return message.parts.some((p) => p.type === 'text' && p.text.trim().length > 0)
}

export const MessageFeedbackButtons = memo(function MessageFeedbackButtons({ messageId, nudge = false }: { messageId: string; nudge?: boolean }) {
  const store = useContext(MessageFeedbackContext)
  if (!store) return null
  return <Thumbs store={store} messageId={messageId} nudge={nudge} />
})

function Thumbs({ store, messageId, nudge }: { store: MessageFeedbackStore; messageId: string; nudge: boolean }) {
  const rating = useMessageRating(store, messageId)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [chip, setChip] = useState<NudgeReason | null>(null)
  const good = nudge ? 'Good heads-up' : 'Good reply'
  const bad = nudge ? 'Bad heads-up' : 'Bad reply'

  const rateUp = () => {
    setAsking(false)
    void store.rate(messageId, rating === 'up' ? null : 'up')
  }
  const rateDown = () => {
    if (rating === 'down') {
      setAsking(false)
      void store.rate(messageId, null)
      return
    }
    setReason('')
    setChip(null)
    setAsking(true)
    void store.rate(messageId, 'down')
  }
  const send = () => {
    const text = reason.trim()
    setAsking(false)
    if (text || chip) void store.rate(messageId, 'down', text || undefined, chip ?? undefined)
  }

  return (
    <>
      <MessageAction tooltip={rating === 'up' ? 'Remove rating' : good}>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={good}
          aria-pressed={rating === 'up'}
          data-message-feedback="up"
          onClick={rateUp}
        >
          <ThumbsUp className={rating === 'up' ? 'h-3 w-3 fill-current' : 'h-3 w-3'} />
        </Button>
      </MessageAction>
      <Popover open={asking} onOpenChange={setAsking}>
        <MessageAction tooltip={rating === 'down' ? 'Remove rating' : bad}>
          <PopoverAnchor asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={bad}
              aria-pressed={rating === 'down'}
              data-message-feedback="down"
              data-feedback-open={asking ? '' : undefined}
              onClick={rateDown}
            >
              <ThumbsDown className={rating === 'down' ? 'h-3 w-3 fill-current' : 'h-3 w-3'} />
            </Button>
          </PopoverAnchor>
        </MessageAction>
        <PopoverContent side="bottom" align="start" className="w-72 p-3" data-message-feedback-reason="">
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <label htmlFor={`feedback-reason-${messageId}`} className="text-xs font-medium text-foreground">
              What went wrong?
            </label>
            {nudge && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick reason" data-nudge-reasons="">
                {NUDGE_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={chip === r}
                    data-nudge-reason={r}
                    onClick={() => setChip((c) => (c === r ? null : r))}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      chip === r ? 'border-foreground/40 bg-foreground/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {NUDGE_REASON_LABELS[r]}
                  </button>
                ))}
              </div>
            )}
            <Textarea
              id={`feedback-reason-${messageId}`}
              value={reason}
              maxLength={FEEDBACK_REASON_MAX}
              rows={3}
              placeholder="Optional"
              className="min-h-[64px] resize-none text-sm"
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={() => setAsking(false)}>
                Skip
              </Button>
              <Button type="submit" size="sm" className="h-7 px-2.5 text-xs" disabled={!reason.trim() && !chip}>
                Send
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>
    </>
  )
}
