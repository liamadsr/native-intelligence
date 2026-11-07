import { cn } from '@/lib/utils'

/**
 * Shared class string for a sidebar/settings nav row.
 *
 * The active state is a soft rounded pill with a thin inset ring and a small
 * left accent bar (the `before:` pseudo) reading as a "you are here" marker.
 * Inactive rows are quiet and lift gently on hover. This is the single source
 * of truth for the nav-row look across the main dashboard sidebar and the
 * settings shell so the two never drift apart.
 *
 * The row carries the named group `group/navrow`, so descendants (e.g. a
 * keyboard-shortcut badge) can reveal themselves with
 * `group-hover/navrow:*` / `group-focus-visible/navrow:*`.
 */
export function navRowClass(isActive: boolean) {
  return cn(
    'group/navrow relative flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-[13px] transition-all duration-150',
    'before:absolute before:left-0 before:top-1/2 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-sidebar-primary before:transition-all before:duration-200 before:content-[""]',
    isActive
      ? 'bg-sidebar-accent/90 font-medium text-sidebar-foreground shadow-[inset_0_0_0_0.5px_hsl(var(--sidebar-border))] before:h-4'
      : 'font-normal text-sidebar-foreground/60 before:h-0 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground',
  )
}

/** Shared lightweight section-label classes for grouped nav lists. */
export const navSectionLabelClass =
  'px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-sidebar-foreground/35'
