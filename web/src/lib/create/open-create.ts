/**
 * Opening the Create dialog (components/create-dialog.tsx), from anywhere.
 *
 * Liam, 11-20: "Bring back the app's Create popup, so anything can be
 * created from one place again", from the rail's + (its first button, above
 * Home) and the `c` key. This lifts the 10-20 decision ("the agent creates
 * things on request": no Create button, no app-wide `c`); the agent still
 * does, and the dialog is the by-hand way.
 *
 * Every opener goes through one document event, as Mail's New email already
 * did (`open-create-email`, kept as it was, and `open-create-contact`):
 * `open-create` with an optional type to start on.
 */
import type { CreateTypeId } from './create-types'

/** Opens the Create dialog: `detail` is an OpenCreateRequest (or nothing). */
export const OPEN_CREATE_EVENT = 'open-create'

export interface OpenCreateRequest {
  /** The type the dialog opens on. Absent: Action. */
  type?: CreateTypeId
}

export function openCreateDialog(request: OpenCreateRequest = {}): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent<OpenCreateRequest>(OPEN_CREATE_EVENT, { detail: request }))
}

/**
 * Whether a bare `c` may open the dialog: not while typing (the hotkey
 * helper already skips inputs, textareas and contenteditables), and not while
 * another dialog, popover or menu has the focus (a `c` there is that
 * surface's own: its typeahead, a field, a shortcut of its own).
 */
export function createKeyAllowed(target: EventTarget | null): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  for (const el of [target, active]) {
    if (!(el instanceof Element)) continue
    if (el.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="menubar"],[role="listbox"],[role="combobox"],[role="textbox"],[contenteditable]:not([contenteditable="false"]),input,textarea,select,[data-radix-popper-content-wrapper]')) {
      return false
    }
  }
  return true
}
