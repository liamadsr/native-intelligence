/**
 * The app's keyboard shortcuts, in one place (owner, 11-20: "Like Linear,
 * everything has a shortcut. You should be able to open any page with a
 * dedicated shortcut that makes sense … use and prioritize [the well
 * established ones] … I think Linear does the G+M kind of thing").
 * The map and the reasoning for each letter: docs/plans/keyboard-shortcuts.md.
 *
 *   GO_TO       G then a letter opens a page, as the app rail opens it
 *               (rail/app-rail.tsx: openTarget `page`, a group on its member
 *               last used). Every `/` page has one (the tests say so).
 *   SHORTCUTS   every shortcut the app has, for the sheet on `?`
 *               (shortcuts/shortcuts-sheet.tsx) and for the conflict test
 *               (__tests__/shortcuts-registry.test.ts): two shortcuts on the
 *               same keys where both can fire is a failing test, as is one
 *               on a key the browser, the OS or the desktop app keeps.
 *
 * Where a shortcut is handled stays where it was (lib/hotkeys.ts useHotkeys,
 * or a page's own listener: Mail's): this is its entry, so a new one is
 * added here too, or the test can't see it.
 *
 * Client-safe and pure.
 */
import { CREATE_TYPES, type CreateTypeId } from './create/create-types'
import { CREATE_LETTERS } from './create/create-keys'

/** Where a shortcut can fire: anywhere in the app, or only on one page or panel. */
export type ShortcutScope = 'global' | 'mail' | 'inbox' | 'list' | 'task' | 'page-card' | 'palette' | 'create-menu' | 'composer' | 'editor'

/** The sheet's sections, in its order. */
export type ShortcutSection = 'General' | 'Go to' | 'Create' | 'Lists' | 'Tasks' | 'Mail' | 'Inbox' | 'Documents'

/**
 * One shortcut's keys, as the sheet writes them: `mod+k` (⌘K on a Mac, Ctrl+K
 * elsewhere), `shift+h`, `?`, `escape`, or a sequence `g m` (G, then M).
 */
export type ShortcutKeys = string

export interface ShortcutDef {
  id: string
  /** Its keys; several when more than one does the same (`/` and ⌘K). */
  keys: readonly ShortcutKeys[]
  label: string
  section: ShortcutSection
  scope: ShortcutScope
  /**
   * A page's own shortcut that takes the place of an app-wide one on the
   * same keys while that page has the keyboard (Mail's C writes an email
   * where C elsewhere opens Create): the id it stands in for. The only
   * allowed overlap.
   */
  overrides?: string
  /**
   * A key read by what another shortcut opened (C then A: the A is read by
   * the Create menu C opened): the id of that shortcut. Its keys start with
   * that shortcut's, on purpose, so the pair is not a conflict.
   */
  continues?: string
  /** For the sheet: the Create type it makes (shown only while the workspace offers it). */
  createType?: CreateTypeId
}

// ── G then a letter ────────────────────────────────────────

/** Where a go-to letter leads: a `/` page (its slug), home (the chat), or a rail page group (its member last used). */
export type GoToTarget = { type: 'home' } | { type: 'page'; slug: string } | { type: 'group'; id: 'seo' | 'drive' }

export interface GoToDef {
  /** The second key, a lower-case letter (G is the first). */
  letter: string
  target: GoToTarget
  /** What the sheet calls it where the workspace offers no label of its own (home, a group). */
  label: string
  /** Why this letter (docs/plans/keyboard-shortcuts.md has the same). */
  why: string
}

/** The sequences' first key. */
export const GO_TO_PREFIX = 'g'

const page = (letter: string, slug: string, label: string, why: string): GoToDef => ({ letter, target: { type: 'page', slug }, label, why })

/**
 * G then a letter: the rail's own icons first, on their initials where they
 * are free (the owner's G M Mail, G C Calendar, G H Home), Linear's where it
 * has one (G P Projects), then each page under them.
 */
