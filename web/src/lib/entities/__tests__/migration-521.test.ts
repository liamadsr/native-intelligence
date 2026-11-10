/**
 * Migration 521, the activity log records tables and their rows. Run on DEV
 * inside a rolled-back transaction with 520 (a new table logged as created by
 * its maker; three new rows; a rename and its undo; a value change naming its
 * key; an import's rows logging no creation; another member seeing a private
 * table's row activity only once a grant opened the table, and a member
 * without one never). These hold its shape, on top of what 488, 489 and 497
 * hold for every kind.
 */
import { describe, expect, it } from 'vitest'
import { ACTIVITY_ENTITY_TYPES, ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('521_'))!.sql
const KINDS = ['data_table', 'data_row'] as const
const tableOf = new Map<string, string>(ENTITY_REGISTRY.map((e) => [e.id, e.table]))
const fns = [...sql.matchAll(/create or replace function public\.(entity_activity_[a-z_]+)\(\)[\s\S]*?\n\$\$;/g)].map((m) => ({ name: m[1], body: m[0] }))

describe('migration 521: tables and rows in the activity log', () => {
  it('logs both kinds, which the registry marks activity', () => {
    for (const k of KINDS) expect(ACTIVITY_ENTITY_TYPES as readonly string[], k).toContain(k)
    for (const k of KINDS) {
      const t = tableOf.get(k)!
      expect(sql, k).toMatch(new RegExp(`create trigger entity_activity_insert\\s+after insert on public\\.${t}\\s+referencing new table as new_rows\\s+for each statement execute function public\\.entity_activity_${t}_insert\\(\\);`))
      expect(sql, k).toMatch(new RegExp(`create trigger entity_activity_update\\s+after update of [a-z_, ]+workspace_id on public\\.${t}\\s+for each row\\s+when \\(`))
      expect(sql, k).toContain(`drop trigger if exists entity_activity_insert on public.${t};`)
      expect(sql, k).toContain(`drop trigger if exists entity_activity_update on public.${t};`)
    }
  })

  it('updates log only when a column that matters changed, and a move carries the history', () => {
    const updates = [...sql.matchAll(/create trigger entity_activity_update\s+after update of ([a-z_, ]+) on public\.([a-z_]+)\s+for each row\s+when \(([\s\S]*?)\)\s+execute function public\.(\w+)\(\)/g)]
    expect(updates).toHaveLength(2)
    for (const [, columns, table, when, fname] of updates) {
      for (const col of columns.split(',').map((c) => c.trim())) expect(when, `${table}.${col}`).toContain(`old.${col} is distinct from new.${col}`)
      const body = fns.find((f) => f.name === fname)?.body ?? ''
      expect(body, fname).toContain(`perform public.entity_activity_follow('${table}', new.id, old.workspace_id, new.workspace_id);`)
    }
  })

  it('keeps 489’s rules in every function: definer, pinned path, no subtransaction, writable first', () => {
    expect(fns.length).toBe(5)
    for (const { name, body } of fns) {
      expect(body, name).toMatch(/security definer\s+set search_path = public, pg_temp/)
      expect(body, name).not.toMatch(/\bexception\b/i)
      expect(body, name).toMatch(/public\.entity_activity_writable\((n|new)\.workspace_id\)/)
      expect(sql, name).toContain(`revoke all on function public.${name}() from public, anon, authenticated;`)
    }
  })

  it('logs no creation for an import’s rows or a new table’s first rows, and a row’s values through 497’s function', () => {
    const insert = fns.find((f) => f.name === 'entity_activity_data_row_insert')!.body
    expect(insert).toContain("if coalesce(current_setting('dial8.data_source', true), '') = 'import' then")
    // Nor a new table's first rows: the table's own 'created' says it (520 sets the table).
    expect(insert).toContain("and n.table_id::text is distinct from nullif(current_setting('dial8.data_new_table', true), '');")
    expect(all.find((m) => m.file.startsWith('520_'))!.sql).toContain("perform set_config('dial8.data_new_table', v_table::text, true);")
    expect(sql).toMatch(/create trigger entity_activity_custom_fields\s+after update of custom_fields on public\.data_row\s+for each row\s+when \(old\.custom_fields is distinct from new\.custom_fields\)\s+execute function public\.entity_activity_custom_fields_update\('data_row'\);/)
  })

  it('is the newest edge trigger, and its kinds are every logged kind', () => {
    const newest = [...all].reverse().find((m) => m.sql.includes('create or replace function public.entity_activity_entity_link_insert()'))!
    expect(newest.file.startsWith('521_')).toBe(true)
    const list = /kinds text\[\] := array\[([^\]]+)\]/.exec(sql)?.[1] ?? ''
    expect(new Set(list.split(',').map((s) => s.trim().replace(/'/g, '')))).toEqual(new Set(ACTIVITY_ENTITY_TYPES))
  })

  it('is the newest read policy, and probes the tables like every kind with a per-record rule', () => {
    const newest = [...all].reverse().find((m) => m.sql.includes('create policy entity_activity_member_select'))!
    expect(newest.file.startsWith('521_')).toBe(true)
    const policy = /create policy entity_activity_member_select on public\.entity_activity\s+for select using \(([\s\S]*?)\n  \);/.exec(sql)?.[1] ?? ''
    for (const k of KINDS) {
      const t = tableOf.get(k)!
      expect(policy, k).toContain(`when '${k}' then exists (select 1 from public.${t} x where x.id = entity_activity.entity_id offset 0)`)
      expect(policy, `${k} as the other`).toContain(`= '${k}'\n        then exists (select 1 from public.${t} x where x.id = coalesce(detail ->> 'source_id', detail ->> 'other_id')::uuid offset 0)`)
    }
    // Every logged kind is named once in the record arm.
    for (const k of ACTIVITY_ENTITY_TYPES) expect(policy, k).toMatch(new RegExp(`when '${k}' then (true|exists)`))
    expect(policy.match(/else false/g)).toHaveLength(2)
    for (const line of policy.split('\n').filter((l) => l.includes('exists (select 1 from'))) expect(line).toMatch(/ offset 0\)$/)
  })

  it('is re-runnable and carries no backslash', () => {
    expect(sql).not.toContain('\\')
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';")
    expect(sql).toContain('drop policy if exists entity_activity_member_select on public.entity_activity;')
    expect(sql).toContain('drop trigger if exists entity_activity_custom_fields on public.data_row;')
  })
})
