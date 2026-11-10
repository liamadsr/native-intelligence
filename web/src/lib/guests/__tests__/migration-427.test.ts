/**
 * Migration 427: people who text the owner's agent. Pins the file: the three
 * tables are the owner's to read and nobody's to write but the service role,
 * a phone is active for one owner at most, the guest thread is never any
 * other kind of thread, the stored values match the app's, idempotence, and
 * no backslash.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GUEST_ASK_BEFORE } from '../presets'
import { CODE_ALPHABET } from '@/lib/safety/caller'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/427_agent_guests.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const TABLES = ['agent_guest', 'agent_guest_request_code', 'agent_guest_memory']

describe('migration 427', () => {
  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(SQL).not.toContain('\\')
  })

  it('every table: RLS on, the owner selects their own, no client writes', () => {
    for (const table of TABLES) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`create policy ${table}_select_own on public.${table} for select to authenticated using (owner_user_id = (select auth.uid()));`)
      expect(BODY).toContain(`revoke all on table public.${table} from anon, authenticated;`)
      expect(BODY).toContain(`grant select on table public.${table} to authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
      expect(BODY).not.toMatch(new RegExp(`create policy [a-z_]+ on public\\.${table} for (insert|update|delete|all)`))
    }
  })

  it('one Native Intelligence number: a phone is active for one owner, listed once per owner', () => {
    expect(BODY).toContain("create unique index if not exists agent_guest_active_phone_key on public.agent_guest (phone_e164) where state = 'active';")
    expect(BODY).toContain("create unique index if not exists agent_guest_owner_phone_key on public.agent_guest (owner_user_id, phone_e164) where state <> 'removed';")
  })

  it('the asks the database admits are the app’s, and the default asks before payments and deletes', () => {
    expect(BODY).toContain(`check (ask_before <@ array[${GUEST_ASK_BEFORE.map((a) => `'${a}'`).join(', ')}]::text[])`)
    expect(BODY).toContain("ask_before text[] not null default '{payments,deletes}'")
  })

  it('the request code is the reply-code alphabet', () => {
    expect(BODY).toContain(`check (code ~ '^[${CODE_ALPHABET}]{6}$')`)
  })

  it('memory goes with its guest, and a removed guest holds no invite', () => {
    expect(BODY).toContain('guest_id uuid not null references public.agent_guest(id) on delete cascade')
    expect(BODY).toContain("check (state <> 'removed' or invite_code_hash is null)")
  })

  it('the guest thread: one per guest, gone with the guest, never another kind of thread', () => {
    expect(BODY).toContain('add column if not exists agent_guest_id uuid null references public.agent_guest(id) on delete cascade;')
    expect(BODY).toContain('create unique index if not exists uidx_chat_conversations_guest on public.chat_conversations (agent_guest_id);')
    expect(BODY).toContain('agent_guest_id is null or ( is_home is null and ai_team_member_id is null and agent_teammate_id is null and capture_id is null and focus_area is null )')
  })

  it('is idempotent', () => {
    for (const table of TABLES) expect(BODY).toContain(`create table if not exists public.${table} (`)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/)
    expect(BODY).not.toMatch(/create policy (?!(agent_guest|agent_guest_request_code|agent_guest_memory)_select_own)/)
    expect(BODY.match(/add constraint/g)?.length).toBe(BODY.match(/drop constraint if exists/g)!.length + 1) // + the guarded thread check
  })
})