export const GO_TO: readonly GoToDef[] = [
  { letter: 'h', target: { type: 'home' }, label: 'Home', why: 'Home (the owner’s example)' },
  page('m', 'mail', 'Mail', 'Mail (the owner’s example; Gmail and Superhuman use M for mail too)'),
  page('c', 'calendar', 'Calendar', 'Calendar (the owner’s example), so Contacts, Captures, Companies and Campaigns take another letter'),
  page('a', 'actions', 'My Actions', 'Actions'),
  page('t', 'team-chat', 'Team chat', 'Team chat (on the rail, used daily; Teams takes E)'),
  // The inbox (docs/plans/channels-inbox.md): on the rail, used daily, so it takes Campaigns' leftover J (the owner can swap).
  page('j', 'inbox', 'Inbox', 'a leftover letter, Campaigns’ until the inbox came: I is the agents and every other letter in the word is taken (the owner can swap)'),
  // Drive as a group since Spreadsheets joined it (11-22): 25 letters were taken by 25 pages, so one more page
  // has no letter of its own. G D opens Drive on its page last used (Docs the first time), as the rail does;
  // Knowledge, Files and Tables keep their own letters; Spreadsheets and Canvases are reached through this one.
  { letter: 'd', target: { type: 'group', id: 'drive' }, label: 'Drive', why: 'Drive, on its page last used (Docs at first), as the rail opens it' },
  page('k', 'knowledge', 'Knowledge', 'Knowledge'),
  page('f', 'files', 'Files', 'Files'),
  page('l', 'tables', 'Tables', 'Lists (Tables’ own keyword); T is Team chat'),
  page('o', 'contacts', 'Contacts', 'cOntacts: C is Calendar and P is Projects (Linear’s)'),
  page('b', 'companies', 'Companies', 'Businesses: C and O are taken'),
  page('e', 'deals', 'Deals', 'dEals: D is Docs'),
  page('p', 'projects', 'Projects', 'Projects (Linear’s G P)'),
  page('n', 'initiatives', 'Initiatives', 'iNitiatives: I is the agents'),
  page('u', 'teams', 'Teams', 'teams, as in "users": T is Team chat, E is Deals (the least used of the three; the owner can swap)'),
  page('r', 'captures', 'Captures', 'Recordings: C is Calendar'),
  page('y', 'availability', 'Availability', 'availabilitY: A is Actions, V the Studio'),
  page('x', 'prospecting', 'Prospecting', 'prospects, eXplored: P is Projects and every other letter in the word is taken (the owner can swap)'),
  page('q', 'sequences', 'Sequences', 'seQuences: S is SEO'),
  page('v', 'studio', 'Studio', 'Video: S is SEO'),
  { letter: 's', target: { type: 'group', id: 'seo' }, label: 'SEO', why: 'SEO, on its section last used, as the rail opens it' },
  page('i', 'agents', 'Agents & skills', 'the AI: A is Actions'),
  page('w', 'flows', 'Flows', 'Workflows: F is Files'),
  page('z', 'evals', 'Evals', 'a leftover letter: E, V, A, L and S are taken (the owner can swap)'),
  // Reviews (docs/plans/github-reviews.md): G V was asked for, but it is the Studio's, and G was the last letter free.
  page('g', 'reviews', 'Reviews', 'GitHub: V (asked for) is the Studio, and G was the one letter left (the owner can swap)'),
]

/**
 * `/` pages with no go-to of their own, and why. The Library (Liam, 11-21:
 * Knowledge's library, its own page): every letter but G is taken, and it
 * is one `]` from Knowledge, the page before it in Drive.
 */
export const NO_GO_TO_PAGES: Readonly<Record<string, string>> = {
  library: 'every letter but G is taken: G K, then ] (the next page in Drive)',
  campaigns: 'its leftover J went to the Inbox (docs/plans/channels-inbox.md): G X opens Outreach, then its sub-nav',
}

/** A go-to's keys in the registry's notation (`g m`). */
export const goToKeys = (letter: string): ShortcutKeys => `${GO_TO_PREFIX} ${letter}`

// ── Every shortcut ─────────────────────────────────────────

