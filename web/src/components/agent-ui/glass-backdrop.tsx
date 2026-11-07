'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { BOT_GLASS, BOT_GLASS_MUTED } from './glass'

/** Keep the sender inside the reply card, preserving the column's outer edges. */
export function MessageIdentity({ avatar, name }: { avatar: ReactNode; name: string }) {
  return (
    <div aria-hidden className={cn('mb-1.5 flex min-w-0 items-center gap-1.5 text-[11px] font-medium leading-4', BOT_GLASS_MUTED)}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">{avatar}</span>
      <span className="min-w-0 truncate">{name}</span>
    </div>
  )
}

/** One background filter for the whole popup (the live agent's HUD); in its own
 * native window (`desktop`) it relies on fill, because WKWebView cannot blur the
 * desktop applications behind its window, and casts no shadow: it fills the
 * window, so a shadow could only show cut off in the window's corners. On the
 * Glass background the desktop frosts the window behind it and the fill
 * becomes the Opacity slider's tint (tailwind.css, `[data-desktop-bubble-card]`). */
export function GlassBackdrop({ desktop = false }: { desktop?: boolean }) {
  return (
    <div
      aria-hidden
      data-bot-bubble-backdrop=""
      data-desktop-bubble-card={desktop ? '' : undefined}
      className={cn(BOT_GLASS, 'pointer-events-auto absolute inset-0 -z-10 rounded-[28px]',
        desktop
          ? 'bg-white/[0.92] shadow-none backdrop-blur-none backdrop-saturate-100 dark:bg-[rgb(36_36_40/0.96)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.11)]'
          : 'bg-white/[0.64] dark:bg-[rgb(24_24_28/0.82)]',
      )}
    />
  )
}
