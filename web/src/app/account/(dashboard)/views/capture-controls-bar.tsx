'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The capture's controls, on its own card (one-chat plan, Slice 3): the live
 * agent picker, the Packages chip (`controls`), Transcripts and
 * Tools (`pills`), and Voice ID's speakers (`voiceId`, a row above them). They
 * used to portal into the main chat's composer; the composer is the main
 * agent's now, so they stay with the capture: at the foot of its card, docked
 * beside the chat while it records (chat/live-capture-dock.tsx) and on its
 * page after.
 *
 * Laid out for the docked card's width (about 456px): the controls take what
 * room there is (the agent's name truncates first), the pills keep theirs at
 * the end, and on a card too narrow for both the pills wrap onto a line of
 * their own rather than squeezing the picker to nothing. The pills' cards
 * rise out of them, over the card and the chat (composer-liquid-pill.tsx).
 *
 * Just the frame: the capture page builds every control, with its state.
 */
export function CaptureControlsBar({
  controls,
  pills,
  voiceId,
  className,
}: {
  controls: ReactNode
  pills: ReactNode
  /** Null while Voice ID shows in the live agent's HUD. */
  voiceId: ReactNode
  className?: string
}) {
  return (
    <div data-capture-controls="" className={cn('shrink-0 border-t border-border/50 px-3 pb-2 pt-1.5', className)}>
      {voiceId && (
        <div data-capture-voice-id="" className="pb-1.5 empty:hidden">
          {voiceId}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <div data-capture-controls-row="" className="flex min-w-[10rem] flex-1 items-center gap-1.5">
          {controls}
        </div>
        <div data-capture-pills="" className="ml-auto flex shrink-0 items-center gap-1.5 empty:hidden">
          {pills}
        </div>
      </div>
    </div>
  )
}
