/**
 * Migration 328: facts about you (the profile tier), and the chat's memory
 * epochs and operation memo. This pins the file: a fact is keyed to the
 * person and only they reach it (no workspace can read it); the guard keeps
 * learning and supersession the server's and an accepted fact out of the
 * waiting room; the epoch and memo tables are the server's alone, the memo
 * pruned on write; the capture pass's per-session bookkeeping lives here too;
 * and every statement is safe to run twice.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/328_profile_facts.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const OWN = 'user_id = (select auth.uid())'

describe('migration 328', () => {
  it('keys a fact to the person (gone with them), never to a workspace', () => {
    expect(BODY).toContain('create table if not exists public.profile_fact (')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).toContain("check (char_length(btrim(text)) between 1 and 300)")
    expect(BODY).toContain("status text not null default 'active' check (status in ('active', 'proposed'))")
    expect(BODY).toContain("source text not null check (source in ('told', 'learned', 'edited'))")
    expect(BODY).toContain('importance smallint not null default 3 check (importance between 1 and 5)')
    expect(BODY).toContain('source_workspace_id uuid references public.workspace(id) on delete set null')
    expect(BODY).toContain('superseded_by uuid references public.profile_fact(id) on delete set null')
    expect(BODY).not.toMatch(/profile_fact[^;]*is_workspace_member/)
  })

  it('loads live (not retired) facts by person, status, importance and recency, one live fact per text', () => {
    expect(BODY).toContain('add column if not exists retired_at timestamptz')
    expect(BODY).toContain(
      'create index if not exists profile_fact_live_idx on public.profile_fact (user_id, status, importance desc, updated_at desc) where retired_at is null;',
    )
    expect(BODY).toContain(
      'create unique index if not exists profile_fact_live_text_key on public.profile_fact (user_id, lower(btrim(text))) where superseded_by is null and retired_at is null;',
    )
  })

  it('lets only the person read, add (never learned), edit and delete their facts', () => {
    expect(BODY).toContain('alter table public.profile_fact enable row level security;')
    expect(BODY).toContain(`on public.profile_fact for select to authenticated using (${OWN});`)
    expect(BODY).toContain(`on public.profile_fact for insert to authenticated with check (${OWN} and source <> 'learned');`)
    expect(BODY).toContain(`on public.profile_fact for update to authenticated using (${OWN}) with check (${OWN});`)
    expect(BODY).toContain(`on public.profile_fact for delete to authenticated using (${OWN});`)
    expect(BODY).toContain('revoke all on table public.profile_fact from anon, authenticated;')
  })

  it('guards what a person may write: learning and supersession are the server’s, active never goes back', () => {
    expect(BODY).toContain("if coalesce(auth.role(), '') in ('', 'service_role') then")
    expect(BODY).toContain("new.user_id is distinct from auth.uid() or new.source = 'learned'")
    expect(BODY).toContain('if new.superseded_by is not null or new.retired_at is not null then')
    expect(BODY).toContain('or new.superseded_by is distinct from old.superseded_by')
    expect(BODY).toContain('or new.retired_at is distinct from old.retired_at then')
    expect(BODY).toContain('or new.source_workspace_id is distinct from old.source_workspace_id')
    expect(BODY).toContain("if old.status = 'active' and new.status = 'proposed' then")
    expect(BODY).toContain("new.source is distinct from old.source and new.source <> 'edited'")
    expect(BODY).toContain('before insert or update on public.profile_fact for each row execute function public.profile_fact_guard();')
    expect(BODY).toContain('revoke execute on function public.profile_fact_guard() from public, anon, authenticated;')
  })

  it("lets a foreign key's SET NULL through the guard (the newer fact or the workspace deleted), and nothing else with it", () => {
    expect(BODY).toContain('if pg_trigger_depth() > 1')
    expect(BODY).toContain('and new.retired_at is not distinct from old.retired_at')
    expect(BODY).toContain('and (new.superseded_by is not distinct from old.superseded_by or new.superseded_by is null)')
    expect(BODY).toContain('and (new.source_workspace_id is not distinct from old.source_workspace_id or new.source_workspace_id is null) then return new;')
  })

  it('records what the chat was shown per session: the epoch, every live delta key, whether the facts were sent', () => {
    expect(BODY).toContain('add column if not exists epoch_seq integer not null default 0')
    expect(BODY).toContain("add column if not exists live_delta_seqs integer[] not null default '{}'")
    expect(BODY).toContain('add column if not exists facts_shown boolean not null default false')
    expect(BODY).not.toContain('delta_shown')
  })

  it('commits a recall result and the epoch together, the epoch only when this result won', () => {
    expect(BODY).toContain('create or replace function public.chat_memory_recall_commit(')
    expect(BODY).toContain('on conflict (operation_id) do nothing; get diagnostics v_inserted = row_count; if v_inserted = 0 then')
    expect(BODY).toContain("return jsonb_build_object('won', false, 'result', v_result);")
    expect(BODY).toContain('where e.user_id = p_user_id and e.workspace_id = p_workspace_id;')
    expect(BODY).toContain('revoke all on function public.chat_memory_recall_commit(text, text, uuid, uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.chat_memory_recall_commit(text, text, uuid, uuid, uuid, text, jsonb, jsonb) to service_role;')
  })

  it("finds a workspace's contact, company or project name in a text as whole words only, bounded, server only", () => {
    expect(BODY).toContain('create or replace function public.workspace_entity_mentioned(p_workspace_id uuid, p_text text)')
    // Both sides as space-padded tokens: "Mark" never matches "market".
    expect(BODY).toContain("select ' ' || regexp_replace(lower(left(coalesce(p_text, ''), 2000)), '[^[:alnum:]]+', ' ', 'g') || ' ' as body")
    expect(BODY).toContain("btrim(regexp_replace(lower(name), '[^[:alnum:]]+', ' ', 'g')) as core")
    expect(BODY).toContain("and position(' ' || core || ' ' in t.body) > 0")
    expect(BODY).toContain('where char_length(core) >= 4')
    expect(BODY).toContain("and not (kind = 'contact' and position(' ' in core) = 0 and char_length(core) < 5)")
    for (const table of ['public.contact c', 'public.company co', 'public.projects pr']) expect(BODY).toContain(table)
    expect(BODY.match(/order by [a-z]+\.created_at desc nulls last limit 5000/g)).toHaveLength(3)
    expect(BODY).toContain('revoke all on function public.workspace_entity_mentioned(uuid, text) from public, anon, authenticated;')
    expect(BODY).toContain('grant execute on function public.workspace_entity_mentioned(uuid, text) to service_role;')
  })

  it('grants a person only what the policies need on their facts, and nothing on the chat memory tables', () => {
    expect(BODY).toContain('revoke all on table public.profile_fact from anon, authenticated;')
    expect(BODY).toContain('grant select, insert, update, delete on table public.profile_fact to authenticated;')
    for (const table of ['chat_memory_epoch', 'chat_memory_op']) {
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).not.toMatch(new RegExp(`grant [^;]* on table public\\.${table}`))
    }
  })

  it('holds no backslash at all (a JSON transport decodes escapes, so the applied SQL would differ from the file)', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
  })

  it('keeps the epochs and the memo server-only: RLS on, no policies, no grants', () => {
    for (const table of ['chat_memory_epoch', 'chat_memory_op']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).not.toMatch(new RegExp(`create policy [^;]* on public\\.${table}`))
    }
    expect(BODY).toContain('session_id text primary key')
    expect(BODY).toContain("snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(snapshot) = 'array')")
    expect(BODY).toContain('snapshot_hash text not null')
    expect(BODY).toContain('operation_id text primary key')
    expect(BODY).toContain("op text not null check (op in ('recall', 'capture'))")
  })

  it('holds the capture pass’s per-session bookkeeping (A2c)', () => {
    expect(BODY).toContain('add column if not exists captured_through_seq integer')
    expect(BODY).toContain('add column if not exists captured_through_at timestamptz')
    expect(BODY).toContain('add column if not exists last_capture_at timestamptz')
  })

  it('prunes the memo past 7 days on write', () => {
    expect(BODY).toContain("delete from public.chat_memory_op where created_at < now() - interval '7 days';")
    expect(BODY).toContain('after insert on public.chat_memory_op for each statement execute function public.chat_memory_op_prune();')
    expect(BODY).toContain('create index if not exists chat_memory_op_created_idx on public.chat_memory_op (created_at);')
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/)
    expect(BODY).not.toMatch(/create index (?!if not exists)/)
    expect(BODY).not.toMatch(/create function/)
    for (const m of BODY.matchAll(/create policy "([^"]+)"/g)) expect(BODY).toContain(`drop policy if exists "${m[1]}"`)
    for (const m of BODY.matchAll(/create trigger (\w+)/g)) expect(BODY).toContain(`drop trigger if exists ${m[1]}`)
  })
})
