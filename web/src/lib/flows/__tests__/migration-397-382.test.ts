/**
 * Migrations 397 (lens_finding) and 382 (the two lens skills) and the app
 * agree. The SQL is applied nowhere yet; this pins the files so a later edit
 * can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { LENS_KEYS, MARKETING_ITEM_KINDS } from '../lenses'
import { FEATURES } from '@/lib/editions/manifest'

const read = (f: string) => readFileSync(resolve(__dirname, '../../../../supabase/migrations', f), 'utf8')
const body = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')

describe('migration 397: lens_finding', () => {
  const sql = body(read('397_lens_finding.sql'))

  it('belongs to a workspace and a member, cascades with them, and keeps its flow and capture', () => {
    expect(sql).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(sql).toContain('member_id uuid not null references public.member(id) on delete cascade')
    expect(sql).toContain('flow_id uuid references public.flow(id) on delete set null')
    expect(sql).toContain('capture_id uuid references public.captures(id) on delete cascade')
  })

  it('one row per (flow, capture, lens, item): the upsert key lens-deliver.ts names', () => {
    expect(sql).toContain('create unique index if not exists lens_finding_item_uidx on public.lens_finding (flow_id, capture_id, lens, item_hash) nulls not distinct')
    const deliver = readFileSync(resolve(__dirname, '../lens-deliver.ts'), 'utf8')
    expect(deliver).toContain("onConflict: 'flow_id,capture_id,lens,item_hash'")
  })

  it("the statuses the post pass and the marketing batch use; RLS on, owner reads, server writes", () => {
    expect(sql).toContain("check (status in ('new', 'claimed', 'used', 'dismissed'))")
    expect(sql).toContain('alter table public.lens_finding enable row level security')
    expect(sql).toContain('for select to authenticated using (member_id in (select m.id from public.member m where m.user_id = auth.uid()))')
    expect(sql).toContain('revoke all on public.lens_finding from anon;')
    expect(sql).toContain('revoke insert, update, delete on public.lens_finding from authenticated')
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/)
  })

  it('every lens key and marketing kind fits the CHECKs', () => {
    const lensRe = /^[a-z][a-z0-9_-]{0,39}$/
    const kindRe = /^[a-z][a-z0-9_]{0,39}$/
    for (const k of LENS_KEYS) expect(k).toMatch(lensRe)
    for (const k of [...MARKETING_ITEM_KINDS, 'post_moment']) expect(k).toMatch(kindRe)
  })
})

describe('migration 397: the two atomic budgets (review S4, S5)', () => {
  const sql = body(read('397_lens_finding.sql'))

  it('claim_lens_batch: one batch a UTC day per workspace and lens, under a lock, 30 days at most, testimonials never', () => {
    expect(sql).toContain("perform pg_advisory_xact_lock(hashtextextended('lens_batch:' || p_workspace_id::text || ':' || p_lens, 0))")
    expect(sql).toContain("status in ('claimed', 'used') and used_at >= v_day_start")
    expect(sql).toContain("kind <> 'testimonial'")
    expect(sql).toContain("created_at >= now() - interval '30 days'")
    expect(sql).toContain('for update skip locked')
  })

  it('insert_post_draft_card: counts only pending, unexpired post cards under the member lock, then inserts', () => {
    expect(sql).toContain("perform pg_advisory_xact_lock(hashtextextended('post_draft_cards:' || v_member::text, 0))")
    expect(sql).toContain("and (payload ? 'post_draft') and (expires_at is null or expires_at > now())")
    expect(sql).toContain("if v_open >= p_cap then return 'full'")
    expect(sql).toContain("exception when unique_violation then return 'duplicate'")
  })

  it('both are service role only', () => {
    expect(sql).toContain('revoke all on function public.claim_lens_batch(uuid, text, integer) from public, anon, authenticated')
    expect(sql).toContain('revoke all on function public.insert_post_draft_card(jsonb, integer) from public, anon, authenticated')
    expect(sql).toContain('grant execute on function public.claim_lens_batch(uuid, text, integer) to service_role')
    expect(sql).toContain('grant execute on function public.insert_post_draft_card(jsonb, integer) to service_role')
  })

  it('the app calls them by these names and arguments', () => {
    const deliver = readFileSync(resolve(__dirname, '../deliver-connector.ts'), 'utf8')
    const lens = readFileSync(resolve(__dirname, '../lens-deliver.ts'), 'utf8')
    expect(deliver).toContain("supabase.rpc('insert_post_draft_card', {")
    // The cap is the open-post budget, or a weekly pass's slots (P9).
    expect(deliver).toContain('p_cap: cap')
    expect(deliver).toContain('ctx.postCap ?? MAX_OPEN_POST_DRAFTS')
    expect(lens).toContain("supabase.rpc('claim_lens_batch', { p_workspace_id: ctx.workspaceId, p_lens: 'marketing', p_limit: MAX_BATCH_FINDINGS })")
  })
})

describe('migration 382: the lens skills', () => {
  const raw = read('382_lens_skills.sql')

  it('seeds content-lens and marketing-lens as system skills naming their lens, gated with Flows', () => {
    const rows = [...raw.matchAll(/'([0-9a-f-]{36})'::uuid,\s*\$name\$[\s\S]*?\$slug\$([a-z-]+)\$slug\$[\s\S]*?\$cfg\$([\s\S]*?)\$cfg\$/g)].map((m) => ({ id: m[1], slug: m[2], cfg: JSON.parse(m[3]) }))
    expect(rows.map((r) => [r.slug, r.cfg.lens])).toEqual([
      ['content-lens', 'content'],
      ['marketing-lens', 'marketing'],
    ])
    for (const r of rows) {
      expect(r.cfg.enabled_tools).toEqual(['captures'])
      expect(r.cfg.output_contract).toBe('prose')
      expect(FEATURES.flows.systemRecipeIds).toContain(r.id)
    }
    expect(body(raw)).toContain("'skill'::public.recipe_category, true, false, 0, 'workspace'::public.recipe_visibility")
    expect(body(raw)).toContain('ON CONFLICT (id) DO NOTHING')
  })

  it('holds no backslash (one MCP transport decodes escapes)', () => {
    expect(raw).not.toContain('\\')
  })
})
