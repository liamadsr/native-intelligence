-- ============================================================
-- 620: Studio: making videos and ads in the workspace.
-- ============================================================
-- A Studio project holds the videos a team makes with the same people, brand
-- and media (a launch, a season, one client's ads). Each video is one edit:
-- its timeline, layers, sound, storyboard and cast, as one JSON document the
-- editor and the agent both write through the same checked path
-- (src/lib/studio/). Recorded, uploaded and generated media is kept once per
-- workspace, by the hash of its bytes.
--
--   1. studio_project        the group: title, client, notes, brand, and the
--                            cast its videos share.
--   2. studio_video          one edit. doc is the whole edit (the editor's
--                            project schema, validated in code before every
--                            write); digest is the hash of that document and
--                            every writer names the digest it read, so two
--                            editors (a person and the agent) never overwrite
--                            each other silently: a stale digest is refused.
--                            summary is what lists show without opening doc.
--                            archived_at is the trash.
--   3. studio_video_version  the edit, or only its storyboard, as it was
--                            before each agent pass or restore. The newest 40
--                            of each kind per video are kept (in code).
--   4. studio_asset          the workspace's media library: one row per
--                            file, id = sha256 of its bytes for anything
--                            imported. meta is the asset record edits embed.
--   5. studio_blob           where a stored file's bytes are. Storage caps a
--                            single object (50 MB on our own server until the
--                            owner raises it), and a recording is larger, so
--                            a file is kept as numbered parts under one key
--                            and served stitched, byte ranges included.
--   6. studio_script         what gets said: a script is a list of beats, one
--                            per video (the teleprompter reads it and a
--                            storyboard starts from it) or free in a project.
--   7. studio_record         small per-workspace records that are one JSON
--                            value each: appearance presets, transcripts,
--                            slide decks, the cost ledger, reference
--                            blueprints, settings.
--   8. studio_job            long work: importing a file, exporting a video,
--                            stills, transcripts, sound. The app queues a
--                            row; the Studio worker (studio-worker/, its own
--                            container with a browser and FFmpeg) claims it,
--                            reports progress on the row and finishes it. The
--                            editor polls the row.
--   9. studio_claim_job      one worker takes the oldest queued job of the
--                            kinds it does, and jobs whose worker went quiet
--                            go back in the queue.
--  10. storage bucket studio private. Nobody reads or writes it directly:
--                            the app signs every upload and download after
--                            checking the person's workspace, and the worker
--                            is handed signed links per job.
--
-- RLS on, and only the service role reads or writes (as 581's tables: every
-- reader is on the server). Additive. Idempotent. No backslashes anywhere in
-- this file (one MCP transport decodes escapes).
--
-- Must run before the app code that reads it is rolled out: the Studio page
-- and its tools read these tables.
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. studio_project
-- ------------------------------------------------------------

create table if not exists public.studio_project (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  title text not null,
  client text null,
  notes text null,
  brand jsonb null,
  cast_members jsonb not null default '[]'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

comment on table public.studio_project is
  'A Studio project (620): the videos a team makes with the same cast, brand and media.';

create index if not exists studio_project_workspace_idx
  on public.studio_project (workspace_id, updated_at desc) where archived_at is null;

-- ------------------------------------------------------------
-- 2. studio_video
-- ------------------------------------------------------------

create table if not exists public.studio_video (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  studio_project_id uuid null references public.studio_project(id) on delete set null,
  title text not null,
  status text not null default 'draft',
  variant_of uuid null references public.studio_video(id) on delete set null,
  doc jsonb not null,
  digest text not null,
  revision integer not null default 1,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz null
);

comment on table public.studio_video is
  'One Studio video (620): doc is the whole edit, digest its hash; a write names the digest it read and a stale one is refused.';

alter table public.studio_video drop constraint if exists studio_video_status_check;
alter table public.studio_video
  add constraint studio_video_status_check check (status in ('draft', 'review', 'approved'));

create index if not exists studio_video_workspace_idx
  on public.studio_video (workspace_id, updated_at desc) where archived_at is null;
create index if not exists studio_video_project_idx
  on public.studio_video (studio_project_id) where studio_project_id is not null;

-- ------------------------------------------------------------
-- 3. studio_video_version
-- ------------------------------------------------------------

create table if not exists public.studio_video_version (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  video_id uuid not null references public.studio_video(id) on delete cascade,
  kind text not null default 'project',
  label text not null default '',
  doc jsonb not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.studio_video_version is
  'A Studio video, or only its storyboard, as it was before a pass that changed it (620).';

alter table public.studio_video_version drop constraint if exists studio_video_version_kind_check;
alter table public.studio_video_version
  add constraint studio_video_version_kind_check check (kind in ('project', 'storyboard'));

create index if not exists studio_video_version_video_idx
  on public.studio_video_version (video_id, kind, created_at desc);

-- ------------------------------------------------------------
-- 4. studio_asset
-- ------------------------------------------------------------

create table if not exists public.studio_asset (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  id text not null,
  name text not null,
  kind text not null,
  sha256 text not null,
  bytes bigint not null,
  meta jsonb not null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);

comment on table public.studio_asset is
  'A workspace''s Studio media library (620): one row per file, id the sha256 of its bytes for imports; meta is the asset record edits embed.';

alter table public.studio_asset drop constraint if exists studio_asset_kind_check;
alter table public.studio_asset
  add constraint studio_asset_kind_check check (kind in ('video', 'image', 'audio'));

create index if not exists studio_asset_workspace_idx
  on public.studio_asset (workspace_id, created_at desc);

-- ------------------------------------------------------------
-- 5. studio_blob
-- ------------------------------------------------------------

create table if not exists public.studio_blob (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  key text not null,
  bytes bigint not null,
  parts integer not null default 1,
  part_bytes bigint not null,
  content_type text not null default 'application/octet-stream',
  sha256 text null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, key)
);

comment on table public.studio_blob is
  'Where a Studio file''s bytes are (620): parts numbered 0..parts-1 in the studio bucket under <workspace>/<key>/<n>, each part_bytes long but the last.';

alter table public.studio_blob drop constraint if exists studio_blob_shape_check;
alter table public.studio_blob
  add constraint studio_blob_shape_check check (bytes >= 0 and parts >= 1 and part_bytes >= 1);

-- ------------------------------------------------------------
-- 6. studio_script
-- ------------------------------------------------------------

create table if not exists public.studio_script (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  video_id uuid null references public.studio_video(id) on delete cascade,
  studio_project_id uuid null references public.studio_project(id) on delete cascade,
  title text not null,
  beats jsonb not null default '[]'::jsonb,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.studio_script is
  'A Studio script (620): the lines a video says, as beats {text, seconds?, label?}. One per video at most; others belong to a project or stand alone.';

create unique index if not exists studio_script_video_key
  on public.studio_script (video_id) where video_id is not null;
create index if not exists studio_script_workspace_idx
  on public.studio_script (workspace_id, updated_at desc);

-- ------------------------------------------------------------
-- 7. studio_record
-- ------------------------------------------------------------

create table if not exists public.studio_record (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  collection text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, collection, key)
);

comment on table public.studio_record is
  'Small per-workspace Studio records, one JSON value each (620): presets, transcripts, slide decks, the cost ledger, blueprints, settings.';

-- ------------------------------------------------------------
-- 8. studio_job
-- ------------------------------------------------------------

create table if not exists public.studio_job (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  video_id uuid null references public.studio_video(id) on delete set null,
  kind text not null,
  status text not null default 'queued',
  progress real not null default 0,
  logs jsonb not null default '[]'::jsonb,
  input jsonb not null default '{}'::jsonb,
  result jsonb null,
  error text null,
  cancel_requested boolean not null default false,
  worker_id text null,
  attempts integer not null default 0,
  claimed_at timestamptz null,
  heartbeat_at timestamptz null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.studio_job is
  'Long Studio work (620): the app queues a row, the Studio worker claims it, reports progress here and finishes it; the editor polls it.';

alter table public.studio_job drop constraint if exists studio_job_status_check;
alter table public.studio_job
  add constraint studio_job_status_check check (status in ('queued', 'running', 'completed', 'failed', 'cancelled'));

create index if not exists studio_job_open_idx
  on public.studio_job (created_at) where status in ('queued', 'running');
create index if not exists studio_job_workspace_idx
  on public.studio_job (workspace_id, created_at desc);

-- ------------------------------------------------------------
-- 9. studio_claim_job
-- ------------------------------------------------------------
-- One worker takes the oldest queued job among the kinds it does. A running
-- job whose worker has not reported for p_stale_seconds goes back in the
-- queue first (a worker that was stopped mid-job), up to three tries, after
-- which it fails with a reason the person can read.

create or replace function public.studio_claim_job(
  p_worker text,
  p_kinds text[],
  p_stale_seconds integer default 180
)
returns setof public.studio_job
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  picked uuid;
begin
  update public.studio_job
     set status = 'failed',
         error = 'The worker stopped while doing this, three times. Try again.',
         updated_at = now()
   where status = 'running'
     and attempts >= 3
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  update public.studio_job
     set status = 'queued',
         worker_id = null,
         updated_at = now()
   where status = 'running'
     and attempts < 3
     and coalesce(heartbeat_at, claimed_at, created_at) < now() - make_interval(secs => p_stale_seconds);

  select j.id into picked
    from public.studio_job j
   where j.status = 'queued'
     and j.cancel_requested = false
     and j.kind = any (p_kinds)
   order by j.created_at
   limit 1
   for update skip locked;

  if picked is null then
    return;
  end if;

  return query
    update public.studio_job
       set status = 'running',
           worker_id = p_worker,
           attempts = attempts + 1,
           claimed_at = now(),
           heartbeat_at = now(),
           updated_at = now()
     where id = picked
    returning *;
end;
$$;

revoke execute on function public.studio_claim_job(text, text[], integer) from public, anon, authenticated;
grant execute on function public.studio_claim_job(text, text[], integer) to service_role;

-- ------------------------------------------------------------
-- updated_at
-- ------------------------------------------------------------

drop trigger if exists studio_project_updated_at on public.studio_project;
create trigger studio_project_updated_at before update on public.studio_project
  for each row execute function public.update_updated_at();

drop trigger if exists studio_video_updated_at on public.studio_video;
create trigger studio_video_updated_at before update on public.studio_video
  for each row execute function public.update_updated_at();

drop trigger if exists studio_script_updated_at on public.studio_script;
create trigger studio_script_updated_at before update on public.studio_script
  for each row execute function public.update_updated_at();

-- ------------------------------------------------------------
-- RLS: on, service role only.
-- ------------------------------------------------------------

alter table public.studio_project enable row level security;
alter table public.studio_video enable row level security;
alter table public.studio_video_version enable row level security;
alter table public.studio_asset enable row level security;
alter table public.studio_blob enable row level security;
alter table public.studio_script enable row level security;
alter table public.studio_record enable row level security;
alter table public.studio_job enable row level security;

revoke all on table public.studio_project from anon, authenticated;
revoke all on table public.studio_video from anon, authenticated;
revoke all on table public.studio_video_version from anon, authenticated;
revoke all on table public.studio_asset from anon, authenticated;
revoke all on table public.studio_blob from anon, authenticated;
revoke all on table public.studio_script from anon, authenticated;
revoke all on table public.studio_record from anon, authenticated;
revoke all on table public.studio_job from anon, authenticated;

grant all on table public.studio_project to service_role;
grant all on table public.studio_video to service_role;
grant all on table public.studio_video_version to service_role;
grant all on table public.studio_asset to service_role;
grant all on table public.studio_blob to service_role;
grant all on table public.studio_script to service_role;
grant all on table public.studio_record to service_role;
grant all on table public.studio_job to service_role;

-- ------------------------------------------------------------
-- 10. storage bucket studio
-- ------------------------------------------------------------
-- Private, and no policy on storage.objects for it: the app signs every
-- upload and download (service role) after checking the person's workspace.
-- An object is `<workspace id>/<key>/<part number>`. No mime allowlist: parts
-- of a larger file are opaque bytes. The cap is per part; the app cuts files
-- into parts below the server's own cap.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('studio', 'studio', false, 2147483648, null)
on conflict (id) do update
   set public = false,
       file_size_limit = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

notify pgrst, 'reload schema';

commit;
