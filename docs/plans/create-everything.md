# Create everything the same way

Owner, 11-22: "match the macro experience when it comes to creating new entities, right now
the UX for creating new i.e. actions, sheets, doc, project is all over the place but I think
macro does a good job at this so lets also adopt that".

This is a clean-room match of the behaviour Macro's public docs describe (docs.macro.com). No
code or assets come from Macro's repository (AGPL), and no dependency was added.

## The behaviour

- **One Create menu.** It opens with **C** and the rail's **+**. It lists every type the
  workspace can make, grouped as the rail groups its pages. Type to filter, then press ↵ or
  click a type (`components/create/create-menu.tsx`).
- **C then a letter goes straight to a type's composer.** The menu reads the letter as its
  first key, within the G sequences' window (1.5 s), while its search is empty. After that,
  letters filter as typing does. Each row shows its letter, and the ? sheet has a **Create**
  section (`lib/create/create-keys.ts`, `lib/shortcuts.ts` `CREATE_SHORTCUTS`).
- **Every New button opens the same composer, preset to its type and its place**
  (`openCreateDialog({ type, context })`, `lib/create/open-create.ts`).
- **The composer:** a title first, then the type's key properties as chips, then an optional
  description.
  - Action: team, status, priority, assignees, project, labels, cycle, plus due date,
    estimate and milestone.
  - Project: status, priority, lead, initiative, start and target dates.
  - Contact: email, phone, title, company, relationship, LinkedIn.
  - Quick types keep their one extra field: a company's domain, a channel's topic.
  - A table's starters are a choice inside the composer.
- **Keys:**
  - ↵ in the title creates the record and opens it, as the app opens that kind.
  - ⌘/Ctrl ↵ anywhere creates it and keeps the composer open for another. The place and the
    picked chips stay; the title and description clear. This replaces the old "Create more"
    switch with a "Create another ⌘↵" button.
  - Esc cancels.
  - Email is unchanged: ⌘↵ sends.
- **"Create in <name>".** Opened from a place, the composer shows a chip naming it, and the
  new record is linked to that place. × on the chip makes the record without the link
  (`lib/create/create-context.ts`):

  | Opened in | Action | Project | Doc | Contact | Channel |
  |---|---|---|---|---|---|
  | a project | belongs to it (`project_id`) | | lands in it (`project_id`) | | |
  | an initiative | about it (`about`) | belongs to it (`initiative_id`) | | | |
  | a team | on its board (`team_id`) | | | | the team's (`teamId`) |
  | a company | about it | | | works there (`company_id`) | |
  | a contact | about them | | | | |
  | a deal | about its pipeline row | | | | |

- **Quick create from context.** "Make a task" on an email thread and on a team-chat message
  opens the action composer. Its title is prefilled the way the old one-click task was
  ("Follow up: <subject>", the message's opening). On create, the task links back to its
  source through the actions route's existing `about` (fenced by
  `lib/entities/task-about.ts`). The one-click path (`makeTaskFromEntity`) stays for the
  entity menu's "Make a task", which is a menu action, not a form.

Every type still goes through its own route and its own checks. No route changed except the
two additive fields below, and nothing was added to the database.

## Entry points before the change

Found by searching for "New …", "Create …", "Add …", `<Plus`, `setCreating(true)` and the
POST routes. "Kept" means left as it is, on purpose.