/** The shortcuts other than G then a letter. */
export const SHORTCUTS_BESIDES_GO_TO: readonly ShortcutDef[] = [
  // General
  { id: 'search', keys: ['mod+k', '/'], label: 'Search and open anything', section: 'General', scope: 'global' },
  { id: 'create', keys: ['c'], label: 'Create', section: 'General', scope: 'global' },
  { id: 'shortcuts', keys: ['?'], label: 'Keyboard shortcuts', section: 'General', scope: 'global' },
  { id: 'side-panel', keys: ['mod+\\'], label: 'Show or hide the side panel', section: 'General', scope: 'global' },
  { id: 'settings', keys: ['mod+,'], label: 'Settings', section: 'General', scope: 'global' },
  { id: 'record', keys: ['mod+n'], label: 'Start recording', section: 'General', scope: 'global' },
  { id: 'close-page', keys: ['escape'], label: 'Put away the page in front', section: 'General', scope: 'page-card' },
  { id: 'card-back', keys: ['mod+['], label: 'Back, in the page in front', section: 'General', scope: 'page-card' },
  { id: 'card-forward', keys: ['mod+]'], label: 'Forward, in the page in front', section: 'General', scope: 'page-card' },
  { id: 'group-previous', keys: ['['], label: 'Previous page in the group (Drive, Calendar, Contacts…)', section: 'General', scope: 'global' },
  { id: 'group-next', keys: [']'], label: 'Next page in the group', section: 'General', scope: 'global' },
  // Lists and boards (components/views/unified-view-layout.tsx)
  { id: 'list-next', keys: ['j', 'arrowdown'], label: 'Next row', section: 'Lists', scope: 'list' },
  { id: 'list-previous', keys: ['k', 'arrowup'], label: 'Previous row', section: 'Lists', scope: 'list' },
  { id: 'list-open', keys: ['enter', 'o'], label: 'Open the row', section: 'Lists', scope: 'list' },
  { id: 'list-select', keys: ['x'], label: 'Select the row', section: 'Lists', scope: 'list' },
  { id: 'list-clear', keys: ['escape'], label: 'Clear the selection', section: 'Lists', scope: 'list', overrides: 'close-page' },
  // A task: the row the keyboard is on, or the task open in its panel
  { id: 'task-status', keys: ['s'], label: 'Set status', section: 'Tasks', scope: 'task' },
  { id: 'task-priority', keys: ['p'], label: 'Set priority', section: 'Tasks', scope: 'task' },
  { id: 'task-assign', keys: ['a'], label: 'Assign', section: 'Tasks', scope: 'task' },
  { id: 'task-assign-me', keys: ['i'], label: 'Assign to me', section: 'Tasks', scope: 'task' },
  { id: 'task-labels', keys: ['l'], label: 'Labels', section: 'Tasks', scope: 'task' },
  { id: 'task-due', keys: ['shift+d'], label: 'Due date', section: 'Tasks', scope: 'task' },
  { id: 'remind', keys: ['shift+h'], label: 'Remind me', section: 'Tasks', scope: 'task' },
  // Mail (components/email/email-layout.tsx)
  { id: 'mail-compose', keys: ['c'], label: 'Write an email', section: 'Mail', scope: 'mail', overrides: 'create' },
  { id: 'mail-search', keys: ['/'], label: 'Search mail', section: 'Mail', scope: 'mail', overrides: 'search' },
  { id: 'mail-next', keys: ['j'], label: 'Next thread', section: 'Mail', scope: 'mail' },
  { id: 'mail-previous', keys: ['k'], label: 'Previous thread', section: 'Mail', scope: 'mail' },
  { id: 'mail-close', keys: ['escape'], label: 'Close the thread', section: 'Mail', scope: 'mail', overrides: 'close-page' },
  { id: 'mail-archive', keys: ['e'], label: 'Archive', section: 'Mail', scope: 'mail' },
  { id: 'mail-reply', keys: ['r'], label: 'Reply', section: 'Mail', scope: 'mail' },
  { id: 'mail-reply-all', keys: ['a'], label: 'Reply all', section: 'Mail', scope: 'mail' },
  { id: 'mail-forward', keys: ['f'], label: 'Forward', section: 'Mail', scope: 'mail' },
  { id: 'mail-send', keys: ['mod+enter'], label: 'Send (in the composer)', section: 'Mail', scope: 'mail' },
  { id: 'mail-unread', keys: ['u'], label: 'Mark unread', section: 'Mail', scope: 'mail' },
  // Inbox (components/inbox/inbox-view.tsx; docs/plans/channels-inbox.md)
  { id: 'inbox-next', keys: ['j'], label: 'Next item', section: 'Inbox', scope: 'inbox' },
  { id: 'inbox-previous', keys: ['k'], label: 'Previous item', section: 'Inbox', scope: 'inbox' },
  { id: 'inbox-open', keys: ['enter', 'o'], label: 'Open the item', section: 'Inbox', scope: 'inbox' },
  { id: 'inbox-done', keys: ['e'], label: 'Done', section: 'Inbox', scope: 'inbox' },
  { id: 'inbox-hold', keys: ['h'], label: 'Hold for later', section: 'Inbox', scope: 'inbox' },
  { id: 'inbox-close', keys: ['escape'], label: 'Close the item', section: 'Inbox', scope: 'inbox', overrides: 'close-page' },
  // A document, with the caret in it (components/editor/doc-extras; docs/plans/doc-editor-extras.md).
  // ⌘F stays the browser's (RESERVED_KEYS): find and replace is ⌘⇧F.
  { id: 'doc-find', keys: ['mod+shift+f'], label: 'Find and replace', section: 'Documents', scope: 'editor' },
  { id: 'doc-fold', keys: ['mod+enter'], label: 'Fold or unfold the section (in a heading)', section: 'Documents', scope: 'editor' },
]

