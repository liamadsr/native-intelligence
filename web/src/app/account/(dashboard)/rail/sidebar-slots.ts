'use client'

/**
 * Where a page's sub-nav goes in Traditional's sidebar (./traditional-sidebar.tsx;
 * docs/plans/traditional-layout.md): the sidebar puts an empty slot under the
 * selected item (Home's Recent, Mail's folders, Team chat's channels and
 * DMs, My Actions' views, a group's member pages) and registers it here by
 * the page's key; the page panel's frame (../page-panel/page-panel-frame.tsx)
 * draws into it instead of floating beside the rail. One sub-nav, two places:
 * the same component, rows and behaviour in both layouts.
 */
import { useSyncExternalStore } from 'react'

const slots = new Map<string, HTMLElement>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** The sidebar's slot for `page` came (an element) or went (null). */
export function setSidebarSlot(page: string, el: HTMLElement | null): void {
  if (el) {
    if (slots.get(page) === el) return
    slots.set(page, el)
  } else {
    if (!slots.has(page)) return
    slots.delete(page)
  }
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The sidebar's slot for `page`, or null while there is none. */
export function useSidebarSlot(page: string): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => slots.get(page) ?? null,
    () => null,
  )
}
