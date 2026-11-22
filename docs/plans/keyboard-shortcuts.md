# Keyboard shortcuts

The owner, 2026-11-20: "Like Linear, everything has a shortcut. You should be able to open
any page with a dedicated shortcut that makes sense. If there are shortcuts that are well
established, like C for create, use and prioritize those, and come up with new ones for
the ones that need one. I think Linear does the G+M kind of thing for 'go to mail'… let's
do the best practice on that front."

Status: **phase 1 is built and merged** (#199: go-to sequences, the `?` sheet, the registry
and its conflict test, the hints in the rail's tooltips). **Phase 2 is built** on
`claude/keyboard-shortcuts-2` (the owner's go-ahead, 11-20): the keys in lists, on a task (its
row or its panel), in Mail, and `[` / `]` in a page group. Mail's F (forward) is left out: the
app has no forward to call.

## The rules every shortcut keeps

- **One registry.** Every shortcut has an entry in `web/src/lib/shortcuts.ts`. That's what
  the `?` sheet reads and what `lib/__tests__/shortcuts-registry.test.ts` checks: no two
  shortcuts on the same keys where both can fire, no bare key that also starts a sequence,
  and no key the browser, the OS or the desktop app keeps. A page's own key may stand in for
  an app-wide one on the same keys only when its entry says so (`overrides`): Mail's C writes
  an email, Mail's `/` searches mail.
- **One helper.** Each shortcut is handled with `useHotkeys` (`web/src/lib/hotkeys.ts`), or by
  a page's own listener where one already existed (Mail's). The helper now does two-key
  sequences (`after: 'g'`) and the app-wide guard (`globalGuard`); there is no second system.
- **Never while typing.** Text fields, textareas and contenteditable editors (documents, the
  chat composer) keep their keys. A G typed in one arms nothing.
- **Never under something that owns the keyboard.** Nothing fires while a dialog, menu,
  listbox, popover or the `/` palette is open, or a modal has locked the page. A tooltip
  doesn't count. A letter typed in an open menu is that menu's typeahead.
- **Never a key someone else keeps.** The browser's ⌘F, ⌘L, ⌘T, ⌘W, ⌘R, ⌘P, ⌘S and ⌘1–9,
  editing's ⌘A/C/V/X/Z, macOS's ⌘H, ⌘M and ⌘Q, and the desktop app's read-aloud hotkey and its
  presets (⌃⌥R, ⌃⌥S, ⌃⌥Space, ⌃⎋) are all in `RESERVED_KEYS`. The desktop app has no other
  accelerators: its menu is Tauri's default, and dictation is the right ⌥ key. ⌘N, ⌘[ and ⌘]
  were ours already (recording, a page's history) and stay.
- **Discoverable.** `?` opens the sheet, and so does "Keyboard shortcuts" in the workspace menu
  (with Settings). Each rail icon's tooltip shows its go-to (Home: `G` `H`), as Search's shows
  ⌘K.

## Phase 1: G then a letter (built)

Press G, then a letter, within 1.5 seconds. It's Linear's and Gmail's two-key "go to".
A page opens exactly as its rail icon opens it: full screen in the main chat, and the same
card comes back if it's open already (`openTarget` `page`). SEO opens on the section used
last, as its icon does. Home puts away whatever is in front. A letter for a page that's off
in this workspace says so in a toast and does nothing else. The sheet lists only the pages
the workspace offers, in its own words (Contacts is "Customers" in a service business).

How the letters were picked: first the owner's three (G M Mail, G C Calendar, G H Home), then
Linear's G P Projects. Next, each rail icon gets its initial where that's free. Then each page
gets the next letter in its name that's free, or a word people use for it (Recordings,
Businesses, Video, Workflows). The four letters marked **leftover** are the weakest: every
letter in those names was taken. They are all on pages people rarely jump to, and swapping any
of them is a one-line change in `GO_TO`.

