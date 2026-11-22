/**
 * Migrations 679 (a company's stage, owner and revenue; its discussion;
 * pipelines of companies or contacts) and 680 (a company's email, shared with
 * the team). Run on a local Postgres 17 built from the baseline and every
 * migration, each applied twice, with supabase/tests/679_crm_companies.sql and
 * 680_company_team_email.sql passing. These hold the shape that made it right.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const file = (n: string) => all.find((m) => m.file.startsWith(`${n}_`))!.sql
const m679 = file('679')
const m680 = file('680')

/** Every function a file (re)defines. */
const defined = (sql: string) => [...sql.matchAll(/create or replace function public\.(\w+)\(/gi)].map((m) => m[1].toLowerCase())

describe('both files', () => {
  it('run in one transaction, re-run safely, with no backslashes', () => {
    for (const sql of [m679, m680]) {
      expect(sql).toMatch(/^begin;/m)
      expect(sql).toMatch(/^commit;/m)
      expect(sql).not.toContain('\\')
      expect(sql).not.toMatch(/create table (?!if not exists)/i)
      expect(sql).not.toMatch(/create (unique )?index (?!if not exists)/i)
      expect(sql).not.toMatch(/add column (?!if not exists)/i)
      // Every policy is dropped first, every trigger too.
      const policies = [...sql.matchAll(/create policy (\w+)/gi)].map((m) => m[1])
      for (const p of policies) expect(sql).toContain(`drop policy if exists ${p}`)
      const triggers = [...sql.matchAll(/create trigger (\w+)/gi)].map((m) => m[1])
      for (const t of triggers) expect(sql).toContain(`drop trigger if exists ${t}`)
    }
  })

  it('turn RLS on for every new table', () => {
    for (const t of ['company_stage']) expect(m679).toContain(`alter table public.${t} enable row level security`)
    for (const t of ['company_email_consent', 'email_thread_team_private']) expect(m680).toContain(`alter table public.${t} enable row level security`)
  })

  it('redefine no function an earlier migration defined', () => {
    const earlier = new Set(all.filter((m) => m.file < '679').flatMap((m) => defined(m.sql)))
    for (const fn of [...defined(m679), ...defined(m680)]) expect(earlier.has(fn), fn).toBe(false)
  })
})

describe('679', () => {
  it('seeds Lead, Demo, Customer, Churned for every workspace and each new one, never over an admin’s list', () => {
    expect(m679).toContain("select array['Lead', 'Demo', 'Customer', 'Churned']")
    expect(m679).toContain('if exists (select 1 from public.company_stage s where s.workspace_id = p_workspace_id) then return; end if;')
    expect(m679).toContain('after insert on public.workspace')
  })

  it('lets an owner or admin alone edit the stages; deleting one leaves No stage', () => {
    expect(m679.match(/public\.get_member_role\(workspace_id\) in \('owner', 'admin'\)/g)?.length).toBe(4)
    expect(m679).toContain('stage_id uuid references public.company_stage(id) on delete set null')
    expect(m679).toContain("raise exception 'only a workspace owner or admin resets the company stages'")
  })

  it('keeps a stage and an owner to the company’s workspace, and revenue to {amount, currency}', () => {
    expect(m679).toContain("that stage is not one of this workspace''s company stages")
    expect(m679).toContain('the owner is not a member of this workspace')
    expect(m679).toContain("jsonb_typeof(revenue -> 'amount') = 'number'")
  })

  it('opens a company’s comments to whoever can see the company (its own row policy, read as the caller)', () => {
    expect(m679).toContain("alter type public.commentable_type add value if not exists 'company'")
    // The new value is never used as an enum literal in the same transaction.
    expect(m679).not.toContain("'company'::public.commentable_type")
    expect(m679).toContain('create policy comment_company_select on public.comment')
    expect(m679).toContain('and m.user_id = auth.uid()')
  })

  it('widens the notification target check by company and nothing else', () => {
    const prev = file('572').match(/notification_target_type_check check \(target_type in \(([\s\S]*?)\)\)/)![1]
    const next = m679.match(/notification_target_type_check check \(target_type in \(([\s\S]*?)\)\)/)![1]
    const list = (s: string) => s.split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean).sort()
    expect(list(next)).toEqual([...list(prev), 'company'].sort())
  })

  it('points a record pipeline’s row to one record, once per pipeline; deal pipelines untouched', () => {
    expect(m679).toContain("check (record_kind is null or (record_kind in ('company', 'contact') and table_kind = 'pipeline'))")
    expect(m679).toContain('where record_id is not null and archived_at is null')
    expect(m679).toContain('if v_kind is null then\n    new.record_id := null;\n    return new;')
    expect(m679).toContain("v_result := public.create_pipeline(p_workspace_id, p_name, v_stages, p_source, p_as_user, p_reason, false, 'USD')")
  })
})

