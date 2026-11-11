'use client'

/**
 * The reaction picker: the quick row (QUICK_REACTIONS), then the full emoji
 * picker behind +, in a popover. The main chat's React button
 * (message-reaction-controls.tsx) and team chat's (team-chat-view.tsx) open
 * it; each keeps its own reactions. The host renders the anchor inside it
 * (a PopoverAnchor round its button).
 */
import { useState, type ReactNode } from 'react'
import { SmilePlus } from 'lucide-react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { EmojiPicker } from '@/components/ui/emoji-icon-picker'
import { QUICK_REACTIONS } from '@/lib/chat/message-reactions'
import { cn } from '@/lib/utils'

/** The quick row's emoji button. */
const QUICK_CLASS =
  'flex h-9 w-9 items-center justify-center rounded-full text-[22px] leading-none transition-transform hover:scale-[1.18] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'

export function ReactionPickerPopover({
  open,
  onOpenChange,
  isSelected,
  onPick,
  side = 'top',
  align = 'start',
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** True for an emoji the person already reacted with (pressed in the quick row). */
  isSelected: (emoji: string) => boolean
  onPick: (emoji: string) => void
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  /** The anchor (a PopoverAnchor round the host's button). */
  children: ReactNode
}) {
  const [full, setFull] = useState(false)
  // Closed, it opens on the quick row again.
  if (!open && full) setFull(false)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {children}
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        className={cn('w-auto rounded-full border-border/70 p-1 shadow-lg', full && 'rounded-xl border-none p-0')}
        data-reaction-picker=""
      >
        {full ? (
          <EmojiPicker
            onEmojiSelect={(e: { native: string }) => onPick(e.native)}
            theme="auto"
            previewPosition="none"
            skinTonePosition="search"
            set="native"
            perLine={8}
            maxFrequentRows={2}
            autoFocus
          />
        ) : (
          <div role="group" aria-label="Reactions" className="flex items-center gap-0.5">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React ${emoji}`}
                aria-pressed={isSelected(emoji)}
                data-reaction-option={emoji}
                onClick={() => onPick(emoji)}
                className={cn(QUICK_CLASS, isSelected(emoji) && 'bg-muted')}
              >
                {emoji}
              </button>
            ))}
            <span aria-hidden className="mx-1 h-6 w-px bg-border" />
            <button type="button" aria-label="More reactions" onClick={() => setFull(true)} className={cn(QUICK_CLASS, 'text-muted-foreground')}>
              <SmilePlus className="h-5 w-5" />
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
