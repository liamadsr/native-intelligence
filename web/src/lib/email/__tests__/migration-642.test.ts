/**
 * Migration 642: send later. Pins the file to the app: the table holds every
 * column the sender reads and no mail body; its statuses and providers are
 * the app's; the owner alone reads (RLS on, one select policy, user_id =
 * auth.uid()), and only the server writes (no write policy, writes revoked);
 * the sweep's index; the new notification type is the app's and the newest
 * word on the check, keeping 572's list; bounded, re-runnable, no backslash.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { SCHEDULED_SEND_COLUMNS, SCHEDULED_SEND_STATUSES } from '../scheduled-send'

const FILE = '642_email_scheduled_send.sql'
const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
const TABLE = BODY.slice(BODY.indexOf('create table if not exists public.email_scheduled_send ('), BODY.indexOf('comment on table public.email_scheduled_send'))

describe('migration 642', () => {
  it('is the only 642, holds no backslash, and takes its locks with a timeout', () => {
    const numbers = readdirSync(join(process.cwd(), 'supabase/migrations')).map((f) => Number(f.split('_')[0]))
    expect(numbers.filter((n) => n === 642)).toHaveLength(1)
    expect(SQL).not.toContain('\\')
    expect(BODY.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
  })

  it('has every column the app reads, and nothing that could hold a body', () => {
    for (const c of SCHEDULED_SEND_COLUMNS.split(',').map((s) => s.trim())) expect(TABLE, c).toMatch(new RegExp(`[(,] ${c} `))
    expect(TABLE).not.toMatch(/\bbody|html|text_body|content\b/i)
    // to/subject may be cleared once sent; the draft's reference may not.
    expect(TABLE).toContain('to_emails text[] null')
    expect(TABLE).toContain('subject text null')
    expect(TABLE).toContain('provider_draft_id text not null')
    expect(TABLE).toContain('thread_id text null')
  })

  it('checks exactly the statuses the sender writes, and the two providers', () => {
    expect(TABLE).toContain(`check (status in (${SCHEDULED_SEND_STATUSES.map((s) => `'${s}'`).join(', ')}))`)
    expect(TABLE).toContain("check (provider in ('google', 'microsoft'))")
    expect(TABLE).toContain("status text not null default 'scheduled'")
  })

  it('ties a row to its workspace, its owner and its mailbox, each removed with them', () => {
    expect(TABLE).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(TABLE).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(TABLE).toContain('account_id uuid not null references public.connected_account(id) on delete cascade')
  })

  it('RLS: the owner reads their own rows; only the server writes', () => {
    expect(BODY).toContain('alter table public.email_scheduled_send enable row level security;')
    const policies = [...BODY.matchAll(/create policy "([^"]+)" on public\.email_scheduled_send for (\w+) using \((.*?)\);/g)].map((m) => [m[1], m[2], m[3]])
    expect(policies).toEqual([['owner reads own scheduled sends', 'select', 'user_id = auth.uid()']])
    expect(BODY).toContain('drop policy if exists "owner reads own scheduled sends" on public.email_scheduled_send;')
    expect(BODY).toContain('revoke insert, update, delete on public.email_scheduled_send from anon, authenticated;')
    expect(BODY).not.toMatch(/for (insert|update|delete|all)\b/)
  })

  it('indexes the sweep’s due rows, the folder’s reads and the mailbox key', () => {
    expect(BODY).toContain("create index if not exists email_scheduled_send_due_idx on public.email_scheduled_send (send_at) where status in ('scheduled', 'sending');")
    expect(BODY).toContain('create index if not exists email_scheduled_send_owner_idx on public.email_scheduled_send (user_id, workspace_id, send_at);')
    expect(BODY).toContain('create index if not exists email_scheduled_send_account_idx on public.email_scheduled_send (account_id);')
  })

  it('adds email_send_failed to 572’s notification types, the app’s list, and is the newest word on the check', () => {
    const types = [...(/notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(BODY)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
    expect(types).toEqual([...NOTIFICATION_TYPES])
    expect(types[types.length - 1]).toBe('email_send_failed')
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint notification_type_check/i.test(m.sql))!.file
    expect(newest).toBe(FILE)
    expect(BODY.indexOf('drop constraint if exists notification_type_check')).toBeLessThan(BODY.indexOf('add constraint notification_type_check'))
  })

  it('is re-runnable', () => {
    expect(BODY).not.toMatch(/create table (?!if not exists)/i)
    expect(BODY).not.toMatch(/create (unique )?index (?!if not exists)/i)
    const created = [...BODY.matchAll(/create policy "([^"]+)"/g)].map((m) => m[1])
    for (const name of created) expect(BODY).toContain(`drop policy if exists "${name}"`)
  })
})
