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
 *
 * Owner, 11-22 ("match the [reference product's] experience when it comes
 * to creating new entities"): every page's New button opens it too, preset
 * to its type and its place (docs/plans/create-everything.md), so creating
 * reads the same everywhere.
 */
import type { CreateTypeId } from './create-types'
import type { CreateContext, CreateSource } from './create-context'

/** Opens the Create dialog: `detail` is an OpenCreateRequest (or nothing). */
export const OPEN_CREATE_EVENT = 'open-create'

export interface OpenCreateRequest {
  /**
   * The type whose composer opens. Absent: the Create menu (every type, type
   * to filter), as C and the rail's + open it (owner, 11-22: one Create
   * menu, as the reference product has). A page's New button names its own type.
   */
  type?: CreateTypeId
  /** Where it was opened: "Create in <name>", prefills, the record a task links back to (create-context.ts). */
  context?: CreateContext
}

export function openCreateDialog(request: OpenCreateRequest = {}): void {
  if (typeof document === 'undefined') return
  document.dispatchEvent(new CustomEvent<OpenCreateRequest>(OPEN_CREATE_EVENT, { detail: request }))
}

/**
 * "Make a task" from an email thread or a team-chat message: the action
 * composer, its title prefilled ("Follow up: …"), the task linked back to
 * its source on create (the actions route's `about`). The person can change
 * the title and set its properties before it is made.
 */
export function openTaskComposer(source: CreateSource): void {
  openCreateDialog({ type: 'action', context: { source } })
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
