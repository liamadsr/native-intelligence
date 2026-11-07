'use client'

/**
 * The far-left platform mark on an action row, wired to the compose menu.
 *
 * The list row and the board card need exactly the same thing, and the
 * non-obvious part is worth stating once rather than twice:
 *
 * THE ICON AND THE MENU READ DIFFERENT COPIES OF THE SAME FACT, on purpose.
 *
 *  - The ICON draws from `external_links` on the row payload — one embedded
 *    join in the view query (ACTION_VIEW_SELECT), so 500 rows cost zero extra
 *    requests. It carries `provider` and nothing else, which is exactly what an
 *    icon needs and nowhere near enough to open or unlink anything.
 *  - The MENU is UNCONTROLLED and COMPACT, so it fetches the FULL link rows
 *    (ids, urls, titles) on its first open and only then. That is the same
 *    deferral the capture rows have always used, for the same reason: a view
 *    can mount hundreds of these.
 *
 * Handing the icon's thin rows to the menu as if they were link rows is the
 * tempting shortcut and the wrong one — it would render "Open in Jira" against
 * a row with no url and an Unlink against a row with no id.
 *
 * After a push or an unlink the row payload is republished on the entity bus,
 * because `external_links` is a JOIN rather than a column and no realtime
 * channel will ever announce it.
 *
 * The surfaces underneath both have gestures of their own (open the detail
 * panel; begin a drag), and the icon stops both — see ActionPlatformIcon.
 *
 * COMPOSE DOES NOT LIVE HERE. This cell is one 30px slot at the left edge of a
 * row; the compose strip needs the row's whole width. So the cell forwards the
 * menu's compose node up to whoever mounted it (`onCompose`) and draws nothing
 * itself — the list row swaps its property chips for it, the board card has no
 * room and routes to the detail panel instead.
 */

import type { ReactNode } from 'react'
import { ActionPlatformIcon, type PlatformLink } from './action-platform-icon'
import { PushToTrackerMenu } from './push-to-tracker-menu'

export function ActionPlatformCell({
  item,
  size = 'sm',
  onCompose,
  onComposeStart,
}: {
  /** The view row. Reads `id`, `title` and `external_links` and nothing else. */
  item: Record<string, unknown>
  size?: 'sm' | 'md'
  /**
   * Place the compose form. Called with the form while compose mode is on, and
   * never otherwise. Omit on a surface that cannot host one — the board card —
   * and pair it with `onComposeStart` to route the gesture elsewhere.
   */
  onCompose?: (node: ReactNode, state: { provider: string; providerName: string }) => ReactNode
  /**
   * Compose mode began or ended for this row. The board card's hook: it has no
   * room for a strip, so it opens the detail panel with the provider pre-armed.
   */
  onComposeStart?: (provider: string | null) => void
}) {
  const actionId = item.id as string
  const links = (item.external_links as PlatformLink[] | undefined) ?? []

  // No onPushed/onUnlinked republish here any more. The menu emits the
  // entity-bus event itself, from the one place that holds the full
  // post-mutation link set — which also covers the detail-panel toolbar and the
  // capture proposal card, neither of which can supply such a callback. Keeping
  // a second emitter here would be worse than redundant: it derives from the
  // possibly-stale ROW PAYLOAD and, firing after the menu's, could overwrite a
  // correct array with one missing providers the payload never carried.
  return (
    <PushToTrackerMenu
      // Compact = defer the link fetch to first open. Uncontrolled = the menu
      // owns the full rows it needs to Open and Unlink with.
      compact
      actionId={actionId}
      actionTitle={(item.title as string) ?? null}
      {...(onCompose ? { renderCompose: onCompose } : {})}
      {...(onComposeStart
        ? { onComposeChange: (d: { provider: string } | null) => onComposeStart(d?.provider ?? null) }
        : {})}
      renderTrigger={({ links: menuLinks, linksKnown, busy, disabled }) => (
        <ActionPlatformIcon
          // The row payload is the icon's source until the menu has read the
          // real rows — after that the menu's copy is newer (it reflects a push
          // or unlink that happened in this very menu) and wins.
          links={linksKnown ? menuLinks : links}
          size={size}
          // Present-but-empty: the real open handler is the one Radix injects
          // through `asChild`. See ActionPlatformIcon's `onOpen` doc.
          onOpen={() => {}}
          disabled={busy || disabled}
        />
      )}
    />
  )
}
