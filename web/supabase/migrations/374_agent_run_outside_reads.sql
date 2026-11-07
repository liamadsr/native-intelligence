-- Migration 374: what outside text a work run read (trust layer P2, F8 with
-- decision 16 as Liam settled it: apply with undo, never an approval queue).
--
-- A teammate's memory (agent_memory, 289) is written ACTIVE from every run,
-- recorded with its source run, origin and trust class, and undoable. An
-- entry a run taught after reading untrusted outside text, and a canon edit
-- it made, carry a quiet label saying so, for the person to spot and remove.
-- This column is that record: the names of the tools that brought outside
-- text into the run
-- (src/lib/safety/outside-text.ts), each once, at most 20:
--   - web_search / web_fetch (the work-agent's own web tools, noted by the
--     event pump, src/lib/agent-run/run-work-eve.ts);
--   - a mail read whose sender is not one the person knows (list_emails,
--     read_email; get_email_summary always), an attachment's content, a
--     reference or source ingest, the web research and browser tools, and
--     any connected app's tool (noted by /api/internal/work-run/tool).
--
-- agent_run_note_outside_read appends one name atomically (the pump and the
-- tool route can both write for one run), service role only.
--
-- Idempotent: add column if not exists, create or replace, revoke then grant.

SET LOCAL lock_timeout = '5s';

alter table public.agent_run add column if not exists outside_reads text[] not null default '{}';

comment on column public.agent_run.outside_reads is
  'Tools that brought untrusted outside text into this run (374, src/lib/safety/outside-text.ts), each once, at most 20. What the run teaches or writes into a canon document is labelled from it.';

create or replace function public.agent_run_note_outside_read(p_run_id uuid, p_workspace_id uuid, p_tool text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.agent_run
     set outside_reads = outside_reads || p_tool
   where id = p_run_id
     and workspace_id = p_workspace_id
     and p_tool is not null
     and char_length(p_tool) between 1 and 200
     and not (p_tool = any (outside_reads))
     and cardinality(outside_reads) < 20;
$$;

comment on function public.agent_run_note_outside_read(uuid, uuid, text) is
  'Append one tool name to agent_run.outside_reads (374): once, at most 20, fenced to the run''s workspace. Service role only.';

revoke all on function public.agent_run_note_outside_read(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.agent_run_note_outside_read(uuid, uuid, text) to service_role;
