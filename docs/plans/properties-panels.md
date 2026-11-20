# Properties panels: one frame for every detail page

Status: built on `claude/properties-panels` (2026-11-20). Not merged, not rolled out.

The properties panel is the right-hand column of a record's page: its fields
(`WindowProperties`) and, under them in a card, the page's verbs
(`WindowActions`). It had grown a row at a time. An empty action showed eleven
property rows, eight of them placeholders ("Due date", "Estimate", "Add label",
"No attachments", "Set project", "Add link", "Link document", "Link pull
request"), then a History list, then seven verbs. Each panel had its own order.

The rule for this change: **nothing is removed.** Every field, control and verb
below is still there, does what it did, and is reached in the same number of
clicks unless the "What costs a step" section says otherwise.

## The frame

Top to bottom, the same on every panel:

1. **Core rows.** What state the record is in and whose it is: status,
   priority, assignee, lead, owner; for a capture, when it was and who was in
   it. Always a row, set or not.
2. **Set rows.** Every other property that has a value: a full row, in a fixed
   order (dates and sizing, labels, then what it belongs to and what is linked
   to it).
3. **The add strip.** Every other property that has no value: one small chip
   each ("Due date", "Estimate", "Add label", "Set project", "Attach file",
   "Add link"…), wrapping across as few lines as they need. A chip is the
   field's own trigger, restyled: one click opens the same picker the row did.
   When the value arrives the chip becomes a row; when it is cleared, a chip
   again. A list that can take more (labels, documents, linked actions) keeps
   its "add" chip in the strip while its list is a row above.
4. **The record's own groups**, where it has them, with their heading
   ("Projects" on an initiative, "Enrichment" on a contact, "Source" on agent
   work, "Tags" on a capture).
5. **Custom fields**, then **Referenced in** (both already render nothing when
   empty).
6. **History**: one row, "History · <latest event> · <when>", that opens the
   list. It was the full list (up to 12 two-line entries), always open.
7. **Verbs.** The page's primary verbs as rows (a toolbar of icons when the
   page stands alone), then **More actions** last. More holds the kind's menu
   as before (Copy link, Copy ID, Share to channel, Make a task, Archive) and
   now also the page's secondary verbs, which were a button each: Move to
   workspace, Copy as prompt, and Delete (last, after a separator, in red).

No "Properties" heading over the main group. It was already hidden in a card
(`[data-properties-heading]`), and `property-group.tsx` says the main group
omits it. The prospecting panel keeps its headings: it has three groups, and
the headings are what tell them apart.

### How it is built

- `components/views/property-layout.tsx`: `PropertyRows` (the list),
  `PropertyRow` (a full row), `OptionalProperty set={…}` (row when set, chip
  when not). The chip is CSS over the field's own empty-state trigger, so there
  is one implementation of each field. A field keeps its place in the React
  tree whether set or not (CSS `order` moves it), so a picker that is open
  while its value arrives stays open: a date picked, then its time.
- `components/views/properties/optional-text-property.tsx`: the same for a
  typed field (a contact's job title, a company's website): a chip that opens
  the row's input, focused; the row stays while it has a value or the focus.
- `EntityActionsMenu` takes `extra`: the page's own verbs, under the kind's.
  `useMoveToWorkspaceItem` is Move to workspace as one of them.
- `RecordHistoryList` is the one-row History. `AttachmentsCarousel` gains
  `emptyAs="add"` (an "Attach file" chip instead of the "No attachments" row).

## Earlier decisions this keeps

- Properties in the card's popover, or its right-hand column when full screen;
  fields first, verbs under them (Liam, 10-19). Unchanged.
- "One Properties group" on a contact, and labels, attachments, project, links,
  repository and activity as rows rather than groups of their own. Unchanged:
  the frame is one group.
- The capture's Agent and Packages are property rows (Liam, 11-20, PR #193).
  Kept as rows. Agent is a core row; Packages shows in the same cases as before.
- "Find email" on a contact's empty email field (Liam, 2026-09-10). The email
  row is a core row for that reason: always shown, with the button.
- A project's milestone nested under its project row. Kept.
- The push-to-tracker compose form in the action's column, and the lock that
  keeps the column open while it is up. Untouched.
