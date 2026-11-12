/**
 * Migration 531, Tables phase 6: formula and rollup columns. Applied to DEV
 * after a rolled-back dry run, which read back _field_config_ok's answers (a
 * formula with an expression yes, without or over 2000 characters no; a
 * rollup with a relation and a known function yes, an unknown one no; a
 * text field with a rollup key no; relation and currency configs as
 * before), the floor refusing a formula's value, both constraints present
 * and no existing definition that fails the new shape. These hold the shape
 * that made it so.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { CUSTOM_FIELD_TYPES } from '@/lib/crm/custom-field-types'
import { ROLLUP_FNS } from '../computed'
import { COMPUTED_COLUMN_TYPES } from '../types'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('531_'))!.sql
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])

function newest(re: RegExp): { file: string; text: string } {
  for (const m of [...all].reverse()) {
    const hit = re.exec(m.sql)
    if (hit) return { file: m.file, text: m.sql.slice(hit.index) }
  }
  throw new Error(`nothing matches ${re}`)
}

describe('531: formula and rollup columns', () => {
  it('531’s type CHECK takes every field type and the two computed ones, and the newest keeps them', () => {
    const own = quoted(/add constraint custom_field_definition_type_check\s+check \(field_type in \(([^)]*)\)\)/i.exec(sql)![1])
    expect(own).toEqual([...CUSTOM_FIELD_TYPES, ...COMPUTED_COLUMN_TYPES])
    // A later restatement (by file name) may add types; it keeps these.
    const { text } = newest(/add constraint custom_field_definition_type_check\s+check \(field_type in \(([^)]*)\)\)/i)
    const list = quoted(/check \(field_type in \(([^)]*)\)\)/i.exec(text)![1])
    for (const t of [...CUSTOM_FIELD_TYPES, ...COMPUTED_COLUMN_TYPES]) expect(list).toContain(t)
  })

  it('only a table’s column is computed', () => {
    expect(sql).toMatch(/add constraint custom_field_definition_computed_table check \(field_type not in \('formula', 'rollup'\) or table_id is not null\);/)
  })

  // Later restatements (phase 7's 540 and 549) add their own keys: the newest
  // by file name must still carry 531's formula and rollup rules.
  it('the newest _field_config_ok keeps 523’s rules and 531’s formula and rollup rules', () => {
    const { text } = newest(/create or replace function public\._field_config_ok\(/i)
    const body = text.slice(0, text.indexOf('$$;'))
    for (const rule of ["(p_type = 'relation') = (p_config ? 'target')", "jsonb_typeof(p_config -> 'required_when') = 'object'", "(p_config ->> 'currency') ~ '^[A-Z]{3}$'"]) expect(body).toContain(rule)
    expect(body).toContain("(p_type = 'formula') = (p_config ? 'expression')")
    expect(body).toContain("char_length(p_config ->> 'expression') between 1 and 2000")
    const fns = quoted(/\(p_config ->> 'fn'\) in \(([^)]*)\)/.exec(body)![1])
    expect(fns).toEqual([...ROLLUP_FNS])
    const keys = quoted(/k not in \(([^)]*)\)/.exec(body)![1])
    for (const k of ['currency', 'target', 'multiple', 'required_when', 'expression', 'relation', 'fn', 'field']) expect(keys).toContain(k)
    expect(body).toContain("((p_type = 'rollup') = (p_config ? 'relation'))")
    expect(body).toContain("(not (p_config ? 'field') or p_type = 'rollup')")
  })

  it('writes nothing else and has no backslash', () => {
    expect(sql).not.toMatch(/apply_data_ops|_data_apply|create_data_table/)
    expect(sql).not.toContain('\\')
  })
})
