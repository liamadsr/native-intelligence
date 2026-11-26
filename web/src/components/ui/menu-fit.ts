/**
 * How menus, pickers and popovers keep inside the window.
 *
 * The shared primitives (popover, dropdown-menu, select, context-menu) open
 * with Radix's collision handling on: they flip to the side with more room,
 * shift sideways at the window's edges, and stay this far from every edge.
 * Radix measures the room it publishes as
 * `--radix-<primitive>-content-available-height` after this padding, so a
 * content capped to it ends this many pixels short of the window's edge.
 */
export const MENU_COLLISION_PADDING = 8

/**
 * Where a hand-positioned list (one that does not go through Radix) opens and
 * how tall it may be: on its usual side while that side has `need` pixels
 * free, else on whichever side has more room; capped to that room less the
 * padding and the gap, never below `min` so a list squeezed into a corner
 * still shows a few rows. Pure.
 */
export function roomFor(
  anchor: { top: number; bottom: number },
  viewportHeight: number,
  {
    prefer = 'bottom',
    need = 200,
    min = 120,
    gap = 0,
    padding = MENU_COLLISION_PADDING,
  }: { prefer?: 'top' | 'bottom'; need?: number; min?: number; gap?: number; padding?: number } = {},
): { side: 'top' | 'bottom'; maxHeight: number; below: number; above: number } {
  const below = Math.max(0, viewportHeight - anchor.bottom - gap - padding)
  const above = Math.max(0, anchor.top - gap - padding)
  const preferred = prefer === 'bottom' ? below : above
  const other = prefer === 'bottom' ? above : below
  const side = preferred >= need || preferred >= other ? prefer : prefer === 'bottom' ? 'top' : 'bottom'
  return { side, maxHeight: Math.max(min, side === 'bottom' ? below : above), below, above }
}

/**
 * The `position: fixed` style for a hand-positioned list under or over an
 * anchor rect (a caret, a cell, a button), from `roomFor`. Opening upward it
 * pins the list's bottom edge to the anchor, so it needs no measuring of the
 * list and does not move as rows come and go. The list scrolls in its cap.
 */
export function fixedMenuStyle(
  anchor: { top: number; bottom: number },
  viewport: { height: number },
  options: Parameters<typeof roomFor>[2] & { gap?: number } = {},
): { side: 'top' | 'bottom'; style: { top?: number; bottom?: number; maxHeight: number; overflowY: 'auto' } } {
  const gap = options.gap ?? 4
  const room = roomFor(anchor, viewport.height, { ...options, gap })
  return {
    side: room.side,
    style:
      room.side === 'bottom'
        ? { top: anchor.bottom + gap, maxHeight: room.maxHeight, overflowY: 'auto' }
        : { bottom: viewport.height - anchor.top + gap, maxHeight: room.maxHeight, overflowY: 'auto' },
  }
}
