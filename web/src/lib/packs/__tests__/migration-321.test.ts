/**
 * Migration 321: "Learn from my sent mail overnight", each person's switch for
 * the nightly memory pass, per workspace, off until they turn it on. This pins
 * the file as history: one row per person and workspace, gone with their
 * membership, and each person reads and writes only their own. Migration 353
 * drops the table (Liam, 2026-10-17: learning is on by default, no opt-in;
 * migration-353.test.ts pins the drop).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/321_memory_learning_setting.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const OWN_ROW = 'user_id = (select auth.uid()) and public.is_workspace_member(workspace_id)'

describe('migration 321', () => {
  it('is off until the person turns it on: one row per person and workspace', () => {
    expect(BODY).toContain('learn_from_mail boolean not null default false')
    expect(BODY).toContain('primary key (workspace_id, user_id)')
  })

  it('goes with their membership, so a removal or leaving turns it off', () => {
    expect(BODY).toContain(
      'foreign key (user_id, workspace_id) references public.member (user_id, workspace_id) on delete cascade',
    )
  })

  it('lets each person read and write only their own row, in a workspace they belong to', () => {
    expect(BODY).toContain('alter table public.memory_learning_setting enable row level security;')
    expect(BODY).toContain(`for select to authenticated using (${OWN_ROW});`)
    expect(BODY).toContain(`for insert to authenticated with check (${OWN_ROW});`)
    expect(BODY).toContain(`for update to authenticated using (${OWN_ROW}) with check (${OWN_ROW});`)
    expect(BODY).not.toMatch(/for (delete|all) to/)
    expect(BODY).toContain('revoke all on table public.memory_learning_setting from anon;')
  })
})
