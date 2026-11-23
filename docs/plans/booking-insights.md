# Booking insights: booking links you can run a business on

Branch `claude/booking-insights`. Reserved migration: **705**.

The goal: a list of bookings (attended and no-show), insights over a range, the
link settings that are still missing, and a form in front of a link that
qualifies guests before they book. The behaviour follows Macro's public
booking-link docs (product pages only, read for behaviour). It is built from
scratch on what we already have. No Macro code, CSS, wording or assets.

## What already exists (and is extended, not rebuilt)

| Asked for | Today | So |
|---|---|---|
| Guests' links to reschedule or cancel | `/b/<token>` (`src/lib/time-offers/manage.ts`, `src/app/b/[token]`): cancel, and move by the link's own rules | Nothing new. The Bookings tab links to it from each booking's guest line. |
| Minimum notice, booking window | `booking_link.notice_minutes`, `window_days`, in the API, the tools and the dialog | Nothing new. |
| Daily limit | `booking_link.daily_cap` in the schema, API, tools and times (`times.ts`) | Only the dialog's field is missing: added. |
| A link's own weekly hours | `booking_link.weekly_hours` + `time_zone` in the API and times | Not in the dialog: added there with the date overrides. |
| Date overrides | The host's dated days off apply to a link's own week; the host's own dated hours apply when the link follows their working hours | **Missing:** dated changes of the link's own week. New column. |
| Bookings | `meeting_booking` (source `link`), listed only inside `list_time_offers` (the host's own, 30 days) | A Bookings tab and API, read by the same rule (below). |
| Forms | `data_form` (660), one row per submission through `handleFormSubmit` | The booking page submits through that same pipeline, then checks the link's condition. |
| Charts | Our own SVG (`src/components/spreadsheets/charts/chart-view.tsx`, `niceTicks` / `compactNumber`) | The insights charts use the same helpers. No chart library. |

## Who sees a booking (never wider than today)

`meeting_booking` is service-role only. Today a person reads a link booking
only when they are its host (`list_time_offers`: `host_user_id`). The new
reads keep that: **a person sees a booking when they are its organizer
(`host_user_id`) or an attending host (`other_host_ids`)**. A workspace
owner or admin does not see a teammate's bookings, even on a team link
they can edit (see Decision 1). Insights count only those bookings. The
"filter by link" list offers the links the person hosts. Every read is
fenced by workspace and by that rule in one query
(`host_user_id.eq.<me>,other_host_ids.cs.{<me>}`), tested.

## Phases

### 1. Bookings tab
- `src/lib/booking-links/bookings.ts` (pure helpers plus reads):
  `listLinkBookings(supabase, { workspaceId, userId, view: upcoming|past|cancelled, q, linkId, cursor, limit })`.
  - **Upcoming:** live (`requested`, `booking`, `confirmed`) and not yet ended, soonest first.
  - **Past:** `confirmed` and ended, newest first.
  - **Cancelled:** `cancelled`, `declined` or `expired`, newest first.
  - Search matches the guest's name, email or the title (`ilike`, the pattern escaped).
  - Filter by link id.
  - Keyset paging on (starts_at, id).
  - Sources: `link` only.
- `PATCH /api/account/bookings/<id>/attendance { attendance: 'attended' | 'no_show' | null }`.
  - Allowed only for a booking the person sees, that is `confirmed` and has started.
  - Written as `attendance`, `attendance_marked_at` and `attendance_marked_by` (migration 705).
- `GET /api/account/bookings?view=&q=&link=&cursor=`
- Page: **Settings › Availability** gets tabs "Links · Bookings · Insights"
  (`src/app/account/settings/availability/`). Bookings is a list grouped by
  day: time, guest, link, state and the attendance chips on past ones.
- Guests' reschedule and cancel: already there (above).

### 2. Insights
- `src/lib/booking-links/insights.ts` (pure: `bookingInsights(rows, { from, to, timeZone, bucket })`)
  plus a read: one query over the person's link bookings with `starts_at` in
  the range, capped at 5,000 rows (a note when the cap is hit).
- Range: 7, 30 or 90 days, or custom (at most 366 days). Buckets are local
  days in the viewer's zone; weeks for ranges over 90 days.
- Measures:
  - **Bookings over time:** booked (confirmed), cancelled.
  - **Meeting hours:** confirmed bookings' length, no-shows left out.
  - **No-shows:** count, and rate among the marked ones.
  - **Top links:** bookings and hours per link, top 5.
- `GET /api/account/bookings/insights?from=&to=&tz=`
- `GET /api/account/bookings/export.csv?from=&to=`: one row per booking.
  - Cells a spreadsheet would run as a formula (`= + - @`, tab, CR) are prefixed with `'`.
  - Guests' words are untrusted.
- UI: four stat tiles and two small SVG charts (columns for bookings over
  time, bars for top links), theme tokens for light and dark.

### 3. Link settings (only what's missing)
- The dialog gains:
  - **Daily limit**, `daily_cap`: existing column.
  - **Own hours**, `weekly_hours` and `time_zone`: existing columns. The
    picker reuses the working-hours editor's row component.
  - **Date overrides**: new `booking_link.date_overrides` jsonb, `{ "YYYY-MM-DD": [{start,end}] }`.
    An empty list is a day off. At most 60 dates, past dates dropped on write.
- `times.ts`: when a link has its own week, its `date_overrides` replace that
  date's hours. The host's own days off still apply on top (today's rule).
- New links starting paused: **recorded as a decision, not changed**
  (Decision 7). New links stay `active: true`.

### 4. A form in front of a link
- New columns:
  - `booking_link.form_id`: the gate, references `data_form`, `on delete set null`.
  - `form_rule`: jsonb `{ all: [{ field, op, value }] }`, at most 5 conditions.
  - `form_refusal`: text, at most 500 characters, the polite message.
- Ops, by the field's column type:
  - `equals`, `not_equals`, `contains` (text and email);
  - `in` (a select's options);
  - `gte`, `lte` (number and currency);
  - `is_true`, `is_false` (checkbox).
  - An empty rule passes everyone who submits.
- Attaching a form:
  - The editor must be able to CHANGE its table (the forms rule, `tableEditRefusal`).
  - Same workspace.
  - Its access is `public`. A members-only or invited form is refused: the link page is a public door.
  - It takes no files: the booking page posts JSON (Decision 10).
  - Settings picks from `GET /api/account/booking-links/forms`. It lists only
    the forms the person may use, each with the fields a rule can check.
- Guest flow on `/book/<handle>/<slug>`:
  1. The page shows the form's fields (from the form's public shape) before the times.
  2. The submit goes to `POST /api/public/booking-links/<h>/<s>/qualify`.
     That route runs the **same** `handleFormSubmit` pipeline (caps, bot
     check, validation, contact, the row written as the form's maker, loops)
     with the form found by the link's `form_id`, not a key. So **the
     answers land in the form's table as today.**
  3. Then the link's rule is checked against the parsed values, server-side.
     - Pass: a pass token (HMAC over link id, row id and expiry; 2 hours).
       The page shows the times.
     - Fail: `form_refusal`, or a default polite line. No times.
  4. `POST …/book` requires a valid pass for a gated link (403
     `FORM_NEEDED` without one). Once booked, it records
     `meeting_booking.form_row_id`, best effort, by a plain update.
     `write_meeting_booking` is not redefined.
  - No calendar is read for a guest who hasn't qualified: the page asks for
    times only after the pass.
  - The page reuses the forms page's own renderer (`OpenForm` in
    `src/app/f/[key]/form-view.tsx`), given an endpoint, a done callback and
    no outer frame. Its bot check comes from `…/qualify/challenge`.
- The form's key is stored only as a hash, so the link can't hand guests the
  form's own address. That's why the booking page posts through its own route.

### 5. Agents
- New read tools in `src/lib/ai/tools/booking-links.ts`, registered as `read`:
  - `list_link_bookings`: the Bookings tab's read, guests' words wrapped as untrusted.
  - `get_booking_insights`: the same numbers as the tab.
  - Same visibility rule.
- `mark_booking_attendance` (`internal-write`, undoable, attended only).
- `create_booking_link` and `update_booking_link` take the new fields
  (`daily_cap` already, `date_overrides`, `form_id`, `form_rule`,
  `form_refusal`). How they ask first stays exactly as today (see Decision 8).
- Registry and schema tests follow the existing tool-policy tests.

## Built so far

All five phases are code complete and tested. They wait on migration 705's
OK, because every read of `booking_link` and of a booking's attendance names
705's columns.

- Phase 1:
  - `src/lib/booking-links/bookings.ts`, `bookings-api.ts`;
  - `/api/account/link-bookings` (list, attendance);
  - `link-bookings-panel.tsx`, and the tabs in `availability-settings-view.tsx`.
- Phase 2:
  - `src/lib/booking-links/insights.ts`;
  - `/api/account/link-bookings/insights` and `/export`;
  - `link-insights-panel.tsx`.
- Phase 3:
  - daily limit, own hours and dated changes in the dialog
    (`booking-link-form.ts`, `link-hours-editor.tsx`);
  - `date_overrides` through input, links, store, view and `times.ts`
    (`ownWeekOverrides`).
- Phase 4:
  - `form-rule.ts` (pure), `form-gate.ts`;
  - `…/qualify` and `…/qualify/challenge`;
  - the pass check in `public.ts`;
  - the form step in `link-view.tsx`;
  - `link-form-gate-editor.tsx`, `/api/account/booking-links/forms`.
- Phase 5:
  - `list_link_bookings`, `get_booking_insights`, `mark_booking_attendance`
    in `src/lib/ai/tools/booking-links.ts`;
  - registry, attended-only and MCP lists, the outside-text fence, step
    phrases, labels and eval classes.

## The managing session's conditions (OK given 11-23), and where each is met

1. **The link's form:**
   - The route checks it (`formGateRefusal`): same workspace, `public`, on,
     no files, a table the editor can change (so can read).
   - The database checks it too: the `booking_link_form_guard` trigger keeps
     the form to the link's own workspace, and `booking_link_form_shape` to a
     meeting link.
   - `form_rule`'s shape is checked twice: zod `z.enum(FORM_RULE_OPS)` in
     the app, and the database's jsonpath check, which refuses an unknown op
     and a condition without a field.
2. **The pass:** bound to the link, the form row and an expiry; books once
   (Decision 5).
   - Tests: `book.test.ts` "a pass books once", including the race;
     `public.test.ts`, the same pass again is 409 `PASS_USED`;
     `supabase/tests/705_booking_insights.sql`.
3. **The secret:** derived, no new setting (Decision 5).
4. **Abuse:** `/qualify` is `handleFormSubmit` itself, so the public form's
   protections apply unchanged:
   - 10 tries per sender per hour across every form, and 60 per form per
     hour;
   - the honeypot;
   - the form's bot check when it is on;
   - the origin rule;
   - the field checks and the submission-id repeat rule.
   - Its challenge GET counts against the form reads' 30 per sender per
     minute.
   - The booking itself keeps `/book`'s caps:
     - 5 per client per hour;
     - 30 per link per hour;
     - 2 per guest per link per day;
     - its honeypot.
5. **Attendance:**
   - Only the organizer or an attending host marks it (`seenBy`, on the read
     and on the update), only on a confirmed booking that has started.
   - The database refuses a mark before the start, keeps the three columns
     together, and drops the mark if the booking leaves confirmed.
   - Who marked it is `attendance_marked_by`.

## Migration 705

`705_booking_insights.sql`, with its own `begin; … commit;`: apply it
WITHOUT `--single-transaction`. No new table. Tested on a local Postgres 17
(baseline, seed and every migration through 693, then 705 twice), with
`supabase/tests/705_booking_insights.sql` (29 checks) and the existing
booking DB tests (585) passing. Its contents:
- `meeting_booking.attendance`: text null, check `in ('attended','no_show')`.
  A check `attendance is null or state = 'confirmed'`.
- `meeting_booking.attendance_marked_at` (timestamptz null) and
  `attendance_marked_by` (uuid null, references `auth.users`, `on delete set null`).
- `meeting_booking.form_row_id`: uuid null. No foreign key: rows live in the
  tables store, and a row deleted later leaves the booking.
- `booking_link.date_overrides`: jsonb null, check `jsonb_typeof = 'object'`.
- `booking_link.form_id`: uuid null, references `data_form(id)`, `on delete set null`.
- `booking_link.form_rule`: jsonb null, check object.
- `booking_link.form_refusal`: text null, check `char_length <= 500`.
- An index `meeting_booking (host_user_id, state, starts_at)` for the tab and insights.
- A unique partial index `meeting_booking (form_row_id) where form_row_id is not null`.
- `write_meeting_booking` restated with `form_row_id`. Its body is 581's
  otherwise (a test pins it word for word), and only the service role may
  execute it.
- The jsonpath check on `form_rule`, and the `booking_link_form_guard`
  trigger (the form's workspace; no form, no rule).
- RLS:
  - Both tables already have RLS on and `revoke all` from anon and
    authenticated (554 and 581); nothing is granted.
  - Writes are the service role's, through the app's handlers.
  - A `before update` guard on `meeting_booking` (the 359/369/675 style)
    keeps the attendance columns written only together, and only once the
    booking has started.
- Applied only to a local Postgres (never the dev project, never production).

## Decisions to review

1. **Bookings are seen by their hosts only.** Owners and admins don't see a
   teammate's link bookings, even on a team link they can edit. Showing them
   would widen today's rule; it's the owner's call.
2. **Who marks attendance:** any attending host, on a confirmed booking that
   has started. It can be changed or cleared later.
3. **Insights count by start time** in the range. Meeting hours leave out
   no-shows and anything not confirmed.
4. **Buckets use the viewer's zone** (sent by the browser), not the link's.
5. **The pass is stateless but books once** (the managing session's change,
   11-23).
   - It is an HMAC over the link id, the form row and an expiry, good for
     2 hours.
   - Its key is derived from the server's existing secret
     (`oauthStateSecret`) under its own purpose label
     (`native-intelligence/booking-form-pass/v1`, `passKey`). No new setting.
   - The row goes into the booking's own insert (`write_meeting_booking`,
     restated in 705 with `form_row_id`).
   - A unique partial index on `meeting_booking.form_row_id` refuses a second
     booking, even when two race side by side. It answers 409 `PASS_USED`:
     "This pass has already been used; answer the form again."
   - A double click (the same guest at the same time) is still the booking
     it made.
6. **A form gate takes a `public` form only.** It is always the form's own
   pipeline, and the answers are written even for a guest who doesn't qualify.
7. **New links start on, as today.** Starting them paused would stop a
   shared link working until someone turns it on; left for the owner.
8. **Agent link changes:** today `create_booking_link` and
   `update_booking_link` are internal writes with no approval card. The chat
   shows the link card with every detail after the change, and they are
   attended only. The brief says "asks first, as today": the behaviour is
   kept exactly. Adding a form gate through the agent is the same kind of
   write. Making either an approval card is a policy change for the owner.
9. **Agents get `mark_booking_attendance`** as an internal, undoable write.
   Drop it if agents should only read.
10. **A form that takes files can't gate a link.** The booking page posts
    JSON. Files would need the intake's multipart upload path here too.
11. **Answers to a gate form are stored before the rule is checked**, so the
    owner sees everyone who asked, qualified or not (the brief: "answers land
    in the form's table as today").

## New dependencies

None.
