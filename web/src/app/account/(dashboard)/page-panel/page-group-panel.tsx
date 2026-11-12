'use client'

/**
 * A page group's panel: its sub-nav (Liam, 11-11: "Contacts: Companies,
 * Contacts, Deals · Outreach: Prospecting, Sequences, Campaigns · Calendar:
 * Captures"; "Drive: Docs, Knowledge, … Files · Agents: Agents & Skills,
 * Flows, Evals"; rail/page-groups.ts). PAGE_PANELS.contacts, .outreach,
 * .calendar, .drive and .agents (page-panel.tsx): it holds the slot while its group is the
 * selected place (a member page's own card in front, or a record opened from
 * inside one).
 *
 *   What    one row per member page this workspace has on, in Liam's order,
 *           in the workspace's words, with the member's own icon
 *           (rail/rail-icons.ts GROUP_PAGE_ICONS). Nothing else for now: a
 *           group's own views or item lists come when Liam asks for them.
 *   Look    My Actions' sub-nav's (tasks-panel.tsx): the same floating card
 *           (page-panel-frame.tsx), plain muted glyphs, 32px rows.
 *   A row   opens its member page as the rail opens a page (openTarget
 *           `page`, switching in place), and notes it as the group's last
 *           used member on this device (page-groups.ts rememberGroupPage).
 *   Lit     the member whose own card is in front; under a record opened
 *           from inside one, the member it was opened from (the last used:
 *           noted as each member's card comes in front, rail/selected-place.ts).
 *           The rail's tint, `aria-current`.
 *   One     with one member on, nothing to switch between: no panel at all
 *           (Liam's "hide empty widgets"), the group's icon opens it.
 *   Kept    it wears KEEP_PLACE_ATTR (rail/selected-place.ts): what a press
 *           in it opens keeps the group selected.
 *
 * Flat cost: no read of its own, no timer; the rows come from the edition.
 */
import { useLayoutEffect, useMemo, type ComponentType } from 'react'
import { LayoutList } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { openTarget } from '@/lib/chat-cards/open-card'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { ownPageOfCard, railPagesFor, type OfferedRailPage } from '../rail/rail-pages'
import { PAGE_GROUPS, lastGroupPage, rememberGroupPage, type PageGroupId } from '../rail/page-groups'
import { GROUP_PAGE_ICONS } from '../rail/rail-icons'
import { PagePanelFrame } from './page-panel-frame'
import type { PagePanelProps } from './page-panel-types'

/** The rail's lit tint (rail/app-rail.tsx ITEM_ACTIVE), as tasks-panel.tsx's ROW_LIT. */
const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

/** A rail item as this workspace offers it (its label in the workspace's words, a group's members on here), or null: off here, or none asked. */
export function useRailEntry(id: string | null): OfferedRailPage | null {
  const edition = useWorkspaceEdition()
  const desktop = useIsDesktop()
  const guest = useIsWorkspaceGuest()
  return useMemo(() => (id ? (railPagesFor(pagesFor(edition, { desktop, guest })).find((p) => p.def.id === id) ?? null) : null), [id, edition, desktop, guest])
}

export function PageGroupPanel({ group, active, mode, front, onContent }: PagePanelProps & { group: PageGroupId }) {
  const entry = useRailEntry(group)
  const members = entry?.members ?? []
  // Something to switch between: two members or more. Said in its first
  // commit, before paint (Liam, 11-11: "it goes away completely and
  // reappears every time"), so it is known before its group is ever selected.
  const has = members.length > 1
  useLayoutEffect(() => {
    onContent(group, has)
  }, [group, has, onContent])

  if (!has) return null
  const own = front ? ownPageOfCard(front.spec) : null
  const inFront = own?.id === group ? own.slug : null
  const current = inFront ?? lastGroupPage(group)
  const lit = members.some((m) => m.slug === current) ? current : null
  const label = entry?.label ?? PAGE_GROUPS[group].label

  const press = (slug: string) => {
    // Its own card in front already: nothing more.
    if (slug === inFront) return
    rememberGroupPage(slug)
    openTarget({ type: 'page', slug }, { from: 'rail' })
  }

  return (
    <PagePanelFrame mode={mode} active={active} label={label} page={group}>
      <nav
        aria-label={label}
        data-page-group-panel={group}
        {...{ [KEEP_PLACE_ATTR]: '' }}
        className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
      >
        <ul className="flex flex-col">
          {members.map((page) => {
            const Icon = GROUP_PAGE_ICONS[page.slug] ?? LayoutList
            const on = page.slug === lit
            return (
              <li key={page.slug}>
                <button
                  type="button"
                  data-page-group-row={page.slug}
                  aria-current={on ? 'true' : undefined}
                  onClick={() => press(page.slug)}
                  title={page.label}
                  className={cn(
                    'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
                    on ? ROW_LIT : 'hover:bg-muted/60',
                  )}
                >
                  <span aria-hidden data-page-group-icon="" className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
                    <Icon className="size-4" strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{page.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </PagePanelFrame>
  )
}

function groupPanel(group: PageGroupId): ComponentType<PagePanelProps> {
  function GroupPanel(props: PagePanelProps) {
    return <PageGroupPanel group={group} {...props} />
  }
  GroupPanel.displayName = `PageGroupPanel(${group})`
  return GroupPanel
}

/** Each group's panel, for PAGE_PANELS (page-panel.tsx). */
export const PAGE_GROUP_PANELS: Readonly<Record<PageGroupId, ComponentType<PagePanelProps>>> = {
  contacts: groupPanel('contacts'),
  outreach: groupPanel('outreach'),
  calendar: groupPanel('calendar'),
  drive: groupPanel('drive'),
  agents: groupPanel('agents'),
}
