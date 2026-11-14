-- ============================================================
-- 651: every bucket without a size limit of its own gets the one it has
-- today, 50 MB, written down (call audio, phase 4). Storage takes the
-- smaller of a bucket's own limit and its global one (FILE_SIZE_LIMIT in
-- deploy/supabase, 50 MB until now: Storage's getFileSizeLimit and
-- getStandardMaxFileSizeLimit). A long call's audio file can pass 50 MB, so
-- the global limit goes up after this (deploy/supabase/compose.override.yaml,
-- deploy/README.md step 23, "Call audio files"). A bucket with no limit of
-- its own would then take files as large as the new global one; this keeps
-- each at what it takes today, so the raise changes nothing for them.
-- ============================================================
--   Which buckets: every row of storage.buckets whose file_size_limit is
--   null, whatever made it (a migration, the earlier host's dashboard, the
--   storage copy of deploy/supabase/migrate/03-copy-storage.sh). In this
--   repository that is `attachments` (the baseline makes it with none). The
--   others already have their own and are not touched:
--     team-chat-files       10 MB (558)
--     workspace-merges      50 MB (407)
--     team-call-recordings  2 GB (566): the call's audio file, and Egress's
--                           recordings, are meant to take more than 50 MB
--     studio                2 GB (620): it stores its media in parts under
--                           50 MB (src/lib/studio/server/job-contract.ts)
--   Once the global limit is raised, the last two take files up to their
--   own 2 GB. deploy/README.md lists the query that shows every bucket's
--   limit on the server before the raise.
--
-- Re-runnable: a second run finds no bucket without a limit. Safe on a live
-- database: a few rows of a small table. No backslashes anywhere in this file
-- (one MCP transport decodes escapes).
-- ------------------------------------------------------------

begin;

SET LOCAL lock_timeout = '5s';

update storage.buckets
   set file_size_limit = 52428800,
       updated_at = now()
 where file_size_limit is null;

commit;
