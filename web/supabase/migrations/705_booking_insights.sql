-- ============================================================
-- 705: booking insights: attendance, a link's dated hours, a form in front.
-- ============================================================
-- Booking links (581) you can run a business on (docs/plans/booking-insights.md):
--
--   1. meeting_booking.attendance       a host's mark on a confirmed booking
--      (+ attendance_marked_at, _by)    that has started: 'attended' or
--                                       'no_show' (null: not marked). The
--                                       Bookings tab and insights read it
--                                       (src/lib/booking-links/bookings.ts).
--   2. meeting_booking.form_row_id      the form row (a data_row of the
--                                       link's form's table) the guest's
--                                       answers became, when the link had a
--                                       form in front. No foreign key: a row
--                                       deleted later leaves the booking.
--                                       Unique where set: a guest's pass (one
--                                       form row) books once. Written in the
--                                       booking's own insert
--                                       (write_meeting_booking, restated with
--                                       it), so a second booking on the same
--                                       pass is refused atomically.
--   3. booking_link.date_overrides      dated changes to the link's own week
--                                       ({ "YYYY-MM-DD": [{start,end}] }, an
--                                       empty list a day off; at most 60).
--   4. booking_link.form_id, form_rule, a form the guest answers first
--      form_refusal                     (data_form, 660), the rule their
--                                       answers must meet ({ all: [...] }, at
--                                       most 5 conditions, each a field and
--                                       one of the known ops) and the line
--                                       the others read
--                                       (src/lib/booking-links/form-gate.ts).
--                                       A trigger keeps the form to the link's
--                                       own workspace, and a meeting link's;
--                                       taking the form away takes its rule.
--                                       Who may pick it (someone who can
--                                       change its table) is the app's check:
--                                       the database doesn't know the editor.
--   5. An index for the Bookings tab and insights: a host's bookings by state
--      and start.
--   6. A guard on meeting_booking's attendance (the 359 / 369 / 675 style):
--      attendance is set only on a confirmed booking that has started, its
--      three columns move together, and a booking that leaves 'confirmed'
--      drops its mark.
--
-- RLS: both tables keep 554's and 581's: row security on, every right
-- revoked from anon and authenticated, only the service role reads and
-- writes (every reader is on the server, fenced by its handlers). Nothing is
-- granted here.
--
-- Columns, checks, triggers and write_meeting_booking restated with
-- form_row_id (its body otherwise as 581's; create or replace keeps its
-- grants: the service role's alone). No table, no data change. Re-runnable.
-- Must run before the app code that reads it: every booking_link read names
-- date_overrides and the form columns, the Bookings tab names attendance,
-- and a link booking writes form_row_id.
--
-- Has its own begin/commit: apply it WITHOUT --single-transaction
-- (psql -v ON_ERROR_STOP=1 -f 705_booking_insights.sql).

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1, 2. meeting_booking
-- ------------------------------------------------------------

alter table public.meeting_booking add column if not exists attendance text null;
alter table public.meeting_booking add column if not exists attendance_marked_at timestamptz null;
alter table public.meeting_booking add column if not exists attendance_marked_by uuid null references auth.users(id) on delete set null;
alter table public.meeting_booking add column if not exists form_row_id uuid null;

comment on column public.meeting_booking.attendance is
  'A host''s mark on a confirmed booking that has started (705): attended or no_show; null, not marked. Written with attendance_marked_at and attendance_marked_by.';
comment on column public.meeting_booking.form_row_id is
  'The form row the guest''s answers became, when the booking link had a form in front (705). No foreign key: the row may be deleted later.';

alter table public.meeting_booking drop constraint if exists meeting_booking_attendance_check;
alter table public.meeting_booking
  add constraint meeting_booking_attendance_check check (
    (attendance is null and attendance_marked_at is null)
    or (attendance in ('attended', 'no_show') and attendance_marked_at is not null and state = 'confirmed')
  );

create index if not exists meeting_booking_host_state_idx on public.meeting_booking (host_user_id, state, starts_at);
-- One form row books once: a pass reused for a second booking is a unique violation.
create unique index if not exists meeting_booking_form_row_key on public.meeting_booking (form_row_id) where form_row_id is not null;

-- ------------------------------------------------------------
-- 3, 4. booking_link
-- ------------------------------------------------------------

alter table public.booking_link add column if not exists date_overrides jsonb null;
alter table public.booking_link add column if not exists form_id uuid null references public.data_form(id) on delete set null;
alter table public.booking_link add column if not exists form_rule jsonb null;
alter table public.booking_link add column if not exists form_refusal text null;

comment on column public.booking_link.date_overrides is
  'Dated changes to the link''s own weekly_hours (705): { "YYYY-MM-DD": [{start, end}] }, an empty list a day off. Read only with weekly_hours; the host''s own dated days off still apply.';
comment on column public.booking_link.form_id is
  'A form the guest answers first (705): only guests whose answers meet form_rule go on to book. Its answers land in the form''s table as its own page writes them.';
comment on column public.booking_link.form_rule is
  'Who goes on to book (705): { all: [{ field, op, value }] }, every condition must hold; null: everyone who sends the form.';
comment on column public.booking_link.form_refusal is
  'What a guest who doesn''t qualify reads (705); null: the app''s own polite line.';

alter table public.booking_link drop constraint if exists booking_link_date_overrides_shape;
alter table public.booking_link
  add constraint booking_link_date_overrides_shape check (
    -- The 60-date limit is the app's (src/lib/booking-links/links.ts dateOverridesOf): a check takes no subquery.
    date_overrides is null or jsonb_typeof(date_overrides) = 'object'
  );
alter table public.booking_link drop constraint if exists booking_link_form_shape;
alter table public.booking_link
  add constraint booking_link_form_shape check (
    (form_rule is null or (
      form_id is not null
      and jsonb_typeof(form_rule) = 'object'
      and jsonb_typeof(form_rule->'all') = 'array'
      and jsonb_array_length(form_rule->'all') <= 5
      -- Each condition an object naming a field and one of the ops the app knows (src/lib/booking-links/types.ts FORM_RULE_OPS).
      and not jsonb_path_exists(form_rule, '$.all[*] ? (@.type() != "object" || !exists(@.field) || @.field.type() != "string" || !(@.op == "equals" || @.op == "not_equals" || @.op == "contains" || @.op == "in" || @.op == "gte" || @.op == "lte" || @.op == "is_true" || @.op == "is_false"))')
    ))
    and (form_refusal is null or char_length(form_refusal) <= 500)
    and (form_id is null or purpose = 'meeting')
  );

create index if not exists booking_link_form_idx on public.booking_link (form_id) where form_id is not null;

-- A link's form is its own workspace's, and only a meeting link has one; a
-- link with no form (taken away, or deleted: the foreign key sets it null)
-- has no rule.
create or replace function public.booking_link_form_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.form_id is null then
    new.form_rule := null;
    return new;
  end if;
  if not exists (select 1 from public.data_form f where f.id = new.form_id and f.workspace_id = new.workspace_id) then
    raise exception 'a booking link''s form is one of its own workspace''s' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_link_form_guard on public.booking_link;
create trigger booking_link_form_guard
  before insert or update of form_id, form_rule, workspace_id on public.booking_link
  for each row execute function public.booking_link_form_guard();

-- ------------------------------------------------------------
-- 6. The attendance guard
-- ------------------------------------------------------------

-- Attendance is marked only once the booking has started, and a booking that
-- leaves 'confirmed' (no path does today once it has started; this keeps it
-- so) drops its mark instead of failing the check above.
create or replace function public.meeting_booking_attendance_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.state is distinct from 'confirmed' then
    new.attendance := null;
    new.attendance_marked_at := null;
    new.attendance_marked_by := null;
    return new;
  end if;
  if new.attendance is distinct from old.attendance and new.attendance is not null and new.starts_at > now() then
    raise exception 'attendance is marked once a booking has started' using errcode = '23514';
  end if;
  if new.attendance is null then
    new.attendance_marked_at := null;
    new.attendance_marked_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists meeting_booking_attendance_guard on public.meeting_booking;
create trigger meeting_booking_attendance_guard
  before update of attendance, attendance_marked_at, attendance_marked_by, state on public.meeting_booking
  for each row execute function public.meeting_booking_attendance_guard();

-- ------------------------------------------------------------
-- 7. write_meeting_booking, with form_row_id (581's body otherwise)
-- ------------------------------------------------------------

-- Raises on a collision (exclusion_violation) or a reused form row
-- (unique_violation): book_meeting's block undoes it all and answers
-- 'taken' or 'exists'.
create or replace function public.write_meeting_booking(p_booking jsonb, p_hosts uuid[], p_claim_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := (p_booking->>'id')::uuid;
  v_starts timestamptz := (p_booking->>'starts_at')::timestamptz;
  v_ends timestamptz := (p_booking->>'ends_at')::timestamptz;
begin
  insert into public.meeting_booking (
    id, workspace_id, host_user_id, host_name, source, offer_id, link_id, channel,
    guest_name, guest_email, guest_phone, guest_time_zone, guest_note, contact_id, quote_id, guest_id,
    kind, address, answers, title, starts_at, ends_at, state, video, location,
    calendar_account_id, manage_token_hash, other_host_ids, host_time_zone, form_row_id
  ) values (
    v_id,
    (p_booking->>'workspace_id')::uuid,
    (p_booking->>'host_user_id')::uuid,
    p_booking->>'host_name',
    p_booking->>'source',
    nullif(p_booking->>'offer_id', '')::uuid,
    nullif(p_booking->>'link_id', '')::uuid,
    nullif(p_booking->>'channel', ''),
    p_booking->>'guest_name',
    nullif(p_booking->>'guest_email', ''),
    nullif(p_booking->>'guest_phone', ''),
    nullif(p_booking->>'guest_time_zone', ''),
    nullif(p_booking->>'guest_note', ''),
    nullif(p_booking->>'contact_id', '')::uuid,
    nullif(p_booking->>'quote_id', '')::uuid,
    nullif(p_booking->>'guest_id', '')::uuid,
    nullif(p_booking->>'kind', ''),
    nullif(p_booking->>'address', ''),
    coalesce(p_booking->'answers', '[]'::jsonb),
    p_booking->>'title',
    v_starts,
    v_ends,
    coalesce(nullif(p_booking->>'state', ''), 'booking'),
    coalesce((p_booking->>'video')::boolean, false),
    nullif(p_booking->>'location', ''),
    nullif(p_booking->>'calendar_account_id', '')::uuid,
    p_booking->>'manage_token_hash',
    array(select x::uuid from jsonb_array_elements_text(coalesce(p_booking->'other_host_ids', '[]'::jsonb)) as x),
    nullif(p_booking->>'host_time_zone', ''),
    nullif(p_booking->>'form_row_id', '')::uuid
  );

  insert into public.host_time_claim (workspace_id, host_user_id, starts_at, ends_at, kind, claim_key, booking_id, expires_at)
  select (p_booking->>'workspace_id')::uuid, h, v_starts, v_ends, 'booking', v_id, v_id, p_claim_expires_at
  from unnest(p_hosts) as h;
end;
$$;

revoke execute on function public.write_meeting_booking(jsonb, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.write_meeting_booking(jsonb, uuid[], timestamptz) to service_role;

-- No new grants: 554 and 581 revoked every right from anon and authenticated
-- on both tables; the service role keeps its own.

commit;
