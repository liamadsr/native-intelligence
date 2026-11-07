'use client'

/**
 * The message the person is replying to (src/lib/chat/message-reply.ts),
 * waiting above the main chat's composer for their next message, and the
 * ┐ hook above that message once it's sent (MessageReplyQuote).
 *
 * The chip shows the whole of it (Liam, 10-20: "I want to show the entire
 * thing above the chat and have it animate downwards"), and only it ("It
 * should just be the message by itself"): the message or bubble as the
 * thread drew it (its markdown), or the words picked out of it in quotation
 * marks, scrolling past MESSAGE_REPLY_CHIP_MAX_PX. No header and no ×: a
 * press on the soft thread behind it takes it off, as Esc in the composer
 * does (card-reply-focus.ts, chat-panel.tsx). Flush with the composer, in its
 * glass, as the For you card's chip (card-reply-chip.tsx). It arrives flying down from
 * where Reply was pressed (the bubble itself, or the Reply over the words
 * selected: card-reply-flight.ts), landing before its first paint.
 *
 * In the thread the reply points at the message it answers (Liam, GEN-353;
 * reply-link.ts): a frosted capsule stacked on it at the right, holding a copy
 * of what it answers or the words the person selected, and a compact ┐ beside
 * it pointing down into the reply. Where a whole message isn't drawn (an
 * earlier page), the quote line with its small hook says which. A press on
 * any of it goes back to the message.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { SentenceIcon } from '@/components/attention/sentence-icon'
import { Markdown } from '@/components/ui/markdown'
import { landFlight } from '@/lib/chat/card-reply-flight'
import { messageReplyFlightKey, type MessageReplyRef } from '@/lib/chat/message-reply'
import { CARD_QUOTE_CLASS } from './card-reply-chip'
import { REPLY_LINK_STROKE, ThreadHook } from './thread-hook'
import { jumpToMessage } from './message-interactions'
import { REPLY_HOOK_PX, replyHookPlacement } from './reply-link'

/**
 * The bubble Reply was pressed on, as the thread drew it: its width inside its
 * edge (padding included) and its type, so the chip keeps the bubble's shape,
 * its words wrapping line for line as they do in the thread (Liam, 10-26).
 */
export interface ReplyBubbleShape {
  width: number
  fontSize: string
  lineHeight: string
  /** The person's own message: the chip sits at the right, as the bubble does. */
  own: boolean
}

/** The shape of a thread bubble (`.chat-message-bubble`), or null for anything else (the Reply pill over selected words). */
export function replyBubbleShape(source: HTMLElement | null, own: boolean): ReplyBubbleShape | null {
  if (!source?.classList.contains('chat-message-bubble') || source.clientWidth <= 0) return null
  const style = getComputedStyle(source)
  return { width: source.clientWidth, fontSize: style.fontSize, lineHeight: style.lineHeight, own }
}

/** The composer's placeholder while a message waits. */
export const MESSAGE_REPLY_PLACEHOLDER = 'Reply to message'

/** The chip's words at most this tall (and 40% of the window), scrolling past it, px. What Reply lifts off is as tall at most. */
export const MESSAGE_REPLY_CHIP_MAX_PX = 320

/** The quote's one line: the words picked out in quotation marks, a whole message's opening as it is. */
export function quoteLine(reply: Pick<MessageReplyRef, 'quote' | 'part'>): string {
  const line = reply.quote.replace(/\s+/g, ' ').trim()
  return reply.part ? `“${line}”` : line
}

/** The quote itself: whose message it was, and its words (one line, cut), and what the host adds at its end. */
export function MessageQuote({
  reply,
  label,
  className,
  children,
}: {
  reply: MessageReplyRef
  /** Read before the words by a screen reader ("Replying to", "In reply to"). */
  label: string
  className?: string
  children?: ReactNode
}) {
  const line = quoteLine(reply)
  return (
    <div data-message-quote="" className={cn(CARD_QUOTE_CLASS, className)}>
      <SentenceIcon icon={reply.role === 'assistant' ? 'bot' : 'contact'} size="md" />
      <span className="min-w-0 truncate text-foreground/85" title={reply.quote}>
        <span className="sr-only">
          {label} {reply.role === 'assistant' ? 'the agent' : 'your own message'}:{' '}
        </span>
        {line}
      </span>
      {children}
    </div>
  )
}