describe('680', () => {
  const fence = m680.slice(m680.indexOf('create or replace function public.company_team_email_threads'))

  it('is off by default', () => {
    expect(m680).toContain('add column if not exists share_email_with_team boolean not null default false')
  })

  it('lists a thread only through every rule', () => {
    expect(fence).toContain('if p_user_id is null then return; end if;')
    expect(fence).toContain('if auth.uid() is not null and p_user_id is distinct from auth.uid() then return; end if;')
    expect(fence).toContain('public.company_visible_to(p_company_id, p_user_id, coalesce(p_grants, true))')
    expect(fence).toContain('where k.company_id = p_company_id and k.revoked_at is null')
    expect(fence).toContain('join public.member m on m.user_id = k.user_id and m.workspace_id = c.workspace_id')
    expect(fence).toContain('select 1 from public.email_thread_team_private x')
    expect(fence).toContain('public.contact_visible_to(ct.id, p_user_id, coalesce(p_grants, true))')
    expect(fence).toContain("coalesce(t.folder, 'inbox') not in ('spam', 'trash', 'drafts')")
  })

  it('never counts a teammate as "at the company", and never lists the workspace’s own company', () => {
    // Members' sign-in addresses and contacts that are a member, on both sides of the match.
    expect(fence).toContain('from public.member m join auth.users u on u.id = m.user_id')
    expect(fence).toContain('where ct.workspace_id = c.workspace_id and ct.member_id is not null')
    expect(fence).toContain('and ct.member_id is null')
    expect(fence).toContain('and lower(e) <> all (v_team)')
    expect(fence).toContain('where q.p <> all (v_team)')
    expect(fence).toContain('if c.share_email_with_team is not true or c.is_workspace_company then return; end if;')
    expect(m680).toContain("the workspace''s own company can''t share email with the team")
  })

  it('keeps guests out: no reading, no status, no switch, no consent', () => {
    expect(fence).toContain("and m.user_id = p_user_id and m.role <> 'guest' limit 1;")
    const status = m680.slice(m680.indexOf('function public.company_email_sharing_status'), m680.indexOf('function public.company_team_email_threads'))
    expect(status).toContain("and m.user_id = p_user_id and m.role <> 'guest' limit 1;")
    expect(m680.match(/where m\.id = v_member and m\.role = 'guest'/g)).toHaveLength(2)
    // A guest's old consent never shares either.
    expect(fence).toContain("join public.member m on m.user_id = k.user_id and m.workspace_id = c.workspace_id and m.role <> 'guest'")
  })

  it('lets a member agree, stop, or make a thread private only for themself', () => {
    expect(m680).toContain('values (v_ws, p_company_id, auth.uid())')
    expect(m680).toContain('where company_id = p_company_id and user_id = auth.uid() and revoked_at is null')
    expect(m680).toContain('where i.id = p_thread_index_id and i.user_id = auth.uid()')
    expect(m680).toContain('revoke all on table public.company_email_consent from public, anon, authenticated;')
    expect(m680).not.toMatch(/grant (insert|update|delete)[^;]*on table public\.company_email_consent to authenticated/)
  })

  it('keeps the index own-only: no policy on email_thread_index is added', () => {
    expect(m680).not.toMatch(/on public\.email_thread_index/)
  })
})