// ── C then a letter, and a composer's keys ─────────────────

/**
 * C then a letter: straight to a type's composer (lib/create/create-keys.ts
 * has the letters and why), read by the Create menu C opens; and the keys
 * every composer answers (docs/plans/create-everything.md).
 */
export const CREATE_SHORTCUTS: readonly ShortcutDef[] = [
  ...CREATE_TYPES.flatMap((t): ShortcutDef[] => {
    const letter = CREATE_LETTERS[t.id]
    return letter
      ? [{ id: `create-${t.id}`, keys: [`c ${letter}`], label: `New ${t.label.toLowerCase()}`, section: 'Create', scope: 'create-menu', continues: 'create', createType: t.id }]
      : []
  }),
  { id: 'composer-create-open', keys: ['enter'], label: 'Create and open it (in the title)', section: 'Create', scope: 'composer' },
  { id: 'composer-create-another', keys: ['mod+enter'], label: 'Create and start another', section: 'Create', scope: 'composer' },
  { id: 'composer-cancel', keys: ['escape'], label: 'Cancel', section: 'Create', scope: 'composer' },
]

/** Every shortcut: the go-to letters, then the rest. */
export const SHORTCUTS: readonly ShortcutDef[] = [
  ...GO_TO.map(
    (g): ShortcutDef => ({ id: `go-${g.letter}`, keys: [goToKeys(g.letter)], label: g.label, section: 'Go to', scope: 'global' }),
  ),
  ...SHORTCUTS_BESIDES_GO_TO,
  ...CREATE_SHORTCUTS,
]

/**
 * Keys the browser, the OS or the desktop app (desktop/src-tauri: its
 * default menu) keep: no shortcut of ours may take them. ⌘N, ⌘[ and ⌘] were
 * ours before this list (recording; a page's history) and stay.
 */
export const RESERVED_KEYS: readonly ShortcutKeys[] = [
  'mod+a', 'mod+c', 'mod+v', 'mod+x', 'mod+z', 'mod+shift+z', 'mod+f', 'mod+g', 'mod+p', 'mod+s', 'mod+r', 'mod+l',
  'mod+t', 'mod+w', 'mod+q', 'mod+h', 'mod+m', 'mod+d', 'mod+o', 'mod+shift+t', 'mod+shift+n', 'mod+=', 'mod+-', 'mod+0',
  'mod+1', 'mod+2', 'mod+3', 'mod+4', 'mod+5', 'mod+6', 'mod+7', 'mod+8', 'mod+9', 'mod+alt+i', 'mod+shift+i',
  // The desktop app's read-aloud hotkey and its presets (desktop/src-tauri/src/read_selection.rs).
  'ctrl+alt+r', 'ctrl+alt+s', 'ctrl+alt+space', 'ctrl+escape',
]

// ── Reading keys ───────────────────────────────────────────