export function MessageReplyChip({
  reply,
  body,
  shape = null,
}: {
  reply: MessageReplyRef
  /** The message or bubble as written (its markdown); else its words are the quote's. */
  body?: string | null
  /** The bubble Reply was pressed on: the chip keeps its width and type. None: the composer's width. */
  shape?: ReplyBubbleShape | null
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const key = messageReplyFlightKey(reply)
  // What Reply was pressed on flies down and turns into this (card-reply-flight.ts).
  useLayoutEffect(() => landFlight(key, rootRef.current?.querySelector<HTMLElement>('[data-message-quote]') ?? null), [key, reply.quote])
  return (
    // Flush with the composer's box, as the card's chip (card-reply-chip.tsx).
    // `ph-no-capture`: the words can quote a mail the agent read out.
    <div ref={rootRef} data-message-reply-chip={reply.messageId} className="ph-no-capture relative z-10 mb-2 px-2">
      <div
        data-message-quote=""
        role="note"
        aria-label={reply.part && !body ? 'Replying to these words' : 'Replying to this message'}
        className={cn(
          'rounded-[22px] border border-border/70 bg-background/80 shadow-sm shadow-black/[0.03] backdrop-blur-xl dark:border-white/10',
          // The bubble's own shape: as wide as it was, on its side of the thread.
          shape && 'w-fit max-w-full',
          shape?.own && 'ml-auto',
        )}
      >
        <div
          data-message-reply-body=""
          className={cn('max-w-full overflow-y-auto overscroll-contain px-4 py-2.5 text-foreground/85', !shape && 'text-[15px] leading-6')}
          style={{
            maxHeight: `min(40vh, ${MESSAGE_REPLY_CHIP_MAX_PX}px)`,
            ...(shape ? { width: shape.width, fontSize: shape.fontSize, lineHeight: shape.lineHeight } : null),
          }}
        >
          {body ? (
            <Markdown
              readAloudSections={false}
              // With the bubble's shape, its type is the thread's (`prose`, as the bubble's).
              className={cn(
                'prose max-w-none break-words whitespace-normal text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
                !shape && 'text-[15px] leading-6',
              )}
            >
              {body as string}
            </Markdown>
          ) : (
            <p className="whitespace-pre-line">{reply.part ? `“${reply.quote}”` : reply.quote}</p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The message a sent message replied to, above the person's words in the
 * thread (its metadata: message-reply.ts messageReplyMetadata):
 *
 *   • with a capsule stacked on the reply (ReplyCapsule, its box in
 *     `capsuleRef`: a copy of what it answers, or the words selected): the ┐
 *     beside it (ReplyLinkHook), nothing else in the column;
 *   • without (a whole message not drawn here, or a host without the list):
 *     the one-line quote with its small hook (ThreadHook).
 *
 * No backdrop blur on the quote (as the card's: a blur per quote would redraw
 * on every scroll).
 */
export function MessageReplyQuote({ reply, capsuleRef }: { reply: MessageReplyRef; capsuleRef?: RefObject<HTMLElement | null> }) {
  if (capsuleRef) {
    // `ph-no-capture`: the hook's title quotes the message (it can quote a mail the agent read out).
    return (
      <span data-message-reply-quote={reply.messageId} className="ph-no-capture contents">
        <ReplyLinkHook reply={reply} capsuleRef={capsuleRef} />
      </span>
    )
  }
  return (
    <div data-message-reply-quote={reply.messageId} className="ph-no-capture relative mr-10 flex min-w-0 max-w-[calc(100%-2.5rem)] self-end">
      <button
        type="button"
        onClick={() => jumpToMessage(reply.messageId)}
        aria-label="Go to the message this replied to"
        className="flex min-w-0 rounded-[22px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageQuote reply={reply} label="In reply to" className="w-full transition-colors hover:border-border" />
      </button>
      <ThreadHook shape="down-from-right" />
    </div>
  )
}

type HookPlace = NonNullable<ReturnType<typeof replyHookPlacement>>

/** The press target round the ┐, px (the glyph is 26px; at least 32 to hit). */
const HOOK_TARGET_PX = 32

/**
 * The compact ┐ (REPLY_HOOK_PX, never stretched) in the capsule's right
 * margin, pointing down into the person's bubble without touching it
 * (reply-link.ts replyHookPlacement). Measured, as the capsule's and the
 * bubble's widths are the words', again whenever either or the column
 * changes size. Placed in the reply's column (`relative`). A 32px press
 * target round it goes back to the message: a mouse shortcut, the capsule
 * being the control (its label, its focus).
 */
function ReplyLinkHook({ reply, capsuleRef }: { reply: MessageReplyRef; capsuleRef: RefObject<HTMLElement | null> }) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [place, setPlace] = useState<HookPlace | null>(null)
  useLayoutEffect(() => {
    const button = buttonRef.current
    // The reply's column (`relative`): past the `contents` wrapper. Not offsetParent, which is null while
    // the thread is display:none (a dormant kept page), so the hook would never draw.
    const frame = button?.parentElement?.parentElement ?? null
    const from = capsuleRef.current
    if (!frame || !from) return
    // The reply's bubble, looked up on every measure: a reply whose bubble lands after this mounts
    // (the frame grows, so the observer fires) still gets its hook.
    const bubble = () => frame.querySelector<HTMLElement>('.chat-message-bubble')
    const measure = () => {
      const to = bubble()
      const next = to ? replyHookPlacement(from.getBoundingClientRect(), to.getBoundingClientRect(), frame.getBoundingClientRect()) : null
      setPlace((prev) => (prev && next && prev.left === next.left && prev.top === next.top ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    const to = bubble()
    for (const el of to ? [frame, from, to] : [frame, from]) observer.observe(el)
    return () => observer.disconnect()
  }, [capsuleRef])
  const inset = (HOOK_TARGET_PX - REPLY_HOOK_PX) / 2
  return (
    <button
      ref={buttonRef}
      type="button"
      data-reply-link={place ? 'hook' : ''}
      onClick={() => jumpToMessage(reply.messageId)}
      title={quoteLine(reply)}
      // The capsule is the control (ReplyCapsule): this is the mouse's shortcut only.
      tabIndex={-1}
      aria-hidden
      className={cn('group/hook absolute z-10 rounded-full', !place && 'invisible')}
      style={{
        left: place ? place.left - inset : 0,
        top: place ? place.top - inset : 0,
        width: HOOK_TARGET_PX,
        height: HOOK_TARGET_PX,
      }}
    >
      <span
        aria-hidden
        data-thread-hook="reply-link"
        className={cn(REPLY_LINK_STROKE, 'rounded-tr-[8px] border-r-[3px] border-t-[3px]')}
        style={{ left: inset, top: inset, width: REPLY_HOOK_PX, height: REPLY_HOOK_PX }}
      />
    </button>
  )
}

/**
 * The frosted capsule right above a reply (Liam's reference: "both of them
 * to the far right"): the thing it answers, stacked on the person's words at
 * the right of the thread, wide, set in from the right by 3.5rem so the ┐
 * sits in that margin beside it, pointing down into the reply. Translucent
 * over the sky, its words in a softer ink, so it reads apart from the
 * thread's own bubbles; at the right whoever's message it was.
 *
 *   `body`: a copy of what it answers (reply-link.ts replyCopyFor), its
 *   markdown, all of it (the person's own message: as plain text);
 *   `line`: the words the person selected in it, one line, cut.
 *
 * The whole of it goes back to the message; what's in it (links) doesn't
 * take a press of its own. `capsuleRef` is what the ┐ starts from. Not a
 * `.chat-message-bubble`: Reply, the selection's Reply and the jump's flash
 * never pick it. No backdrop blur (a blur per quote would redraw on every
 * scroll: the card's quote, card-reply-chip.tsx).
 */
export function ReplyCapsule({
  reply,
  body = null,
  capsuleRef,
}: {
  reply: MessageReplyRef
  /** The copy's markdown; none: the words selected (`reply.quote`), one line. */
  body?: string | null
  capsuleRef: RefObject<HTMLDivElement | null>
}) {
  const isUser = reply.role === 'user'
  const go = () => jumpToMessage(reply.messageId)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    go()
  }
  return (
    // `ph-no-capture`: the capsule is the message's words (they can quote a mail the agent read out).
    // Stacked on the reply (`mb-2`), at the right. `pr-14`: the margin the ┐ sits in, beside the capsule's
    // foot and rising along it, 12px inside the reply's right edge (replyHookPlacement).
    <div
      data-message-reply-capsule={reply.messageId}
      data-message-reply-ghost={body ? reply.messageId : undefined}
      className="ph-no-capture mb-2 flex w-full justify-end pr-14"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={body ? 'Copy of the message this replies to; go to it' : 'The words this replies to; go to them'}
        onClick={go}
        onKeyDown={onKeyDown}
        // Wide, as the reference: most of the thread's width.
        className="group/capsule min-w-0 max-w-[88%] cursor-pointer rounded-[22px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div
          ref={capsuleRef}
          inert
          className={cn(
            'rounded-[22px] border border-border/60 bg-background/50 px-4 py-2.5 text-[15px] leading-6 text-foreground/80 shadow-sm shadow-black/[0.03] transition-colors group-hover/capsule:bg-background/70 motion-reduce:transition-none dark:border-white/10',
            body ? 'prose w-fit max-w-none break-words whitespace-normal' : 'w-fit max-w-full truncate',
          )}
        >
          {body ? (
            isUser ? (
              <p className="m-0 whitespace-pre-wrap">{body}</p>
            ) : (
              <Markdown readAloudSections={false} className="text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                {body}
              </Markdown>
            )
          ) : (
            quoteLine(reply)
          )}
        </div>
      </div>
    </div>
  )
}
