'use client'

/**
 * The navigation both shells draw (docs/plans/traditional-layout.md): the
 * pages this workspace offers, in the person's order and with their pins
 * (./rail-pages.ts railLayout), split into the rail's groups, the item lit
 * for the selected place, and how an item opens. The app rail (./app-rail.tsx)
 * and Traditional's sidebar (./traditional-sidebar.tsx) both read it, so the
 * two always list the same pages and open them the same way.
 */
import { useMemo } from 'react'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { openTarget } from '@/lib/chat-cards/open-card'
import { useRailPrefs } from '@/lib/rail-prefs-store'
import type { RailPrefs } from '@/lib/rail-prefs'
import { activeRailItem, railLayout, railPagesFor, type OfferedRailPage, type RailLayout, type RailPageId } from './rail-pages'
import { groupOpenSlug, isPageGroupId } from './page-groups'
import { useSelectedPlace } from './selected-place'

export interface RailNavGroup {
  /** The rail group (`work`, `customers`, `agents`), or `custom` for the person's own order (one list). */
  group: string
  pages: OfferedRailPage[]
}

export interface RailNav {
  /** Every rail page this workspace offers, in the rail's order. */
  pages: OfferedRailPage[]
  offeredIds: RailPageId[]
  prefs: RailPrefs | null
  layout: RailLayout
  /** The pinned pages, in their groups while the order is the default; one `custom` list otherwise. */
  groups: RailNavGroup[]
  /** The item lit: `home`, a page, or null. */
  active: RailPageId | 'home' | null
}

/** The pinned pages in their groups (a section with none draws nothing); the person's own order is one list. */
export function railNavGroups(layout: RailLayout): RailNavGroup[] {
  if (layout.custom) return layout.shown.length ? [{ group: 'custom', pages: layout.shown }] : []
  const out: RailNavGroup[] = []
  for (const p of layout.shown) {
    const last = out[out.length - 1]
    if (last && last.group === p.def.group) last.pages.push(p)
    else out.push({ group: p.def.group, pages: [p] })
  }
  return out
}

export function useRailNav(): RailNav {
  const desktop = useIsDesktop()
  const edition = useWorkspaceEdition()
  // A guest of the workspace: no members-only page (the Studio refuses a guest).
  const guest = useIsWorkspaceGuest()
  // Calendar and Mail always: the main chat opens the person's own pages
  // whatever drives it (chat-panel.tsx openCardHere), as a chip or a notice
  // does; only `/` leaves them out where its chat may not read them.
  const pages = useMemo(() => railPagesFor(pagesFor(edition, { desktop, guest })), [edition, desktop, guest])
  const offeredIds = useMemo(() => pages.map((p) => p.def.id), [pages])
  const active = activeRailItem(useSelectedPlace(), pages)
  const prefs = useRailPrefs()
  const layout = useMemo(() => railLayout(pages, prefs), [pages, prefs])
  const groups = useMemo(() => railNavGroups(layout), [layout])
  return { pages, offeredIds, prefs, layout, groups, active }
}

/**
 * Open a rail item as the rail does: a page as `/` opens it (openTarget
 * `page`); a group on its member last used on this device, else its default
 * (Liam, 11-11: page groups).
 */
export function openRailEntry(entry: OfferedRailPage): void {
  const { def, page, members } = entry
  const slug = members && isPageGroupId(def.id) ? (groupOpenSlug(def.id, members.map((m) => m.slug)) ?? page.slug) : page.slug
  openTarget({ type: 'page', slug }, { from: 'rail' })
}
