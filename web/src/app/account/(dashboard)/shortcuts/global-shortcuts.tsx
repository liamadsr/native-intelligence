'use client'

/**
 * The app-wide shortcuts the registry adds (lib/shortcuts.ts): G then a
 * letter opens a page, `?` the shortcuts sheet. Mounted once, in the
 * dashboard shell.
 *
 * A page opens exactly as the app rail opens it (rail/app-rail.tsx): full
 * screen in the main chat (openTarget `page`, from 'shortcut'), the same card
 * brought back when it was open already; a rail group (SEO) on its member
 * last used on this device; Home puts away whatever is in front. Only pages
 * this workspace offers, as the rail offers them (pagesFor): a letter for a
 * page that is off here says so instead.
 *
 * Never while typing (useHotkeys skips text fields and the chat composer),
 * nor while a dialog, menu, popover or the palette has the keyboard
 * (`globalGuard`).
 */
import { useMemo } from 'react'
import { toast } from 'sonner'
import { useHotkeys, type HotkeyDefinition } from '@/lib/hotkeys'
import { GO_TO, GO_TO_PREFIX, type GoToDef } from '@/lib/shortcuts'
import { pagesFor, type OfferedPage } from '@/lib/chat-cards/page-menu'
import { openTarget } from '@/lib/chat-cards/open-card'
import { frontCard, minimizeFrontCards } from '@/components/chat-cards/front-card'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { PAGE_GROUPS, groupOpenSlug, isPageGroupId, rememberGroupPage } from '../rail/page-groups'
import { ownPageOfCard, railPagesFor } from '../rail/rail-pages'
import { openShortcutsSheet } from './open-shortcuts-sheet'

/** Open a go-to's place, as the rail would. False when this workspace doesn't offer it. */
export function openGoTo(def: GoToDef, offered: readonly OfferedPage[]): boolean {
  const target = def.target
  if (target.type === 'home') {
    minimizeFrontCards()
    return true
  }
  const slugs = new Set(offered.map((p) => p.slug))
  if (target.type === 'group') {
    const members = PAGE_GROUPS[target.id].members.filter((s) => slugs.has(s))
    const slug = groupOpenSlug(target.id, members)
    if (!slug) return false
    openTarget({ type: 'page', slug }, { from: 'shortcut' })
    return true
  }
  if (!slugs.has(target.slug)) return false
  openTarget({ type: 'page', slug: target.slug }, { from: 'shortcut' })
  return true
}

/**
 * The page `step` along from the group page in front (`[` and `]`: its
 * sub-nav's order, round from the last to the first), or null: no group's
 * page in front, or nothing else in its group here.
 */
export function steppedGroupPage(offered: readonly OfferedPage[], step: number): string | null {
  const front = frontCard()
  const own = front ? ownPageOfCard(front.spec) : null
  if (!own || !isPageGroupId(own.id)) return null
  const members = railPagesFor(offered).find((p) => p.def.id === own.id)?.members ?? []
  if (members.length < 2) return null
  const at = members.findIndex((m) => m.slug === own.slug)
  if (at < 0) return null
  return members[(at + step + members.length) % members.length].slug
}

export function GlobalShortcuts() {
  const edition = useWorkspaceEdition()
  const desktop = useIsDesktop()
  const guest = useIsWorkspaceGuest()
  // The rail's own list (app-rail.tsx), so a letter opens what the rail does.
  const offered = useMemo(() => pagesFor(edition, { desktop, guest }), [edition, desktop, guest])

  const defs = useMemo<HotkeyDefinition[]>(
    () => [
      ...GO_TO.map(
        (g): HotkeyDefinition => ({
          key: g.letter,
          after: GO_TO_PREFIX,
          globalGuard: true,
          handler: () => {
            if (!openGoTo(g, offered)) toast(`${g.label} isn’t on in this workspace`)
          },
        }),
      ),
      // `[` and `]`: the previous and next page in the group in front (its
      // sub-nav, as page-group-panel.tsx opens them). Left alone elsewhere.
      ...([['[', -1], [']', 1]] as const).map(
        ([key, step]): HotkeyDefinition => ({
          key,
          globalGuard: true,
          when: () => steppedGroupPage(offered, step) !== null,
          handler: () => {
            const slug = steppedGroupPage(offered, step)
            if (!slug) return
            rememberGroupPage(slug)
            openTarget({ type: 'page', slug }, { from: 'shortcut' })
          },
        }),
      ),
      // `?` is Shift+/ on most layouts; matched on the character, either way.
      { key: '?', shift: true, globalGuard: true, handler: () => openShortcutsSheet() },
      { key: '?', globalGuard: true, handler: () => openShortcutsSheet() },
    ],
    [offered],
  )
  useHotkeys(defs)
  return null
}
