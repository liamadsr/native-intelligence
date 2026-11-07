'use client'

/**
 * The thread's day lines and message times (src/lib/chat/message-time.ts).
 *
 * ChatDayLine: a hairline across the reading column, fading out at both ends
 * so it shows in the middle (Liam, 10-18), with its label under it ("Sunday,
 * October 18", "Evening Brief", or both), as a messaging app marks a new day.
 *
 * MessageTimeGutter: a message's time, shown only while the message is
 * hovered, beside it in the gutter outside the reading column (the
 * assistant's on the left, the person's on the right), absolutely placed so
 * nothing moves. The gutter is at least 5% of the chat strip plus the
 * column's own padding (.chat-reading-col, px-5), room enough for "7:32 PM".
 *
 * Both are plain ink on the sky, no pill (Liam, 10-18: a dark pill looked
 * odd): `--sky-ink` (tailwind.css), dark on a light sky and light on a night
 * one, in either theme (src/lib/sky/sky-tone.ts).
 */
import { cn } from '@/lib/utils'
import { timeLabel } from '@/lib/chat/message-time'

export function ChatDayLine({ label }: { label: string }) {
  return (
    <div role="separator" aria-label={label} data-chat-day-line="" className="flex w-full flex-col items-center gap-2 pt-2">
      <div
        aria-hidden
        className="h-px w-full bg-[linear-gradient(to_right,transparent,hsl(var(--sky-ink)/0.28)_30%,hsl(var(--sky-ink)/0.28)_70%,transparent)]"
      />
      <span className="text-[11px] font-medium leading-4 text-[hsl(var(--sky-ink)/0.72)]">{label}</span>
    </div>
  )
}

export function MessageTimeGutter({ time, side }: { time: number; side: 'left' | 'right' }) {
  const { day, time: clock } = timeLabel(time)
  return (
    <time
      dateTime={new Date(time).toISOString()}
      data-message-time=""
      className={cn(
        'pointer-events-none invisible absolute top-2.5 flex select-none flex-col whitespace-nowrap text-[11px] leading-4 text-[hsl(var(--sky-ink)/0.7)] opacity-0 transition-[opacity,visibility] duration-150 group-hover/msg:visible group-hover/msg:opacity-100 motion-reduce:transition-none',
        side === 'left' ? 'right-full mr-2.5 items-end text-right' : 'left-full ml-2.5 items-start text-left',
      )}
    >
      {day && <span>{day}</span>}
      <span>{clock}</span>
    </time>
  )
}
