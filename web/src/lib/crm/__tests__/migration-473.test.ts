import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FILTERABLE_FIELDS } from '@/lib/views/types'
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '../custom-fields'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/473_deals_pipelines_custom_fields.sql'), 'utf8')

describe('migration 473 (deals, pipelines, custom fields)', () => {
  it('creates the five tables with RLS on and a member policy each', () => {
    for (const t of ['deal_pipeline', 'deal_stage', 'deal', 'deal_event', 'custom_field_definition']) {
      expect(sql, t).toContain(`create table if not exists public.${t} (`)
      expect(sql, t).toContain(`alter table public.${t} enable row level security;`)
      expect(sql, t).toMatch(new RegExp(`create policy \\w+ on public\\.${t}\\s+for all to authenticated\\s+using \\(public\\.is_workspace_member\\(workspace_id\\)\\)`))
    }
  })

  it('pins the stage kinds, deal sources and custom field types the code uses', () => {
    expect(sql).toContain("check (kind in ('open', 'won', 'lost'))")
    expect(sql).toContain(`check (entity_type in (${CUSTOM_FIELD_ENTITIES.map((e) => `'${e}'`).join(', ')}))`)
    expect(sql).toContain(`check (field_type in (${CUSTOM_FIELD_TYPES.map((e) => `'${e}'`).join(', ')}))`)
    const sourceOptions = FILTERABLE_FIELDS.deal.find((f) => f.field === 'source')?.options as string[]
    expect(sql).toContain(`check (source in (${sourceOptions.map((e) => `'${e}'`).join(', ')}))`)
    expect(sql).toContain("check (source in ('person', 'agent', 'email', 'capture', 'sms'))")
  })

  it('seeds the default pipeline on first use, once, with Lead … Lost', () => {
    expect(sql).toContain('create unique index if not exists deal_pipeline_one_default')
    expect(sql).toContain('on conflict (workspace_id) where is_default do nothing')
    for (const s of ["'Lead', 0, 'open'", "'Qualified', 1, 'open'", "'Proposal', 2, 'open'", "'Won', 3, 'won'", "'Lost', 4, 'lost'"]) expect(sql).toContain(s)
  })

  it('adds custom_fields to contact and company, deal to the view enum, and deal to realtime', () => {
    expect(sql).toContain("alter table public.contact add column if not exists custom_fields jsonb not null default '{}'::jsonb;")
    expect(sql).toContain("alter table public.company add column if not exists custom_fields jsonb not null default '{}'::jsonb;")
    expect(sql).toContain("alter type public.view_entity_type add value if not exists 'deal';")
    expect(sql).toContain('alter publication supabase_realtime add table public.deal;')
  })

  it('keeps the change log append-only for members, and the trigger merge-aware', () => {
    expect(sql).toContain('revoke update, delete on table public.deal_event from authenticated;')
    expect(sql).toContain('grant update (undone_at) on table public.deal_event to authenticated;')
    expect(sql).toMatch(/create or replace function public\.deal_before_write\(\)[\s\S]*?security definer[\s\S]*?if public\._wsmerge_active\(\) then/)
    expect(sql).toContain("raise exception 'deal owner belongs to another workspace'")
    expect(sql).toContain("raise exception 'deal company belongs to another workspace'")
  })

  it('makes workspace merge carry deals: stages fold by name before the generic re-stamp', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public._wsmerge_deals(p_source uuid, p_dest uuid)')
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_deals(uuid, uuid) FROM PUBLIC, anon, authenticated;')
    const restamp = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public._wsmerge_generic_restamp('))
    expect(restamp.indexOf('public._wsmerge_deals(p_source, p_dest)')).toBeLessThan(restamp.indexOf('FOR r IN'))
    // The legacy (team_id / status_id) deal branches need the legacy column now.
    for (const fn of ['repair_cross_workspace_drift', '_wsmerge_teams_finish']) {
      const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`))
      expect(body, fn).toContain("table_name = 'deal' AND column_name = 'team_id'")
    }
    const sweep = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.workspace_integrity_sweep('))
    expect(sweep.slice(0, sweep.indexOf('\n$$;'))).not.toContain("'deal.team'")
    expect(sweep).toContain("'deal.stage'")
  })

  it('is re-runnable: every constraint is dropped before it is added', () => {
    const added = [...sql.matchAll(/add constraint (\w+)/g)].map((m) => m[1])
    expect(added.length).toBeGreaterThan(10)
    for (const name of added) expect(sql, name).toContain(`drop constraint if exists ${name};`)
    expect(sql).not.toMatch(/^\s*create table public\./m)
  })
})
