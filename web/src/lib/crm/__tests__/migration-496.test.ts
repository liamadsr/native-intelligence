/**
 * Migration 496, custom fields on any kind: the database half of the
 * registry's `customFields` flag. Its behaviour was run on DEV inside a
 * rolled-back transaction (a capture definition refused, an array value
 * refused, a member setting a task's field, a view grantee's write to a
 * private document and a company changing no row, an initiative that isn't
 * theirs changing no row, the company gate with and without the grant arm);
 * these hold the shape that made it right.
 */
import { describe, expect, it } from 'vitest'
import { CUSTOM_FIELD_ENTITY_TYPES, ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import { TABLE_COLUMN_ENTITY_TYPE } from '@/lib/tables/types'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('496_'))!.sql

/** The newest CHECK list for custom_field_definition.entity_type, across every migration. */
function latestEntityCheck(): { file: string; kinds: string[] } {
  let found: { file: string; kinds: string[] } | null = null
  for (const m of all) {
    const re = /add constraint custom_field_definition_entity_check\s+check \(entity_type in \(([^)]*)\)\)/g
    for (const hit of m.sql.matchAll(re)) {
      found = { file: m.file, kinds: [...hit[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) }
    }
  }
  return found!
}

describe('migration 496: custom fields on any kind', () => {
  it('the newest entity_type CHECK lists exactly the kinds the registry marks customFields, and a table column', () => {
    const check = latestEntityCheck()
    // 520 added a table's columns (entity_type data_row, with a table_id); 549 took deals out (a deal is a pipeline's row).
    expect(check.file.startsWith('549_')).toBe(true)
    expect(new Set(check.kinds)).toEqual(new Set([...CUSTOM_FIELD_ENTITY_TYPES, TABLE_COLUMN_ENTITY_TYPE]))
    expect(check.kinds).toHaveLength(CUSTOM_FIELD_ENTITY_TYPES.length + 1)
    expect(CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).not.toContain(TABLE_COLUMN_ENTITY_TYPE)
  })

  it('every kind with the flag has its custom_fields jsonb object column, in 473 or here', () => {
    const everything = all.map((m) => m.sql).join('\n')
    // 473 created deal with the column; every other kind adds it.
    const dealTable = /create table if not exists public\.deal \(([\s\S]*?)\n\);/.exec(everything)?.[1] ?? ''
    expect(dealTable).toContain("custom_fields jsonb not null default '{}'::jsonb")
    for (const e of ENTITY_REGISTRY.filter((x) => x.customFields)) {
      if (e.id !== 'deal') {
        expect(everything, e.id).toContain(`alter table public.${e.table} add column if not exists custom_fields jsonb not null default '{}'::jsonb;`)
      }
      expect(everything, e.id).toMatch(new RegExp(`add constraint ${e.table}_custom_fields_object check \\(jsonb_typeof\\(custom_fields\\) = 'object'\\)`))
    }
  })

  it('adds the four new columns without a rewrite and validates their CHECK separately', () => {
    for (const t of ['actions', 'projects', 'initiative', 'document']) {
      expect(sql, t).toContain(`alter table public.${t} add column if not exists custom_fields jsonb not null default '{}'::jsonb;`)
      expect(sql, t).toContain(`alter table public.${t} drop constraint if exists ${t}_custom_fields_object;`)
      expect(sql, t).toMatch(new RegExp(`add constraint ${t}_custom_fields_object check \\(jsonb_typeof\\(custom_fields\\) = 'object'\\) not valid;`))
      expect(sql, t).toContain(`alter table public.${t} validate constraint ${t}_custom_fields_object;`)
    }
  })

  it('changes no policy and no table grant: the values follow each record’s own write rule', () => {
    expect(sql).not.toMatch(/create policy|drop policy|alter policy/i)
    expect(sql).not.toMatch(/grant [a-z, ]+ on table/i)
  })

  it('gives the company write gate no grant arm, and asks each contact without one either', () => {
    const fn = /create or replace function public\.company_visible_to_ungranted[\s\S]*?\$function\$;/.exec(sql)?.[0] ?? ''
    expect(fn).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(fn).not.toMatch(/entity_grant|has_entity_grant/)
    expect(fn).toContain("IF v_role IN ('owner','admin') THEN RETURN TRUE; END IF;")
    expect(fn).toContain('public.contact_visible_to_ungranted(ct.id, p_user_id)')
    expect(fn).not.toMatch(/public\.contact_visible_to\(/)
    // No user, no write.
    expect(fn).toContain('IF p_user_id IS NULL THEN RETURN FALSE; END IF;')
    expect(sql).toContain('revoke all on function public.company_visible_to_ungranted(uuid, uuid) from public, anon;')
  })

  it('is re-runnable and carries no backslash', () => {
    expect(sql).not.toContain('\\')
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';")
    expect(sql).toContain('drop constraint if exists custom_field_definition_entity_check;')
  })
})
