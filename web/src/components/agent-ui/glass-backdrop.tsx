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

/**
 * The app's floating-panel surface (the ⌘K search panel's: `bg-popover`, its
 * foreground and `border-border`), opaque, flat (no sheen), with the glass's
 * own soft lift. For the live agent's HUD panel on web (11-20: "make
 * it match the background color of the search panel, the same dark color, and
 * the same light color on light mode"): the glass sheet showed the page
 * through a blue-grey tint and a sheen, a different dark from every other
 * panel. Its cards keep their glass (header, agent card, composer): on the
 * popover they stand off it as before, a lifted graphite in dark, white with a
 * hairline and shadow in light.
 */
export const POPOVER_SHEET = [
  'border border-border bg-popover text-popover-foreground',
  'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_18px_-6px_rgb(0_0_0/0.14),0_16px_36px_-18px_rgb(0_0_0/0.18)]',
  'dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_6px_14px_-4px_rgb(0_0_0/0.45),0_18px_40px_-12px_rgb(0_0_0/0.8)]',
].join(' ')

/** One background filter for the whole popup (the live agent's HUD); in its own
 * native window (`desktop`) it relies on fill, because WKWebView cannot blur the
 * desktop applications behind its window, and casts no shadow: it fills the
 * window, so a shadow could only show cut off in the window's corners. On the
 * Glass background the desktop frosts the window behind it and the fill
 * becomes the Opacity slider's tint (tailwind.css, `[data-desktop-bubble-card]`).
 * `surface="popover"` (the HUD's panel on web) trades the glass for the app's
 * popover surface (POPOVER_SHEET); the desktop window keeps its glass. */
export function GlassBackdrop({ desktop = false, surface = 'glass' }: { desktop?: boolean; surface?: 'glass' | 'popover' }) {
  return (
    <div
      aria-hidden
      data-bot-bubble-backdrop=""
      data-sheet-surface={surface}
      data-desktop-bubble-card={desktop ? '' : undefined}
      className={cn(
        'pointer-events-auto absolute inset-0 -z-10 rounded-[28px]',
        !desktop && surface === 'popover'
          ? POPOVER_SHEET
          : cn(
              BOT_GLASS,
              desktop
                ? 'bg-white/[0.92] shadow-none backdrop-blur-none backdrop-saturate-100 dark:bg-[rgb(36_36_40/0.96)] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.11)]'
                : 'bg-white/[0.64] dark:bg-[rgb(24_24_28/0.82)]',
            ),
      )}
    />
  )
}
