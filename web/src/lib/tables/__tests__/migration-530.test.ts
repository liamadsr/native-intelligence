/**
 * Migration 530, Tables phase 5: a guest's or a linked agent's turn writes a
 * table without the person's grants. Run on DEV inside a rolled-back
 * transaction (a table shared with a member by an edit grant: written with
 * grants, refused as not found without; a workspace table written without
 * grants; a new table's reason in its first change). These hold its shape.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('530_'))!.sql
/** The newest definition by file name: the one a database replayed in order ends up with. */
const newest = (name: string) => {
  const head = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i')
  for (const m of [...all].reverse()) {
    const hit = head.exec(m.sql)
    if (hit) return { file: m.file, text: hit[0] }
  }
  return { file: '', text: '' }
}

describe('migration 530: table writes without grants', () => {
  it('is the newest definition of both writers, with the old signatures dropped', () => {
    for (const name of ['apply_data_ops', 'create_data_table']) expect(newest(name).file, name).toBe('530_data_ops_grants.sql')
    expect(sql).toContain('drop function if exists public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid);')
    expect(sql).toContain('drop function if exists public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid);')
    expect(sql).toContain('grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean) to authenticated, service_role;')
    expect(sql).toContain('grant execute on function public.create_data_table(uuid, text, text, text, text, jsonb, text, uuid, text, boolean) to authenticated, service_role;')
    for (const f of ['apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid, boolean)', 'create_data_table(uuid, text, text, text, text, jsonb, text, uuid, text, boolean)']) {
      expect(sql, f).toContain(`revoke all on function public.${f} from public, anon;`)
    }
  })

  it('takes p_grants, default true, and without grants a table read only through one is not found', () => {
    const apply = newest('apply_data_ops').text
    expect(apply).toContain('p_grants boolean default true')
    expect(apply).toContain('or (p_grants is false and not public.data_table_visible_ungranted(t.id, v_user)) then')
    // The rest of 520's checks stay.
    expect(apply).toContain('public.data_table_visible_to(t.id, v_user)')
    expect(apply).toContain('public.data_table_editable_by(t.id, v_user)')
    expect(apply).toContain("using errcode = 'PT409', detail = t.version::text;")
    expect(apply).toContain('v_user uuid := public._data_writer(p_as_user);')
  })

  it("turns the grants off for the batch's relation checks (524 reads dial8.data_grants)", () => {
    for (const name of ['apply_data_ops', 'create_data_table']) {
      const text = newest(name).text
      expect(text, name).toContain("perform set_config('dial8.data_grants', case when p_grants is false then 'off' else '' end, true);")
      // Set before the batch runs, so the row triggers see it.
      expect(text.indexOf("'dial8.data_grants'"), name).toBeLessThan(text.indexOf('public._data_apply('))
    }
    // The flag 524's relation check reads is the same one.
    const sync = newest('custom_field_links_sync').text
    expect(sync).toContain("coalesce(current_setting('dial8.data_grants', true), '') <> 'off'")
  })

  it("logs a new table's reason, and keeps the guest and source checks", () => {
    const create = newest('create_data_table').text
    expect(create).toContain('p_reason text default null')
    expect(create).toContain("nullif(btrim(coalesce(p_reason, '')), '')")
    expect(create).toContain("if v_role = 'guest' then")
    expect(create).toContain("if coalesce(p_source, '') not in ('person', 'agent', 'import', 'email', 'capture', 'sms') then")
  })
})
