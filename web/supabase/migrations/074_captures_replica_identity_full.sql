-- Set REPLICA IDENTITY FULL on captures table so Supabase Realtime
-- includes all columns (including ai_summary) in change payloads.
-- Without this, large text columns are omitted from Realtime events.
ALTER TABLE public.captures REPLICA IDENTITY FULL;