| Keys | Page | Why this letter |
|---|---|---|
| G H | Home | Home (the owner's example) |
| G M | Mail | Mail (the owner's example; Gmail and Superhuman use M too) |
| G C | Calendar | Calendar (the owner's example) |
| G A | My Actions | Actions |
| G T | Team chat | Team chat: on the rail and used daily (Teams takes U) |
| G D | Drive | Drive, on its page last used (Docs at first), as the rail opens it. It was Docs alone until Spreadsheets joined Drive (11-22): every letter was taken, so Spreadsheets, and Canvases after it, are reached through their group |
| G K | Knowledge | Knowledge |
| G F | Files | Files |
| G L | Tables | Lists, Tables' own keyword (T is Team chat) |
| G O | Contacts | cOntacts: C is Calendar and P is Projects |
| G B | Companies | Businesses: C and O are taken |
| G E | Deals | dEals: D is Docs |
| G P | Projects | Projects (Linear's G P) |
| G N | Initiatives | iNitiatives: I is the agents |
| G U | Teams | **leftover**: T, E, A, M and S are taken (think "users") |
| G R | Captures | Recordings: C is Calendar |
| G Y | Availability | availabilitY: A is Actions, V the Studio |
| G X | Prospecting | **leftover**: P is Projects, and every other letter in the word is taken |
| G Q | Sequences | seQuences: S is SEO |
| G J | Campaigns | **leftover**: every letter in the word is taken |
| G V | Studio | Video: S is SEO |
| G S | SEO | SEO, on the section used last (as its rail icon opens it) |
| G I | Agents & skills | the AI: A is Actions |
| G W | Flows | Workflows: F is Files |
| G Z | Evals | **leftover**: E, V, A, L and S are taken |

Two pages competing for one letter, and who won:
- **C**: Calendar, by the owner's example. Contacts takes O, Captures R, Companies B and
  Campaigns J.
- **P**: Projects, Linear's letter. Prospecting takes X.
- **T**: Team chat (on the rail, daily) over Teams (nested under My Actions, rare).
- **A**: My Actions over Agents (I, "the AI") and Availability (Y).
- **S**: SEO over Sequences (Q) and the Studio (V).
- **D**: Docs over Deals (E).

SEO's eight sections share G S, which opens the one used last; the sub-nav switches between
them, and phase 2's `[` / `]` would too.

## The other app-wide shortcuts (kept as they were)

| Keys | What | Where it's handled |
|---|---|---|
| ⌘K or `/` | Search and open anything (the palette) | `chat/chat-input.tsx` |
| C | Create (the Create dialog) | the "Bring back the Create dialog" session's branch; it's in the registry already |
| ? | Keyboard shortcuts | `shortcuts/global-shortcuts.tsx` |
| ⌘\ | Show or hide the side panel | `side-panels/side-panels.tsx` |
| ⌘, | Settings | `top-bar/top-bar.tsx` |
| ⌘N | Start recording | `top-bar/top-bar.tsx` |
| Esc | Put away the page in front | `chat-cards/show-tool-card.tsx` |
| ⌘[ / ⌘] | Back and forward in the page in front | `chat-cards/show-tool-card.tsx` |
| ⇧H | Remind me (task, project and initiative panels) | the three detail panels |
| Mail: C, `/`, J, K, Esc | Write an email, search mail, next and previous thread, close the thread | `email/email-layout.tsx` |

`/` stays the palette (an earlier owner decision). A page with a search field of its own
(Mail) takes `/` first. ⌘F stays the browser's find: it's reserved.

## Phase 2: contextual keys (built)

Kept to the habits Linear, Gmail and Superhuman made. Each list, task panel and Mail view stays
mounted (background cards, windows), so each answers only the keys meant for it: a key typed
inside it, or a key typed on the page itself while it is in the page in front
(`components/views/list-keyboard.tsx` `regionOwnsKeys`; Mail keeps its own rule). A key typed
on a control (a button, a tab, a link) is that control's: Enter there presses it.

**In any list or board** (tasks, projects, contacts, captures…: `unified-view-layout.tsx`).
The row the keyboard is on wears a ring. It's where J and K start from, and it moves to the
row last opened.
| Keys | What |
|---|---|
| J / K (and ↓ / ↑) | Next and previous row (the flat list scrolls its virtualizer to it) |
| Enter or O | Open the row, as a click does |
| X | Select or unselect the row (the bulk selection, as its checkbox) |
| Esc | Clear the selection (with nothing selected, Esc puts the page away as before) |

**A task** (the row the keyboard is on in a task list, or the task open in its panel)
| Keys | What |
|---|---|
| S | Status |
| P | Priority |
| A | Assignee |
| I | Assign to me (a row: you are its assignee; the panel: you join its assignees) |
| L | Labels |
| ⇧D | Due date |
| ⇧H | Remind me (already there) |

S, P, A, L and ⇧D open that property's own picker, the one a click on it opens
(`data-property-field` marks it on the row and in the panel). On a row whose view doesn't show
that property, a toast says to show it.

**Mail, with a thread open** (`email-layout.tsx`, `email-thread-detail.tsx`)
| Keys | What |
|---|---|
| E | Archive |
| R | Reply: the chat drafts a reply to the newest message someone else sent (`lib/email/reply-in-chat.ts`, as Reply does) |
| A | Reply all: the chat drafts it to everyone on the thread |
| U | Mark unread, and back to the list |
| J / K, `/`, C, Esc | As before |

Mail's list has no focused thread yet, so J/K and Enter in the list (with no thread open) are not
built. F (forward) is not built: the app has no forward to call.

**In a page group** (Drive, Calendar, Contacts, Outreach, SEO, Agents): `[` and `]` open the
previous and next page in its sub-nav, round from the last to the first. Outside a group page
they're left alone.

Keys left out on purpose: deleting from the keyboard (# or Delete in Mail, Backspace on a task)
can't be undone in one key. ⌘F stays the browser's. Bare digits are left free.

## Files

- `web/src/lib/shortcuts.ts`: the registry (`GO_TO`, `SHORTCUTS`, `RESERVED_KEYS`, `findShortcutConflicts`)
- `web/src/lib/hotkeys.ts`: `useHotkeys`, now with sequences (`after`) and `globalGuard`
- `web/src/app/account/(dashboard)/shortcuts/`: the go-to handler, the sheet and its opener
- `web/src/app/account/(dashboard)/rail/app-rail.tsx`: the go-to hint in each icon's tooltip
- `web/src/app/account/workspace-switcher.tsx`: "Keyboard shortcuts" in the workspace menu
- `web/src/components/views/list-keyboard.tsx`: a list's keyboard focus, whose key it is, opening a property's picker
- `web/src/components/views/unified-view-layout.tsx`: the list and task-row keys
- `web/src/app/account/(dashboard)/views/action-detail-panel.tsx`: the task panel's keys
- `web/src/components/email/email-layout.tsx`, `email-thread-detail.tsx`: Mail's E, R, A, U
- Tests: `web/src/lib/__tests__/shortcuts-registry.test.ts`, `hotkeys-sequences.test.tsx`, `components/views/__tests__/list-keyboard.test.tsx`, `components/email/__tests__/reply-target.test.ts`
