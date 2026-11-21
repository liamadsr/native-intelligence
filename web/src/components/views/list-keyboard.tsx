'use client'

/**
 * A list's keyboard focus (owner, 11-20: the contextual keys of
 * docs/plans/keyboard-shortcuts.md): the row J and K move to, Enter opens, X
 * selects and the task keys (S, P, A, I, L, ⇧D) act on. It is not the row
 * that is open (`selectedItemId`) nor the rows that are checked (the bulk
 * selection): it is where the keyboard is in the list, drawn as a ring.
 *
 * unified-view-layout.tsx holds it and provides it here; a row reads it
 * (useIsListFocused) without a prop through every layer of the list and the
 * board. The flat list scrolls its virtualizer to it (useListFocusScroll).
 *
 * Which list the keys are for: the one the person is working in. A list
 * answers a key typed inside it, and a key typed on nothing in particular
 * (the page itself) while it is in the page in front. Never one typed on a
 * control (a button, a link, a tab): Enter there presses that control.
 *
 * Client-only.
 */
import * as React from 'react'

const ListFocusContext = React.createContext<string | null>(null)

export const ListFocusProvider = ListFocusContext.Provider

/** Is `id` the row the keyboard is on, in the list around it? */
export function useIsListFocused(id: string | null | undefined): boolean {
  const focused = React.useContext(ListFocusContext)
  return !!id && focused === id
}

/** The row the keyboard is on, in the list around it (null: none yet). */
export function useListFocusedId(): string | null {
  return React.useContext(ListFocusContext)
}

/** The attribute every row and card carries with its id, for finding it on screen. */
export const LIST_ROW_ATTR = 'data-list-row-id'

/** The ring a focused row or card wears. */
export const LIST_FOCUS_RING = 'ring-1 ring-inset ring-foreground/25 bg-muted/40'

const CONTROLS = 'button, a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="option"], [role="menuitem"], [role="textbox"], [role="combobox"]'

/** Where a key is typing, never a shortcut (useHotkeys skips most of these already). */
const TEXT_ENTRY = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'

/** Keys a focused control answers itself. */
const CONTROL_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/** Is the element shown (laid out, not under an inert or hidden ancestor)? */
function shown(el: Element): boolean {
  return el.getClientRects().length > 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]')
}

/**
 * Is this key press for the region at `root` (a list, a task's panel): typed
 * inside it (on one of its controls, a letter only), or typed on the page itself (the
 * body, or the full-screen page's own frame) while the region is in the page
 * in front, or is the only one of its kind (`kind`, a selector) on screen?
 */
export function regionOwnsKeys(root: HTMLElement | null, e: KeyboardEvent, kind: string): boolean {
  if (!root || !root.isConnected || !shown(root)) return false
  const t = e.target
  if (!(t instanceof Element)) return false
  if (root.contains(t)) {
    // On one of its controls (a picker's button the focus came back to, a
    // checkbox): letters are still the region's, but Enter, Space and the
    // arrows are the control's own (they press it, move in it).
    const control = t.closest(CONTROLS)
    if (!control || !root.contains(control)) return true
    if (t.closest(TEXT_ENTRY)) return false
    // A row's own control (its picker's button, the focus back on it once the
    // picker closed): Enter opens the row, as Linear's does; Space still presses it.
    if (e.key === 'Enter' && control.closest(`[${LIST_ROW_ATTR}]`)) return true
    return !CONTROL_KEYS.has(e.key)
  }
  const front = root.closest('[data-chat-card-fullscreen]')
  if (t === document.body || t === document.documentElement) {
    // Nothing focused: the region in the page in front, or the only one on screen.
    if (front) return true
    return !document.querySelector('[data-chat-card-fullscreen]') && Array.from(document.querySelectorAll(kind)).filter(shown).length === 1
  }
  // The full-screen page's frame (it takes the focus when it opens), or a
  // frame inside it that wraps the region (a card's content, focused when a
  // record opens over its list).
  return !!front && (t === front || (front.contains(t) && t.contains(root)))
}

/** Is this key press for the list at `root` (regionOwnsKeys, among lists)? */
export function listOwnsKeys(root: HTMLElement | null, e: KeyboardEvent): boolean {
  return regionOwnsKeys(root, e, '[data-list-keyboard-root]')
}

/** A task property a key opens (docs/plans/keyboard-shortcuts.md): its field, as rows and panels mark it. */
export type TaskPropertyField = 'status' | 'priority' | 'assignee' | 'labels' | 'due_at'

/** The attribute a property's picker sits in, on a row (entity-row.tsx) and in a task's panel. */
export const PROPERTY_FIELD_ATTR = 'data-property-field'

/** What the person calls each one, for "show it to set it from the keyboard". */
export const TASK_PROPERTY_LABELS: Readonly<Record<TaskPropertyField, string>> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  labels: 'Labels',
  due_at: 'Due date',
}

/**
 * Open a property's picker inside `container` (the row the keyboard is on, a
 * task's panel), as a click on it would. False when it isn't there (a row
 * whose view doesn't show that property).
 */
export function openPropertyPicker(container: Element | null, field: TaskPropertyField): boolean {
  if (!container) return false
  const host = container.querySelector(`[${PROPERTY_FIELD_ATTR}="${field}"]`)
  if (!host) return false
  const trigger = host instanceof HTMLButtonElement ? host : host.querySelector<HTMLElement>('button, [role="button"], [role="combobox"]')
  if (!trigger) return false
  trigger.click()
  return true
}

/** The next row id from `current`, `step` rows on (clamped; from nothing: the first, or the last going up). */
export function stepListFocus(ids: readonly string[], current: string | null, step: number): string | null {
  if (!ids.length) return null
  const at = current ? ids.indexOf(current) : -1
  if (at < 0) return step > 0 ? ids[0] : ids[ids.length - 1]
  return ids[Math.max(0, Math.min(ids.length - 1, at + step))]
}

/** Scroll the row the keyboard is on into view, where it is drawn in the DOM (a grouped list, the board). */
export function scrollListRowIntoView(root: HTMLElement | null, id: string | null): void {
  if (!root || !id) return
  const row = root.querySelector(`[${LIST_ROW_ATTR}="${CSS.escape(id)}"]`)
  if (row && 'scrollIntoView' in row) (row as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
