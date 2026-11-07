/**
 * Migration 335: tool_approval and the 'approval' attention card kind. Pins:
 * the table's shape (status set, expiry, the result), owner-only SELECT with
 * no write policy (server writes only), the kind check widened with every
 * earlier kind kept, approval cards never carry a proposal, every statement
 * safe to run twice, and no backslash anywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/335_tool_approval.sql'), 'utf8')
const BODY = SQL.split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()

describe('migration 335', () => {
  it('creates tool_approval idempotently with the held call, its source, decision, seq, status, expiry and result', () => {
    expect(BODY).toContain('create table if not exists public.tool_approval (')
    for (const column of [
      'tool text not null', 'input jsonb not null', 'input_hash text not null', 'conversation_id uuid',
      'skill_id uuid', 'work_item_id uuid', 'decision_id text', 'person_message_seq integer',
      'expires_at timestamptz not null', 'result jsonb', 'created_at timestamptz not null default now()',
      'executed_at timestamptz', 'decided_at timestamptz',
    ]) expect(BODY, column).toContain(column)
    expect(BODY).toContain("status text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'expired', 'failed'))")
    expect(BODY).toContain("door text not null check (door in ('chat', 'skill_run', 'mcp'))")
  })

  it('lets the owner read their own approvals and gives no write policy (only the server writes)', () => {
    expect(BODY).toContain('alter table public.tool_approval enable row level security;')
    expect(BODY).toContain('create policy tool_approval_owner_select on public.tool_approval for select using (user_id = auth.uid());')
    expect(BODY).not.toMatch(/for (insert|update|delete|all)/)
  })

  it('widens the attention card kinds with approval, keeping every earlier kind', () => {
    const drop = BODY.indexOf('drop constraint if exists attention_item_kind_check;')
    const add = BODY.indexOf('add constraint attention_item_kind_check')
    expect(drop).toBeGreaterThan(-1)
    expect(add).toBeGreaterThan(drop)
    expect(BODY).toContain("check (kind in ('action_card', 'draft_email', 'question', 'work_proposal', 'approval'));")
  })

  it('an approval card never carries a proposal, so accept_proposal cannot reach one', () => {
    expect(BODY).toContain("check (kind <> 'approval' or proposal_id is null);")
  })

  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('every statement is idempotent', () => {
    const statements = BODY.split(';').map((s) => s.trim()).filter(Boolean)
    for (const s of statements) {
      expect(
        /if not exists|if exists|^comment on|^alter table public\.(tool_approval enable row level security|attention_item add constraint)|^create policy/.test(s),
        s,
      ).toBe(true)
    }
    // A policy is created only after its drop-if-exists.
    expect(BODY.indexOf('drop policy if exists tool_approval_owner_select')).toBeLessThan(BODY.indexOf('create policy tool_approval_owner_select'))
  })
})
