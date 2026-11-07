'use client'

/**
 * The main chat's actions on an agent reply (Liam, 2026-10-20: "I want to make
 * it so that it looks like this on the top right corner"): a small white bar
 * on a reply bubble's top-right corner, up on hover, as Slack's and Linear's
 * are. React (the quick row: message-reaction-controls.tsx), Reply
 * (message-reply.ts; Liam, 10-20: "make the reply icon visible at the high
 * level"), Copy and ⋯, whose menu holds the quick reactions again, Reply
 * again, Copy message (the words as the thread shows them) and Copy message
 * as Markdown. Read aloud and the thumbs stay in the row under the reply, the
 * whole reply's (chat-message.tsx; Liam: "where they used to be at the
 * bottom left").
 *
 * One bar per reply, on the bubble the pointer is over: a turn draws several
 * bubbles around its tool steps (message-bubbles.ts), and everything here
 * acts on that one (Liam, 10-20: "I should be able to do it on a specific
 * message, not just a full response"). The thread places it (chat-message.tsx
 * placeToolbar, by `data-message-toolbar`) and says which bubble in
 * `data-bubble`, read here as the person reaches for a button (takeBubble),
 * so hovering never renders anything.
 *
 * Hosts without Reply and React (a run chat, a teammate chat, the capture's
 * call chat) have no bar: their row under the reply keeps Copy.
 *
 * Its own surface, so it never takes the sky's ink (data-on-sky). Absolute
 * in the reply's column; hidden, it takes no pointer, so the message above it
 * stays clickable. It stays up while its menu or its picker is open
 * (`data-actions-pinned`).
 */
import { memo, useContext, useRef, useState } from 'react'
import { Check, Copy, MoreHorizontal, Reply } from 'lucide-react'
import type { UIMessage } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { MessageAction } from '@/components/ui/message'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { copyTextToClipboard } from '@/lib/clipboard'
import { stripSuggestionMarkers } from '@/components/suggestions/remark-suggestion-markers'
import { useMessageReaction } from '@/hooks/use-message-reactions'
import { QUICK_REACTIONS } from '@/lib/chat/message-reactions'
import { cn } from '@/lib/utils'
import { MessageInteractionsContext } from './message-interactions'
import { ReactButton } from './message-reaction-controls'

/** How far the bar rises over the bubble's top edge, and sits in from its right edge (px). */
export const TOOLBAR_RISE_PX = 30
export const TOOLBAR_INSET_PX = 12

/** Up on hover (or focus, or pinned), once placed; hidden, it takes no pointer. */
const TOOLBAR_CLASS = cn(
  // Unseen until the thread has placed it (chat-message.tsx placeToolbar sets data-placed).
  'invisible absolute -top-[30px] right-0 z-20 flex items-center gap-0.5 rounded-xl border border-border/70 bg-background p-1 data-[placed]:visible',
  'shadow-[0_1px_2px_rgb(0_0_0/0.06),0_6px_16px_-6px_rgb(0_0_0/0.18)] dark:border-white/10',
  'pointer-events-none opacity-0 transition-opacity duration-150 motion-reduce:transition-none',
  'group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100',
  'data-[actions-pinned]:pointer-events-auto data-[actions-pinned]:opacity-100',
  'has-[[data-actions-pinned]]:pointer-events-auto has-[[data-actions-pinned]]:opacity-100',
)
const BUTTON_CLASS = 'h-7 w-7 text-foreground/60 hover:text-foreground'
const ICON_CLASS = 'h-4 w-4'

