'use client'

/**
 * A bubble's reaction (src/lib/chat/message-reactions.ts): the React button in
 * the reply's toolbar, for the bubble the toolbar is on, which opens the quick
 * row (QUICK_REACTIONS, then the full picker behind +), and the reaction
 * itself, a small badge tucked under that bubble's foot, as a tapback sits on
 * its bubble. One per bubble: picking another replaces it, picking it again
 * or pressing the badge takes it off. The picker is reaction-picker.tsx (team
 * chat opens it too).
 *
 * `data-actions-pinned` keeps the hover row up while the picker is open, as
 * the thumbs' popover does (chat-message.tsx).
 */
import { memo, useContext, useLayoutEffect, useRef, useState } from 'react'
import { SmilePlus } from 'lucide-react'
import type { UIMessage } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { MessageAction } from '@/components/ui/message'
import { PopoverAnchor } from '@/components/ui/popover'
import { useMessageReaction } from '@/hooks/use-message-reactions'
import { MessageInteractionsContext } from './message-interactions'
import { ReactionPickerPopover } from './reaction-picker'

export const ReactButton = memo(function ReactButton({
  message,
  bubble,
  size = 'sm',
}: {
  message: UIMessage
  /** The bubble it reacts to, by its place (message-bubbles.ts). */
  bubble: number
  /** `md`: the main chat's toolbar on the reply's corner (message-toolbar.tsx). */
  size?: 'sm' | 'md'
}) {
  const interactions = useContext(MessageInteractionsContext)
  const reaction = useMessageReaction(interactions?.reactions ?? null, message, bubble)
  const [open, setOpen] = useState(false)
  if (!interactions?.reactions) return null
  const pick = (emoji: string) => {
    setOpen(false)
    interactions.react(message, bubble, reaction?.emoji === emoji ? null : emoji)
  }
  return (
    <ReactionPickerPopover open={open} onOpenChange={setOpen} isSelected={(emoji) => reaction?.emoji === emoji} onPick={pick}>
      <MessageAction tooltip="React">
        <PopoverAnchor asChild>
          <Button
            variant="ghost"
            size="icon"
            className={size === 'md' ? 'h-7 w-7 text-foreground/60 hover:text-foreground' : 'h-6 w-6'}
            aria-label="React"
            aria-haspopup="dialog"
            aria-expanded={open}
            data-message-react=""
            data-actions-pinned={open ? '' : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <SmilePlus className={size === 'md' ? 'h-4 w-4' : 'h-3 w-3'} />
          </Button>
        </PopoverAnchor>
      </MessageAction>
    </ReactionPickerPopover>
  )
})

/**
 * The reaction on a bubble, under its foot: nothing without one. It pops in
 * when the person makes it (not when the thread loads with it); a press
 * takes it off.
 */
export const ReactionBadge = memo(function ReactionBadge({ message, bubble }: { message: UIMessage; bubble: number }) {
  const interactions = useContext(MessageInteractionsContext)
  const reaction = useMessageReaction(interactions?.reactions ?? null, message, bubble)
  const ref = useRef<HTMLButtonElement>(null)
  const shown = useRef<string | null | undefined>(undefined)
  const emoji = reaction?.emoji ?? null
  useLayoutEffect(() => {
    const before = shown.current
    shown.current = emoji
    // Its first render is the thread loading with it: no pop.
    if (before === undefined || !emoji || before === emoji) return
    const el = ref.current
    if (!el || typeof el.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    el.animate(
      [
        { transform: 'scale(0.4)', opacity: 0 },
        { transform: 'scale(1.18)', opacity: 1, offset: 0.55 },
        { transform: 'scale(0.96)', offset: 0.8 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 380, easing: 'ease-out' },
    )
  }, [emoji])
  if (!interactions || !emoji) return null
  return (
    <MessageAction tooltip="Remove reaction">
      <button
        ref={ref}
        type="button"
        aria-label={`Your reaction: ${emoji}. Remove it`}
        data-message-reaction={emoji}
        onClick={() => interactions.react(message, bubble, null)}
        className="relative z-[1] -mt-4 ml-3 flex h-7 min-w-7 items-center justify-center self-start rounded-full border border-border/60 bg-background px-1.5 text-[15px] leading-none shadow-sm shadow-black/[0.06] transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10"
      >
        {emoji}
      </button>
    </MessageAction>
  )
})
