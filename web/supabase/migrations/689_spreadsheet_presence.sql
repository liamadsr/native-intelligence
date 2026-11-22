-- ============================================================
-- 689: who may hear, and say, who is on a spreadsheet.
-- ============================================================
-- On top of 675 (spreadsheets). The owner's decision of 2026-11-22
-- (docs/plans/spreadsheets.md): the editor shows who else has a spreadsheet
-- open and each person's selected cells, as canvas does for cursors (682).
--
-- Names and selections travel on a Realtime broadcast channel,
-- `spreadsheet-presence:<spreadsheet id>`, and are never stored. A channel's
-- name is no secret: without a rule, any holder of the anon key who knew a
-- spreadsheet's id could listen in, on a private spreadsheet too. The editor
-- joins it as a PRIVATE channel, and these realtime.messages policies let in
-- only whoever may read the spreadsheet, judged by 675's own read rule
-- (spreadsheet_entity_visible_to: a member of its workspace, and for a
-- private one its maker), for broadcast only. The topic is parsed as text
-- before any cast, so a malformed topic is refused, never an error inside a
-- policy (559's rule).
--
-- It redefines NO existing function and NO existing policy: one new function,
-- two new policies. Additive. Idempotent. No backslashes anywhere in this
-- file (one MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` is atomic too.

begin;

SET LOCAL lock_timeout = '5s';

-- The spreadsheet a presence topic is for, or null for any other topic.
-- Compared as text before the cast, and anchored at both ends, so a malformed
-- topic never raises inside a policy and nothing rides along after the id.
create or replace function public.spreadsheet_presence_sheet(topic text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when topic ~ '^spreadsheet-presence:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(topic, ':', 2)::uuid
  end;
$$;

comment on function public.spreadsheet_presence_sheet(text) is
  'The spreadsheet a Realtime presence topic (spreadsheet-presence:<uuid>) is for, or null for anything else (689).';

revoke all on function public.spreadsheet_presence_sheet(text) from public, anon;
grant execute on function public.spreadsheet_presence_sheet(text) to authenticated;

-- Hear and say are the same rule: whoever may read the spreadsheet. A viewer
-- of an archived one is as much "who is here" as an editor. Broadcast only.
-- A topic that names no spreadsheet gives null, and 675's rule answers no for
-- a null id; so does a spreadsheet that is gone, one in a workspace the
-- caller is not a member of, and a private one that is not the caller's.
drop policy if exists "spreadsheet_presence_hear" on realtime.messages;
create policy "spreadsheet_presence_hear" on realtime.messages
  for select to authenticated
  using (
    realtime.topic() like 'spreadsheet-presence:%'
    and realtime.messages.extension = 'broadcast'
    and public.spreadsheet_entity_visible_to(public.spreadsheet_presence_sheet(realtime.topic()), null, (select auth.uid()))
  );

drop policy if exists "spreadsheet_presence_say" on realtime.messages;
create policy "spreadsheet_presence_say" on realtime.messages
  for insert to authenticated
  with check (
    realtime.topic() like 'spreadsheet-presence:%'
    and realtime.messages.extension = 'broadcast'
    and public.spreadsheet_entity_visible_to(public.spreadsheet_presence_sheet(realtime.topic()), null, (select auth.uid()))
  );

commit;

notify pgrst, 'reload schema';
