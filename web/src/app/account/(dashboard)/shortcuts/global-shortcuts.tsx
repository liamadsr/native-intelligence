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
import { minimizeFrontCards } from '@/components/chat-cards/front-card'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { useIsWorkspaceGuest, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { PAGE_GROUPS, groupOpenSlug } from '../rail/page-groups'
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
      // `?` is Shift+/ on most layouts; matched on the character, either way.
      { key: '?', shift: true, globalGuard: true, handler: () => openShortcutsSheet() },
      { key: '?', globalGuard: true, handler: () => openShortcutsSheet() },
    ],
    [offered],
  )
  useHotkeys(defs)
  return null
}
