/**
 * Migration 497, the activity log records a custom field change. Run on DEV
 * inside a rolled-back transaction (a member setting a task's field: one
 * 'updated' row naming the key, by that member; the same value again and a
 * rename: none; a suggested task: none; a service-role write: a system row
 * naming only the keys that changed). These hold its shape.
 */
import { describe, expect, it } from 'vitest'
import { ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import { FEED_ACTIONS } from '@/lib/entities/feed-model'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('497_'))!.sql
const fn = /create or replace function public\.entity_activity_custom_fields_update\(\)[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? ''

/** The newest entity_activity action CHECK, across every migration. */
function latestActionCheck(): string[] {
  let kinds: string[] = []
  for (const m of all) {
    for (const hit of m.sql.matchAll(/constraint entity_activity_action_check check \(action in \(([^)]*)\)\)/g)) {
      kinds = [...hit[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
    }
  }
  return kinds
}

describe('migration 497: custom field changes in the activity log', () => {
  it('the newest action CHECK is exactly the feed’s vocabulary', () => {
    expect(new Set(latestActionCheck())).toEqual(new Set(FEED_ACTIONS))
    expect(FEED_ACTIONS).toContain('updated')
  })

  it('triggers on exactly the kinds that are logged AND take fields, each passing its own type', () => {
    const triggers = [...sql.matchAll(/create trigger entity_activity_custom_fields\s+after update of custom_fields on public\.([a-z_]+)\s+for each row\s+when \(old\.custom_fields is distinct from new\.custom_fields\)\s+execute function public\.entity_activity_custom_fields_update\('([a-z_]+)'\);/g)]
    const want = ENTITY_REGISTRY.filter((e) => e.activity && e.customFields)
    expect(new Set(triggers.map((t) => t[2]))).toEqual(new Set(want.map((e) => e.id)))
    for (const [, table, type] of triggers) expect(table, type).toBe(want.find((e) => e.id === type)!.table)
    for (const e of want) expect(sql).toContain(`drop trigger if exists entity_activity_custom_fields on public.${e.table};`)
  })

  it('keeps 489’s rules: definer, pinned path, no subtransaction, writable first, no move', () => {
    expect(fn).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(fn).not.toMatch(/\bexception\b/i)
    expect(fn).toContain('if old.workspace_id is distinct from new.workspace_id then\n    return null;')
    expect(fn).toContain('if not public.entity_activity_writable(new.workspace_id) then')
    expect(fn).toContain('select * into a from public.entity_activity_actor();')
    expect(fn).toContain("(to_jsonb(new) ->> 'confirmation') = 'suggested'")
    expect((fn.match(/insert into public\.entity_activity/g) ?? []).length).toBe(1)
    expect(sql).toContain('revoke all on function public.entity_activity_custom_fields_update() from public, anon, authenticated;')
  })

  it('logs keys only, at most 20, and nothing when no key changed', () => {
    expect(fn).toContain("jsonb_build_object('fields', v_fields)")
    expect(fn).toContain('limit 20')
    expect(fn).toContain('if jsonb_array_length(v_fields) = 0 then')
    expect(fn).not.toMatch(/new\.custom_fields ->> /)
  })

  it('is re-runnable and carries no backslash', () => {
    expect(sql).not.toContain('\\')
    expect(sql).toContain('alter table public.entity_activity drop constraint if exists entity_activity_action_check;')
  })
})
