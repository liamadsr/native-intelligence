# Keyboard shortcuts

The owner, 2026-11-20: "Like Linear, everything has a shortcut. You should be able to open
any page with a dedicated shortcut that makes sense. If there are shortcuts that are well
established, like C for create, use and prioritize those, and come up with new ones for
the ones that need one. I think Linear does the G+M kind of thing for 'go to mail'… let's
do the best practice on that front."

Status: **phase 1 is built** (go-to sequences, the `?` sheet, the registry and its conflict
test, the hints in the rail's tooltips). **Phase 2 is a proposal** waiting on the owner (the
contextual keys in lists, the task panel and Mail, and `[` / `]` in a page group).

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
| G D | Docs | Docs, the Drive group's first page |
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

## Phase 2: contextual keys (a proposal, not built)

These are kept to what Linear, Gmail and Superhuman have made habits. They need a keyboard
focus model in the list and board views first: today there is none, only mouse checkboxes
(`hooks/use-bulk-selection.ts`). They also need the row and panel pickers (status, priority,
assignee, labels, due date) to be openable from code, since each keeps its own `open` state
today.

**In any list or board (tasks, projects, contacts, captures…)**
| Keys | What |
|---|---|
| J / K (and ↓ / ↑) | Move the focused row |
| Enter or O | Open the focused row |
| X | Select or unselect the focused row (⇧X: select the range to it) |
| Esc | Clear the selection, then put the page away |
| C | Create here, with the list's context filled in (its team, project or status) |

**On the focused row(s), or the open task panel** (Linear's letters)
| Keys | What |
|---|---|
| S | Set status |
| P | Set priority |
| A | Assign |
| I | Assign to me |
| L | Labels |
| ⇧D | Due date |
| ⇧H | Remind me (exists) |
| ⌘C | Copy the task's id or link while nothing is selected as text (TBD) |

**Mail** (Gmail's and Superhuman's)
| Keys | What |
|---|---|
| J / K | Next and previous thread, in the list too (today only with a thread open) |
| Enter or O | Open the thread |
| E | Archive |
| R | Reply |
| A | Reply all |
| F | Forward |
| U | Mark unread |

**In a page group** (Drive, Calendar, Contacts, Outreach, SEO, Agents): `[` and `]` for the
previous and next page in its sub-nav. This also gives SEO's eight sections a key each way.

**Buttons:** the button for each of these shows its keys in its tooltip, as the rail does.

Keys left out on purpose: deleting from the keyboard (# or Delete in Mail, Backspace on a task)
can't be undone in one key. ⌘F stays the browser's. Bare digits are left free.

## Files

- `web/src/lib/shortcuts.ts`: the registry (`GO_TO`, `SHORTCUTS`, `RESERVED_KEYS`, `findShortcutConflicts`)
- `web/src/lib/hotkeys.ts`: `useHotkeys`, now with sequences (`after`) and `globalGuard`
- `web/src/app/account/(dashboard)/shortcuts/`: the go-to handler, the sheet and its opener
- `web/src/app/account/(dashboard)/rail/app-rail.tsx`: the go-to hint in each icon's tooltip
- `web/src/app/account/workspace-switcher.tsx`: "Keyboard shortcuts" in the workspace menu
- Tests: `web/src/lib/__tests__/shortcuts-registry.test.ts` and `hotkeys-sequences.test.tsx`