- The property lens (a linked ticket's live fields in place of ours). Untouched.
- Prospecting: "the same plan as the CRM page" (Liam, 2026-09-06). Its sidebar
  is read-only facts that already show only when known; left as it is.

## Departures, and why

- **History is closed by default.** It was the tallest thing in most panels
  and grows with every edit. The row still shows the latest event.
- **Delete, Move to workspace and Copy as prompt sit under More.** They are
  rare or destructive, and they were three of the seven rows under an action.
- **"Relations" on an action** was a button with no behaviour. It is kept, as
  a greyed item under More ("Not available yet"), rather than dropped.
- **Typed fields on a contact or company are chips while empty.** They were
  placeholder inputs you could click straight into; now the chip is clicked
  first (it opens focused, so it is still one click then type).

## What costs a step (for the owner to confirm)

1. **Delete** is More → Delete (then the same confirmation) instead of its own
   button. Two clicks where it was one.
2. **Copy as prompt** on an action is More → Copy as prompt.
3. **Move to workspace** is More → Move to workspace….
4. **History** needs a click to read past the latest event.
5. A capture's **"No attachments +"** row and an action's are now an "Attach
   file" chip: the same single click, but the words "No attachments" are gone.

Everything else is the same number of clicks.

## Inventory and layout, per entity

"Was" is the order on `main` (with PR #193 for captures). "Now" is the layout.
Conditions are unchanged unless stated.

### Action (`views/action-detail-panel.tsx`)

Was, properties: lens switcher (only when linked to a tracker) · Status ·
Priority · Assignees (people and the delegate agent) · Due date · Estimate ·
Cycle (only when the team has cycles) · labels list (when any) · Add label ·
Attachments ("No attachments" +) · Project · Milestone (only with a project) ·
Links ("Add link", expands to the list and a paste box) · documents list (when
any) · Link document · Repository (read-only, from the project) · Pull requests
("Link pull request", expands) · push-to-tracker compose (while composing) ·
upload error · Custom fields · Referenced in · History.

Was, verbs: Saving… · Listen brief (no button) · More actions · Remind me (⇧H) ·
Start where / Start with / Start (only with an agent assigned; a spinner that
opens the run while working; a PR mark when one is open) · Task app options ·
Relations · Move to workspace (two or more workspaces) · Delete action · Copy
as prompt.

Now, properties:
- Core: Status, Priority, Assignees. (Under a tracker's lens: the ticket's
  fields, as before.)
- Optional, in this order when set: Due date, Estimate, Cycle, labels,
  Project (+ Milestone), Repository, Attachments, Links, documents, Pull
  requests.
- Add strip: Due date · Estimate · Add to cycle · Add label · Set project ·
  Attach file · Add link · Link document · Link pull request.
- "Add link" and "Link pull request" open their row with the paste box focused.
- Then compose, upload error, Custom fields, Referenced in, History.

Now, verbs: Saving… · Remind me · Start where / with / Start · Task app
options · More actions (Copy link, Copy ID, Share to channel, Make a task; Copy
as prompt, Relations, Move to workspace…; Delete action).

### Capture (`views/capture-detail-panel.tsx`)

Was, properties: Date · Duration (when known) · Call recording (a team call
with one saved) · Call audio (when files exist) · Project · Event link ("Link
event", with unlink) · Agent (locked to the live persona while recording; ⓘ for
assist-only) · Packages (live mode, before or during the call) · Participants
(count, expands; add) · labels list · Add label · Attachments · Activity
(created/updated, expands) · transcription warning (while recording and not
connected) · Tags (when any) · Referenced in · History.

Was, verbs: Visibility (creator, shared workspace) · Capture history (a
recurring meeting with other sessions) · Resume recording (not while recording,
not a call's capture) · "Finishing the notes…" · Reprocess capture (not while
recording) · Draft follow-up email (after processing, with confirmed items) ·
More actions · Copy transcript · Share · Move to workspace (two or more
workspaces) · Delete capture.

Now, properties:
- Core: Date, Duration, Call recording, Call audio, Agent, Participants.
- Optional, when set: Project, linked event, Packages, labels, Attachments.
- Add strip: Set project · Link event · Add packages (same cases as before) ·
  Add label · Attach file.
- Then Activity, the transcription warning, Tags, Referenced in, History.

Now, verbs, in the order they had: Visibility · Capture history · Resume
recording · "Finishing the notes…" · Reprocess capture · Draft follow-up email ·
Copy transcript · Share · More actions (the kind's; Move to workspace…; Delete
capture).

Reprocess stays a row: it shows the extraction's progress and is disabled
while one runs.

### Project (`views/project-detail-panel.tsx`)

Was, properties: Status · Lead · Start date · Target date · Initiative ·
Repository (linked, or "Link remote repository") · Environment (linked or "Link
environment", and "Run my work here on <Mac>" when there is one) · Custom
fields · Referenced in · History.

Was, verbs: Saving… · More actions · Remind me · Move to workspace · Delete
project.

Now, properties:
- Core: Status, Lead.
- Optional, when set: Start date, Target date, Initiative, Repository.
- Add strip: Start date · Target date · Set initiative · Link remote
  repository.
- Environment stays a row, under the add strip (it carries the Mac switch and
  its hints).
- Then Custom fields, Referenced in, History.

Now, verbs: Saving… · Remind me · More actions (the kind's; Move to
workspace…; Delete project).

### Initiative (`views/initiative-detail-panel.tsx`)

Was, properties: Status · Owner · Target date · Color · Add label · label
badges (when any) · group "Projects": Link project, linked projects (with
unlink) · Custom fields · Referenced in · History.

Was, verbs: Saving… · More actions · Remind me · Move to workspace · Delete
initiative.

Now, properties:
- Core: Status, Owner.
- Optional, when set: Target date, Color, label badges.
- Add strip: Target date · Set color · Add label.
- "Projects" group as it was.
- Then Custom fields, Referenced in, History.

Now, verbs: Saving… · Remind me · More actions (the kind's; Move to
workspace…; Delete initiative).

### Document (`views/document-detail-panel.tsx`)

Was, properties: Project (a picker; plain text, or nothing, for someone who
can't move it) · Created by · linked actions (count, expands, unlink) · Link
action · Activity · Custom fields · Referenced in · History. (No column at all
when the page has no comment identity: unchanged.)

Was, verbs: Visibility (creator, shared workspace, not a system or Now file) ·
Listen (no button) · Copy text (when it has any) · More actions · Share (not a
Now file) · Move to workspace (not a Now file) · Delete document (a system
document says why instead).

Now, properties:
- Core: Created by.
- Optional, when set: Project, linked actions.
- Add strip: Set project · Link action.
- Then Activity, Custom fields, Referenced in, History.

Now, verbs: Visibility · Share · Copy text · More actions (the kind's; Move to
workspace…; Delete document, which still opens the explanation for a system
document).

### Contact (`views/contact-detail-panel.tsx`)

Was, properties: Type · Strength · Job title · Department · Email (with Find
email when empty) · secondary emails · Add email… · Phone · LinkedIn URL ·
Company · Follow-up date (with Remove date) · group "Enrichment" (after a run) ·
Custom fields · Referenced in · History.

Was, verbs: Add to sequence (Sequences tab, no active enrolment) · Saving… ·
enrichment error · Enrich from web · More actions · Find duplicates · Share ·
Delete contact.

Now, properties:
- Core: Type, Strength, Email (with Find email), secondary emails.
- Optional, when set: Job title, Department, Phone, LinkedIn URL, Company,
  Follow-up date.
- Add strip: Job title · Department · Add email · Phone · LinkedIn URL · Set
  company · Set follow-up date.
- Then Enrichment, Custom fields, Referenced in, History.

Now, verbs: Add to sequence · Saving… · enrichment error · Enrich from web ·
Share · Find duplicates · More actions (the kind's; Delete contact).

### Company (`views/company-detail-panel.tsx`)

Was, properties: Domain · Website · Contact email · Phone · Industry ·
Employee count · Address · City · State · Country · group "Enrichment" · Custom
fields · Referenced in · History.

Was, verbs: Saving… · enrichment error · Enrich from web · More actions · Share
(owner or admin) · Delete company.

Now, properties:
- Core: Domain.
- Optional, when set: Website, Contact email, Phone, Industry, Employee count,
  Address, City, State, Country.
- Add strip: the same ten names, for the empty ones.
- Then Enrichment, Custom fields, Referenced in, History.

Now, verbs: Saving… · enrichment error · Enrich from web · Share · More
actions (the kind's; Delete company).

### Left as they are

These already fit the frame: read-only rows that show only when there is
something to show, and no secondary verbs to fold.

- **Agent work** (`components/work/work-item-detail-panel.tsx`): Status, Kind,
  Teammate, Actor, Started, Duration, Reviewed; group "Source". Verbs: Stop,
  Open run / Run history.
- **Prospect** (`prospecting/entry-panel.tsx`): groups Properties, Prospecting,
  Research; verbs Find people, Enrich, Dismiss, Save to list (company), Add to
  sequence, Publish anyway, Dismiss, Save (person). Its tests pin the three
  headings' order.
- **Evaluation run and suite, sequence** (`evals/run-page.tsx`,
  `evals/suite-detail.tsx`, `sequences/sequence-detail.tsx`): one group of
  mostly read-only rows.
- **Deal** (a pipeline row, `components/tables/row-panel.tsx`): a side sheet
  with one row per column, files, Referenced in and its own History with Undo.
  Not a properties column.
- **Calendar event** (`views/calendar-event-detail-panel.tsx`): one column, no
  properties panel. Giving it one is a separate change.
