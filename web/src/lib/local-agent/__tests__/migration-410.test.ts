/**
 * Migration 410: local agents. Pins what the library relies on and the
 * security shape: owner-only SELECT, no client writes, the status vocabulary
 * the store writes, the uniques its upserts name, realtime, and the
 * device:<uid> doorbell policy.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LIVE_STATUSES, TERMINAL_STATUSES } from '../store'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/410_local_agents.sql'), 'utf8')
// Comments out (whole-line and trailing: no string literal here holds `--`).
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')

const TABLES = ['user_device', 'device_folder', 'local_agent_session', 'local_agent_message', 'local_agent_event']

describe('migration 410', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('creates every table idempotently with RLS and an owner-only SELECT policy, and no client write policy', () => {
    for (const t of TABLES) {
      expect(BODY).toContain(`create table if not exists public.${t} (`)
      expect(BODY).toContain(`alter table public.${t} enable row level security`)
      expect(BODY).toContain(`create policy ${t}_own_select on public.${t} for select to authenticated using ((select auth.uid()) = user_id)`)
    }
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to (authenticated|anon)/)
  })

  it('statuses are TEXT + CHECK with exactly the store’s vocabulary', () => {
    const check = BODY.match(/status text not null default 'queued' check \(status in \(([^)]*)\)\)/)
    expect(check).not.toBeNull()
    const values = [...check![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
    expect(values).toEqual([...new Set([...LIVE_STATUSES, ...TERMINAL_STATUSES, 'interrupted'])].sort())
    expect(BODY).not.toMatch(/create type/i)
  })

  it('has the uniques the upserts and the idempotent start name', () => {
    expect(BODY).toContain('primary key (user_id, id)')
    expect(BODY).toContain('constraint device_folder_grant_uq unique (user_id, device_id, grant_id)')
    // Folders are the person's environment, not attached per chat.
    expect(BODY).not.toContain('chat_conversation_folder')
    expect(BODY).toContain('constraint local_agent_event_device_seq_uq unique (session_id, run_id, seq)')
    expect(BODY).toContain('constraint local_agent_session_idempotency_uq unique (user_id, idempotency_key)')
    expect(BODY).toContain('constraint local_agent_message_idempotency_uq unique (session_id, idempotency_key)')
    expect(BODY).not.toMatch(/idempotency_key text unique/)
    // The embeds the store selects by name.
    expect(BODY).toContain('constraint local_agent_session_device_fk foreign key (user_id, device_id) references public.user_device (user_id, id) on delete cascade')
    expect(BODY).toContain('constraint device_folder_device_fk foreign key (user_id, device_id) references public.user_device (user_id, id) on delete cascade')
  })

  it('carries the per-turn ledger and gap-fill columns', () => {
    for (const col of ['current_turn integer not null default 1', 'current_tracked_job_id uuid', 'tracked_job_id uuid', 'last_seq integer', 'last_seq_run_id text', "expires_at timestamptz not null default (now() + interval '6 hours')"]) {
      expect(BODY).toContain(col)
    }
  })

  it('holds the relay slots service-role only, with an atomic per-person acquire', () => {
    expect(BODY).toContain('create table if not exists public.local_agent_relay_slot (')
    expect(BODY).toContain('alter table public.local_agent_relay_slot enable row level security')
    expect(BODY).not.toMatch(/create policy [a-z_]+ on public\.local_agent_relay_slot/)
    expect(BODY).toContain('create or replace function public.local_agent_relay_acquire(')
    expect(BODY).toContain("perform pg_advisory_xact_lock(hashtextextended('local_agent_relay:' || p_user_id::text, 0))")
    expect(BODY).toContain('security definer set search_path = public, pg_temp')
    expect(BODY).toContain('revoke all on function public.local_agent_relay_acquire(uuid, uuid, integer, integer) from public, anon, authenticated')
    expect(BODY).toContain('grant execute on function public.local_agent_relay_acquire(uuid, uuid, integer, integer) to service_role')
    // The pending query's partial index covers an interrupted session too.
    expect(BODY).toContain("where status in ('queued', 'starting', 'running', 'waiting', 'interrupted')")
    expect(BODY).toContain('pending_turn_text text')
  })

  it('no uniqueness includes workspace_id (the merge re-stamp can never collide)', () => {
    expect(BODY).not.toMatch(/unique \([^)]*workspace_id/)
  })

  it('publishes the session and its events to realtime, and gates the doorbell to the owner', () => {
    expect(BODY).toContain('alter table public.local_agent_session replica identity full')
    expect(BODY).toContain('alter publication supabase_realtime add table public.local_agent_session')
    expect(BODY).toContain('alter publication supabase_realtime add table public.local_agent_event')
    expect(BODY).toContain(`create policy "local_agent_device_owner_can_subscribe" on realtime.messages for select to authenticated using ( realtime.topic() like 'device:%' and split_part(realtime.topic(), ':', 2) = (select auth.uid())::text )`)
  })
})