export interface ParsedCombo {
  key: string
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/** `mod+shift+k` → its parts (one key of a sequence). `+` alone, or as the key, is the key. */
export function parseCombo(combo: string): ParsedCombo {
  const parts = combo === '+' ? ['+'] : combo.toLowerCase().split('+')
  const key = parts[parts.length - 1] === '' ? '+' : parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  return { key, mod: mods.has('mod'), ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt') }
}

/** A combo written one way: `shift+mod+K` and `mod+shift+k` are the same keys. */
export function normalizeKeys(keys: ShortcutKeys): string {
  return keys
    .trim()
    .split(/\s+/)
    .map((step) => {
      const c = parseCombo(step)
      return [c.mod && 'mod', c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.key].filter(Boolean).join('+')
    })
    .join(' ')
}

const KEY_NAMES: Record<string, string> = { escape: 'Esc', enter: '↵', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', space: 'Space' }

/**
 * One key of a combo as a kbd chip reads: `mod+k` → ['⌘', 'K'] on a Mac,
 * ['Ctrl', 'K'] elsewhere; `shift+h` → ['⇧', 'H'].
 */
export function comboChips(combo: string, mac: boolean): string[] {
  const c = parseCombo(combo)
  const out: string[] = []
  if (c.ctrl) out.push(mac ? '⌃' : 'Ctrl')
  if (c.mod) out.push(mac ? '⌘' : 'Ctrl')
  if (c.alt) out.push(mac ? '⌥' : 'Alt')
  if (c.shift) out.push(mac ? '⇧' : 'Shift')
  out.push(KEY_NAMES[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key))
  return out
}

/** A sequence's steps as chips: `g m` → [['G'], ['M']]. */
export function keysChips(keys: ShortcutKeys, mac: boolean): string[][] {
  return keys.trim().split(/\s+/).map((step) => comboChips(step, mac))
}

/** Plain words for a tooltip or a label: `g m` → "G then M", `mod+k` → "⌘K". */
export function keysText(keys: ShortcutKeys, mac: boolean): string {
  return keysChips(keys, mac)
    .map((chips) => (mac ? chips.join('') : chips.join('+')))
    .join(' then ')
}

/** The go-to for a page (its slug), a rail group (its id) or home, if it has one. */
export function goToFor(target: { slug?: string; group?: string; home?: boolean }): GoToDef | null {
  return (
    GO_TO.find((g) =>
      target.home ? g.target.type === 'home' : target.group ? g.target.type === 'group' && g.target.id === target.group : g.target.type === 'page' && g.target.slug === target.slug,
    ) ?? null
  )
}

// ── Conflicts ──────────────────────────────────────────────

/**
 * Scopes that are on screen and answer the same key press together besides
 * the app-wide one: a task's keys act on the row the keyboard is on in a list,
 * and a list is inside the page in front.
 */
const SCOPES_THAT_MEET: ReadonlyArray<readonly [ShortcutScope, ShortcutScope]> = [
  ['list', 'task'],
  ['list', 'page-card'],
  ['task', 'page-card'],
  ['mail', 'page-card'],
  ['inbox', 'page-card'],
]

/** Can two scopes fire on the same key press? The app-wide one with any; a page's own with its own, and with those it sits in. */
function scopesMeet(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === 'global' || b === 'global' || a === b) return true
  return SCOPES_THAT_MEET.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
}

/** Is `later` a key read by what `first` opened (or by a page's own key standing in for it)? */
function continuesFrom(later: ShortcutDef, first: ShortcutDef, all: readonly ShortcutDef[]): boolean {
  if (!later.continues) return false
  if (later.continues === first.id) return true
  return first.overrides === later.continues && all.some((s) => s.id === later.continues)
}

export interface ShortcutConflict {
  keys: string
  ids: [string, string]
  why: string
}

/**
 * Every pair of shortcuts that could fire on the same key press (an
 * `overrides` pair aside), every bare key that is also a sequence's first key
 * (it would fire before the second is pressed), and every shortcut on a
 * reserved key. Empty: the registry is coherent.
 */
export function findShortcutConflicts(
  shortcuts: readonly ShortcutDef[] = SHORTCUTS,
  reserved: readonly ShortcutKeys[] = RESERVED_KEYS,
): ShortcutConflict[] {
  const out: ShortcutConflict[] = []
  const flat = shortcuts.flatMap((s) => s.keys.map((k) => ({ s, keys: normalizeKeys(k) })))
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i]
      const b = flat[j]
      if (a.s.id === b.s.id || !scopesMeet(a.s.scope, b.s.scope)) continue
      if (a.s.overrides === b.s.id || b.s.overrides === a.s.id) continue
      // C then A is read by the menu C opened (and by Mail's C standing in for it).
      if (continuesFrom(a.s, b.s, shortcuts) || continuesFrom(b.s, a.s, shortcuts)) continue
      if (a.keys === b.keys) out.push({ keys: a.keys, ids: [a.s.id, b.s.id], why: 'same keys' })
      else if (b.keys.startsWith(`${a.keys} `) || a.keys.startsWith(`${b.keys} `)) out.push({ keys: a.keys, ids: [a.s.id, b.s.id], why: 'one starts the other' })
    }
  }
  const kept = new Set(reserved.map(normalizeKeys))
  for (const { s, keys } of flat) {
    if (kept.has(keys)) out.push({ keys, ids: [s.id, s.id], why: 'kept by the browser, the OS or the desktop app' })
  }
  return out
}
