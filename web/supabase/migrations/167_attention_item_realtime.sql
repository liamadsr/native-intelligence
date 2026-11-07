-- Migration 167: enable Supabase Realtime on attention_item (Phase 2, Workstream D).
--
-- The attention rail (the floating cards in the collapsed full-screen chat)
-- subscribes to postgres_changes INSERTs on attention_item, filtered by
-- member_id, so a card produced by a triage-class verdict run appears the
-- instant it's written — no poll, no page refresh. This mirrors exactly how the
-- notification bell subscribes to `notification` (migration 031).
--
-- Why postgres_changes and not a custom broadcast: the attention_item ROW is the
-- durable source of truth (written by the server-side verdict apply). A separate
-- broadcast in deliverVerdictRun would be a second, lossy channel to keep in
-- sync. Subscribing to the row's INSERT gives the rail the new card for free,
-- and RLS (owner-only select, migration 165) means the event is delivered ONLY
-- to the owning member's client — never to a teammate.
--
-- REPLICA IDENTITY FULL: not required for INSERT (the full new row is always
-- carried), but set anyway so future UPDATE/DELETE events (e.g. a card resolved
-- from another device) carry the columns the client filters on (member_id),
-- not just the PK. Matches the email_thread_index precedent (migration 130).

alter table public.attention_item replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.attention_item;
exception
  -- Already a member of the publication — nothing to do (idempotent re-run).
  when duplicate_object then null;
end $$;