| Where | Makes | Before | After |
|---|---|---|---|
| Rail `+` (`rail/app-rail.tsx`) | anything | dialog on Action | the Create menu |
| `c` anywhere | anything | dialog on Action | the Create menu, or C then a letter |
| Mail's New email and `c` on Mail (`email-layout.tsx`) | email | dialog on Email | unchanged (Mail's C stands in for Create) |
| Tables header "New table", empty state (`views/tables-view.tsx`) | table | inline "Name the table" row with Make table and starter cards | composer on Table, starters as chips inside it |
| Deals header "New pipeline" (same view, `pipelines`) | pipeline | inline form with a name and a record kind | **kept** (a pipeline is not a Create type; see the decisions) |
| Spreadsheets header and empty state (`views/spreadsheets-view.tsx`) | spreadsheet | POSTed an untitled one at once | composer on Spreadsheet |
| Canvases "New canvas" and "Make your first canvas" (`chat-cards/pages/canvases-card.tsx`) | canvas | POSTed an untitled one at once | composer on Canvas |
| Team chat: Channels +, "Start your first channel", empty state, side panel's + (`team-chat-view.tsx`, `page-panel/team-chat-panel.tsx`) | channel | its own New channel dialog (name, topic, team) | composer on Channel, "Create in <team>" when started from a team's list |
| Calendar header "New event" (`calendar/components/header/calendar-header.tsx`) | event | its own draft popover | **kept**: the popover is tied to the visible date and slot (see the decisions) |
| Calendar slot click and drag | event | the same popover | kept |
| Email thread "Make a task" (`email/email-thread-detail.tsx`) | action about the thread | POST at once, then opened | composer on Action, prefilled, linked back |
| Team-chat message "Make a task" (`team-chat-view.tsx`) | action about the message | POST at once, then opened | composer on Action, prefilled, linked back |
| Entity menu "Make a task" (`entities/entity-actions-menu.tsx`) | action about a record | POST at once, with an Open toast | kept (a one-click menu action) |
| Project detail | action | no button | "New action" opens the composer, "Create in <project>" |
| Initiative detail | project | link picker only | "New project" opens the composer, "Create in <initiative>" |
| Company detail | action, contact | no buttons | "New action" and "New contact" open the composer, "Create in <company>" |
| Action detail "Add sub-action" (`action-detail-panel.tsx`) | sub-action | inline composer in the panel | kept (it is already a composer, inside its parent) |
| Project detail "Add milestone" | milestone | a name popover | kept (a milestone is its project's) |
| Agents / skills, sequences, prospect lists, campaigns, booking links, Studio video, flows | those | their own multi-step editors | kept. The menu opens each page on its own create flow (`lib/create/page-create.ts`), as before |
| Deals board lane "+ New", grid and gallery "New" (`components/tables/*`) | a pipeline or table row | inserts a row in place | kept (a row is made inside its table) |
| Knowledge "Promote" (`knowledge-view.tsx`, `knowledge-library.tsx`) | package | its own dialog with live rules from the filter | kept (it carries the filter); a blank package is in the menu |
| Studio's project chooser | Studio project or video | its own chooser | kept (shape and recording choices) |
| Teams, labels, views, forms, cycles, SEO trackers, workspaces | setup | their own forms | kept: setup, made where it is set up, as `create-types.ts` already says |

The list, board and group-header inline creates for actions, projects, initiatives, contacts,
companies and docs had already gone before this change. The group header's `+` in
`components/views/view-list.tsx` had no handler and still has none (see the decisions).

## Route changes

These are minimal and additive:
- `QUICK_CREATE.table` now sends a starter's `template`. The route already took one.
- `QUICK_CREATE.document` sends `project_id`, which the route already took.
- `QUICK_CREATE.channel` sends `teamId`, which the route already took.

No route itself changed.

## Decisions to review

1. **C now opens the Create menu, not the action composer.** That is Macro's model.
   C then A is the action composer in two keys. The rail's + opens the menu too.
2. **The letters** (C then …):
   - A action, P project, I initiative, D doc, T table, S spreadsheet, N canvas (Macro's),
     E event, M email.
   - O contact and B company, mirroring G O and G B.
   - L deal, G channel (Macro's), F flow, U agent, K knowledge package.
   - Skill, sequence, prospect list, campaign, booking link and the Studio types have no
     letter; they are a filter away.
   - Letters are read only by the open menu, so they cannot clash with a task's A, P, S, L
     keys or with the G sequences. The registry test checks this (`continues: 'create'`).
3. **"Create more" became ⌘↵.** The switch is gone. The "Create another ⌘↵" button does the
   same thing.
4. **↵ opens what was made**, as Macro does. Before, the dialog closed and showed a toast.
5. **No Drive folders.** The app has no folder or group record for docs or files: no table
   and no route. "Create in …" therefore means a project (docs and actions land in it), an
   initiative, a team, a company, a contact or a deal. Adding folders would need a migration
   (685) and was out of scope for a UI unification.
6. **A project's Priority (11-22, migration 691).** The composer has Macro's Priority chip
   for a project: the actions' pill and the actions' five values (none, low, medium, high,
   urgent; `lib/projects/priority.ts`). The project card shows it and sets it, under Status.
   - The update route already wrote `projects.priority`, and DEV had the column, but no
     migration made it. 691 adds it where it is missing (text, nullable: null is none set),
     puts right any stored value the check would refuse (a value in another case or with
     spaces becomes that value; anything else becomes null), and adds
     `projects_priority_check` with the five values or null.
   - Both routes now take only one of the five values, or null to clear it, and answer 400
     to anything else. Nothing else about a project changed: no policy, trigger or function.
   - Macro's "Assignees" maps to the project's Lead, which is the one person field the
     route takes.
7. **A doc made on a company or deal page is not linked to it.** No route links a doc to
   a company. Actions (`about`) and contacts (`company_id`) are linked.
8. **Kept outside the composer, on purpose:**
   - The calendar's slot and draft popover, because it is placed on the grid at the chosen
     time.
   - "New pipeline", because a pipeline is not a Create type.
   - Sub-actions and milestones, because each is made inside its parent.
   - Knowledge's "Promote", because it carries live rules.
   - The multi-step editors (agents, sequences and the rest), because each has its own setup.

   Each could move later.
9. **The entity menu's "Make a task" stays one click.** The email and chat buttons, which
   the owner named, open the composer instead.
10. **The group header's `+` in list views opens the composer** (on branch
    `claude/create-everything-2`). It makes a record of the list's kind, and an action starts
    in the group: its status (and that status's team), priority, project or assignee
    (`lib/create/group-create.ts`), and an outer group's value is kept in a subgroup. A list
    of something the composer doesn't make, such as captures, shows no `+`.
11. **Email is Mail's composer.** Resolved on 11-22: mail phase 3 (#228) put
    `components/email/email-composer.tsx`, with Send later, Save draft, Undo and files,
    into the Create dialog's Email entry. C then M and the Create menu open it. Its own
    keys apply (⌘↵ sends); the dialog's "Create another" key leaves it alone.
