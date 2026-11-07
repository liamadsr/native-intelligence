'use client'

/**
 * The round send button the live agent's chat (live-chat.tsx) and the meeting
 * goal composer share, and the round shape beside a box it's drawn in
 * (BUBBLE_ROUND: send, a mic).
 */
import type { ButtonHTMLAttributes } from 'react'
import { ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'

/** A round button beside a box (send, a mic). */
export const BUBBLE_ROUND =
  'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-[background-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 active:scale-95 motion-reduce:active:scale-100'
/** Filled: send. */
const BUBBLE_ROUND_FILLED = cn(BUBBLE_ROUND, 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90')

/** Send: the box keeps its focus through the press. */
export function BubbleSendButton({ className, onMouseDown, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label="Send"
      {...rest}
      className={cn(BUBBLE_ROUND_FILLED, className)}
      onMouseDown={(e) => {
        e.preventDefault()
        onMouseDown?.(e)
      }}
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  )
}