export const MessageToolbar = memo(function MessageToolbar({
  message,
  bubbles,
  onReply,
}: {
  message: UIMessage
  /** The bubbles the reply draws, their words as written (message-bubbles.ts). */
  bubbles: readonly string[]
  /** Reply to one bubble, by its place. */
  onReply: (bubble: number) => void
}) {
  const interactions = useContext(MessageInteractionsContext)
  const barRef = useRef<HTMLDivElement>(null)
  // The bubble the bar is on (the thread's data-bubble), read as a button is reached for.
  const [bubble, setBubble] = useState(0)
  const placedOn = () => {
    const n = Number(barRef.current?.dataset.bubble ?? 0)
    return Number.isInteger(n) && n >= 0 && n < bubbles.length ? n : 0
  }
  const takeBubble = () => {
    const n = placedOn()
    if (n !== bubble) setBubble(n)
  }
  const reaction = useMessageReaction(interactions?.reactions ?? null, message, bubble)
  const [copied, setCopied] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Reply picked in the menu: it runs once the menu has closed (the menu holds focus while open, and the
  // composer takes it for the chip), and focus never goes back to ⋯ (its tooltip would stay up).
  const replyOnClose = useRef(false)

  // The bubble's words as written (suggestion markers out): what Copy copies.
  const markdownOf = (n: number) => stripSuggestionMarkers(bubbles[n] ?? '')
  // The bubble's words as the thread shows them, else as written.
  const shownText = (n: number) =>
    barRef.current?.parentElement?.querySelectorAll<HTMLElement>('.chat-message-bubble')[n]?.innerText.trim() || markdownOf(n)
  const copy = (text: string) => {
    copyTextToClipboard(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!interactions) return null
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Message actions"
      data-message-toolbar=""
      data-actions-pinned={menuOpen ? '' : undefined}
      className={TOOLBAR_CLASS}
      // Before any button acts: the bubble it acts on.
      onPointerDownCapture={takeBubble}
      onKeyDownCapture={takeBubble}
    >
      <ReactButton message={message} bubble={bubble} size="md" />
      <MessageAction tooltip="Reply">
        <Button variant="ghost" size="icon" className={BUTTON_CLASS} aria-label="Reply" data-message-reply="" onClick={() => onReply(placedOn())}>
          <Reply className={ICON_CLASS} />
        </Button>
      </MessageAction>
      <MessageAction tooltip={copied ? 'Copied!' : 'Copy'}>
        <Button variant="ghost" size="icon" className={BUTTON_CLASS} aria-label="Copy" data-message-copy="" onClick={() => copy(markdownOf(placedOn()))}>
          {copied ? <Check className={ICON_CLASS} /> : <Copy className={ICON_CLASS} />}
        </Button>
      </MessageAction>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <MessageAction tooltip="More">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className={BUTTON_CLASS} aria-label="More actions" data-message-more="">
              <MoreHorizontal className={ICON_CLASS} />
            </Button>
          </DropdownMenuTrigger>
        </MessageAction>
        <DropdownMenuContent
          align="end"
          sideOffset={6}
          className="w-64"
          data-message-menu=""
          onCloseAutoFocus={(e) => {
            if (!replyOnClose.current) return
            replyOnClose.current = false
            e.preventDefault()
            onReply(bubble)
          }}
        >
          {interactions.reactions && (
            <div role="group" aria-label="Reactions" className="flex items-center justify-between px-0.5 pb-1">
              {QUICK_REACTIONS.map((emoji) => (
                <DropdownMenuItem
                  key={emoji}
                  aria-label={`React ${emoji}`}
                  data-menu-reaction={emoji}
                  onSelect={() => interactions.react(message, bubble, reaction?.emoji === emoji ? null : emoji)}
                  className={cn('h-9 w-9 justify-center rounded-full p-0 text-[20px] leading-none', reaction?.emoji === emoji && 'bg-muted')}
                >
                  {emoji}
                </DropdownMenuItem>
              ))}
            </div>
          )}
          <DropdownMenuItem
            onSelect={() => {
              replyOnClose.current = true
            }}
            data-menu-reply=""
            className="gap-2.5 py-2 text-[14px]"
          >
            <Reply className={ICON_CLASS} />
            Reply
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => copy(shownText(bubble))} data-menu-copy="" className="gap-2.5 py-2 text-[14px]">
            <Copy className={ICON_CLASS} />
            Copy message
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(markdownOf(bubble))} data-menu-copy-markdown="" className="gap-2.5 py-2 text-[14px]">
            <Copy className={cn(ICON_CLASS, 'opacity-0')} aria-hidden />
            Copy message as Markdown
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
