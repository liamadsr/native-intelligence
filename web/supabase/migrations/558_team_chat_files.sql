-- ============================================================
-- 558: Team chat files: a private storage bucket for the files and images on
-- team chat messages, readable exactly by those who may read the channel.
-- ============================================================
--   storage bucket team-chat-files  private; 10 MB a file (the AI chat's cap,
--                     MAX_CHAT_UPLOAD_BYTES); images, PDFs, text, office
--                     files and zips only (never HTML or SVG, which a browser
--                     would run if a link were opened directly). An object
--                     is `<channel id>/<user id>/<uuid>.<ext>`: its channel
--                     is its first folder, its uploader the second.
--   team_chat_file_channel  the channel an object's name is in, or null for a
--                     name that isn't one of these.
--   storage.objects policies (this bucket only):
--     read    whoever may read the channel (team_chat_can_read), so a team
--             channel's files are its team's, a DM's its two members'.
--     upload  into the caller's own sub-folder of a channel they may post in.
--     delete  their own uploads only. No update: a file never changes.
--
-- Why not the `attachments` bucket the AI chat uses: its read policy is any
-- member of the workspace an `attachments` row names, and a member who knew a
-- file's path could point a row of theirs at it (a DM's file, read by the
-- whole workspace). A bucket of its own is fenced by the channel alone.
--
-- Additive. Idempotent. No backslashes anywhere in this file (one MCP
-- transport decodes escapes).
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'team-chat-files',
  'team-chat-files',
  false,
  10485760,
  array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
    'application/pdf',
    'text/plain', 'text/markdown', 'text/csv', 'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
    'application/zip', 'application/octet-stream'
  ]
)
on conflict (id) do update
   set public = false,
       file_size_limit = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- The channel an object's name is in: its first folder, when that is a uuid.
create or replace function public.team_chat_file_channel(object_name text)
returns uuid
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
  end;
$$;

revoke all on function public.team_chat_file_channel(text) from public, anon;
grant execute on function public.team_chat_file_channel(text) to authenticated, service_role;

drop policy if exists "team chat files read" on storage.objects;
create policy "team chat files read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-chat-files'
    and public.team_chat_can_read(public.team_chat_file_channel(name))
  );

drop policy if exists "team chat files upload" on storage.objects;
create policy "team chat files upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-chat-files'
    and array_length(storage.foldername(name), 1) = 2
    and split_part(name, '/', 2) = (select auth.uid())::text
    and public.team_chat_can_post(public.team_chat_file_channel(name))
  );

drop policy if exists "team chat files delete" on storage.objects;
create policy "team chat files delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-chat-files'
    and split_part(name, '/', 2) = (select auth.uid())::text
  );

notify pgrst, 'reload schema';
