/**
 * The Create flow's keys (owner, 11-22: "match the macro experience when it
 * comes to creating new entities"; docs/plans/create-everything.md).
 *
 *   C              opens the Create menu: every type, type to filter, ↵ picks.
 *   C then letter  straight to that type's composer (C then A: a new action).
 *                  The letter is read by the menu itself, as its first key
 *                  within SEQUENCE_MS of opening, while its search is empty;
 *                  after that, letters filter as typing does.
 *   ↵              in a composer's title: create, then open what was made.
 *   ⌘/Ctrl ↵       anywhere in a composer: create, and keep it open for another.
 *   Esc            cancel (the dialog's own).
 *
 * The letters keep clear of the app's other single keys only where they
 * meet: they are read inside the open menu, nowhere else, so `C then A` is
 * not `A` (a task's Assign) nor `G then A` (My Actions). Most mirror the
 * type's initial; where that is taken, the G letter of the type's page
 * (lib/shortcuts.ts GO_TO) so the two families agree: Contact O (G O
 * Contacts), Company B (G B Companies). Macro's own where it has one:
 * Canvas N, Channel G. Macro's Folder F is our Flow's, and folder's O, L
 * and D are taken (Contact, Deal, Doc): Folder is R, its next free letter.
 *
 * Client-safe and pure (SEQUENCE_MS is the G sequences' window, shared).
 */
import type { CreateTypeId } from './create-types'
import { SEQUENCE_MS } from '@/lib/hotkeys'

/** C then this letter: the type it goes to. Types without one are a filter away. */
export const CREATE_LETTERS: Readonly<Partial<Record<CreateTypeId, string>>> = {
  action: 'a',
  project: 'p',
  initiative: 'i',
  document: 'd',
  table: 't',
  spreadsheet: 's',
  canvas: 'n',
  folder: 'r',
  event: 'e',
  email: 'm',
  contact: 'o',
  company: 'b',
  deal: 'l',
  channel: 'g',
  flow: 'f',
  agent: 'u',
  package: 'k',
}

/** The letter's type, among those on offer (a type whose page is off has no letter). */
export function createTypeForLetter(letter: string, available: Iterable<CreateTypeId>): CreateTypeId | null {
  const key = letter.toLowerCase()
  if (key.length !== 1) return null
  for (const id of available) if (CREATE_LETTERS[id] === key) return id
  return null
}

/** Does the menu read this key as a type's letter (empty search, soon after opening, a bare letter)? */
export function isCreateLetterKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  state: { search: string; openedAt: number; now?: number },
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
  if (!/^[a-z]$/i.test(e.key)) return false
  if (state.search !== '') return false
  return (state.now ?? Date.now()) - state.openedAt <= SEQUENCE_MS
}

/** How soon after opening a lone `c` in the search is the opening key's own echo. */
export const OPENING_ECHO_MS = 300

/**
 * C opens the menu and the menu focuses its search during that keydown, so
 * the browser types the `c` into it. A search of just `c` that soon is that
 * echo, not a search.
 */
export function isOpeningKeyEcho(value: string, openedAt: number, now = Date.now()): boolean {
  return value.toLowerCase() === 'c' && now - openedAt <= OPENING_ECHO_MS
}

/** What a key does in a composer: create and open, create and stay for another, or nothing. */
export type ComposerKeyIntent = 'create-open' | 'create-another' | null

/**
 * ↵ in the title (not a textarea, not mid-IME, not ⇧↵): create and open.
 * ⌘/Ctrl ↵ anywhere: create and keep the composer for another.
 */
export function composerKeyIntent(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing'>,
  where: 'title' | 'other',
): ComposerKeyIntent {
  if (e.key !== 'Enter' || e.isComposing) return null
  if (e.metaKey || e.ctrlKey) return 'create-another'
  if (where === 'title' && !e.shiftKey && !e.altKey) return 'create-open'
  return null
}
