'use client'

/** Small pieces the Local page's views share: the menu item's look and the neutral banner. */
import { cn } from '@/lib/utils'

/** A row in a "…" menu (the Site audit's menu items). */
export const MENU_ITEM =
  'flex w-full items-center gap-1.5 rounded-2xl px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent'

/** The neutral banner: a refusal that is not an error (the spend limit, lookups off), or a quiet note. */
export function NoticeBanner({ text, className }: { text: string; className?: string }) {
  return (
    <p data-seo-banner="notice" className={cn('rounded-md border border-border bg-muted/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground', className)}>
      {text}
    </p>
  )
}
