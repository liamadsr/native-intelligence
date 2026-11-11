/**
 * Migration 520, Tables phase 1: tables, rows, columns as custom fields, the
 * undo log and the one write path. Its behaviour was run on DEV inside a
 * rolled-back transaction, as three real members (a table made with a select
 * column and three rows; an update; a stale version refused with PT409 and
 * the version now; a value that doesn't fit refused; a no-op batch keeping
 * the version; an option still in use refused with its count; a move between
 * two rows landing on their exact midpoint; a deleted column refusing writes
 * and coming back with its values; an undo marking its change, refused twice
 * and refused on an undo; an import logging no row creations; another member
 * reading and writing the workspace table but seeing nothing of a private one,
 * not even its columns or changes; direct writes refused; a grant opening the
 * private table to read only; the service-role fence; a guest reading but not
 * writing; the service role writing for a named user). These hold the shape
 * that made it so.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { CUSTOM_FIELD_TYPES } from '@/lib/crm/custom-fields'
import { DATA_CHANGE_SOURCES, DATA_OP_KINDS, DATA_TABLE_VISIBILITIES, TABLE_LIMITS } from '../types'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('520_'))!.sql
const fn = (name: string) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, 'i').exec(sql)?.[0] ?? ''

describe('migration 520: tables, rows and one write path', () => {
  it('creates the three tables, each with RLS on, read through my_data_table_ids, written by nobody but the functions', () => {
    for (const t of ['data_table', 'data_row', 'data_change']) {
      expect(sql, t).toContain(`create table if not exists public.${t} (`)
      expect(sql, t).toContain(`alter table public.${t} enable row level security;`)
    }
    expect(sql).toMatch(/create policy data_table_select on public\.data_table\s+for select to authenticated\s+using \(id = any \(\(select public\.my_data_table_ids\(\)\)::uuid\[\]\)\);/)
    for (const t of ['data_row', 'data_change']) {
      expect(sql, t).toMatch(new RegExp(`create policy ${t}_select on public\\.${t}\\s+for select to authenticated\\s+using \\(table_id = any \\(\\(select public\\.my_data_table_ids\\(\\)\\)::uuid\\[\\]\\)\\);`))
    }
    // SELECT only for a member: every write is apply_data_ops or create_data_table.
    expect(sql).toContain('revoke all on table public.data_table, public.data_row, public.data_change from anon, authenticated;')
    expect(sql).toContain('grant select on table public.data_table, public.data_row, public.data_change to authenticated;')
    expect(sql).not.toMatch(/grant (insert|update|delete)[^;]*on table public\.data_/)
    expect(sql).not.toMatch(/create policy \w+ on public\.data_(table|row|change)\s+for (insert|update|delete|all)/)
  })

  it('pins the visibilities, sources, limits and column types the code uses', () => {
    expect(sql).toContain(`check (visibility in (${DATA_TABLE_VISIBILITIES.map((v) => `'${v}'`).join(', ')}))`)
    expect(sql).toContain(`check (source in (${DATA_CHANGE_SOURCES.map((v) => `'${v}'`).join(', ')}))`)
    expect(sql).toContain(`check (char_length(btrim(name)) between 1 and ${TABLE_LIMITS.name})`)
    expect(sql).toContain(`check (char_length(title) <= ${TABLE_LIMITS.title})`)
    expect(sql).toContain(`check (reason is null or char_length(reason) <= ${TABLE_LIMITS.reason})`)
    expect(sql).toContain(`jsonb_array_length(p_ops) > ${TABLE_LIMITS.opsPerBatch}`)
    expect(sql).toContain(`jsonb_array_length(op -> 'rows') > ${TABLE_LIMITS.rowsPerOp}`)
    expect(sql).toContain("add constraint data_row_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');")
    expect(sql).toContain("add constraint data_change_changes_array check (jsonb_typeof(changes) = 'array');")
    // The SQL value check knows every custom field type.
    const ok = fn('_data_value_ok')
    for (const t of CUSTOM_FIELD_TYPES) expect(ok, t).toContain(`when '${t}' then`)
  })

  it('applies every op the app sends, and refuses any other', () => {
    const apply = fn('_data_apply')
    for (const kind of DATA_OP_KINDS) expect(apply, kind).toMatch(new RegExp(`'${kind}'`))
    expect(apply).toContain("raise exception 'unknown op %'")
    // Rows go in one statement, so the activity trigger runs once per batch.
    expect(apply).toMatch(/insert into public\.data_row \(id, workspace_id, table_id, title, custom_fields, position, created_by_user_id\)\s+select/)
    // A move takes the exact midpoint: a product, never a division.
    expect(apply).toContain('(v_pos + v_next) * 0.5')
    expect(apply).not.toMatch(/\/ 2\b/)
    // An option still in use can't go; a deleted column takes no values.
    expect(apply).toContain('still % an option that would go')
    expect(fn('_data_merge_values')).toContain('and d.deleted_at is null')
  })

  it('makes one change per batch against a locked, checked version, and a stale one a 409', () => {
    const apply = fn('apply_data_ops')
    expect(apply).toMatch(/security definer\s+set search_path = public, pg_temp/)
    expect(apply).toContain('select * into t from public.data_table where id = p_table_id for update;')
    expect(apply).toContain("using errcode = 'PT409', detail = t.version::text;")
    expect(apply).toContain('public.data_table_visible_to(t.id, v_user)')
    expect(apply).toContain('public.data_table_editable_by(t.id, v_user)')
    // An unseen table is not found; a seen one the caller can't change is 42501.
    expect(apply.indexOf("errcode = 'P0002'")).toBeLessThan(apply.indexOf("errcode = '42501';\n  end if;\n  if p_base_version"))
    // Nothing changed: no version bump, no log row.
    expect(apply).toContain("if jsonb_array_length(v_result -> 'changes') = 0 then")
    expect(apply).toContain('update public.data_table set version = version + 1')
    expect(apply).toContain('update public.data_change set undone_at = now() where id = p_undo_of;')
    for (const refusal of ["'that change was itself an undo'", "'that change was already undone'"]) expect(apply).toContain(refusal)
    expect(sql).toContain('revoke all on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid) from public, anon;')
    expect(sql).toContain('grant execute on function public.apply_data_ops(uuid, bigint, jsonb, text, text, uuid, uuid) to authenticated, service_role;')
  })

  it('lets only the service role name the user it writes for', () => {
    expect(fn('_data_writer')).toContain('select coalesce(auth.uid(), case when auth.uid() is null then p_as_user end);')
    expect(sql).toContain('revoke all on function public._data_writer(uuid) from public, anon, authenticated;')
    for (const name of ['apply_data_ops', 'create_data_table']) expect(fn(name), name).toContain('v_user uuid := public._data_writer(p_as_user);')
    // The internals are nobody's to call.
    for (const name of ['_data_apply(uuid, uuid, uuid, jsonb)', '_data_value_ok(text, text[], jsonb)', '_data_merge_values(public.data_table, jsonb, jsonb)']) {
      expect(sql, name).toContain(`revoke all on function public.${name} from public, anon, authenticated;`)
    }
  })

  it('reads a table: a member of its workspace, workspace-wide or theirs or granted; writes it: by an edit grant only, never a guest', () => {
    const visible = fn('data_table_visible_to')
    expect(visible).toContain("t.visibility = 'workspace'")
    expect(visible).toContain('t.owner_member_id = m.id')
    expect(visible).toContain("public.entity_grant_reaches('data_table', t.id, t.workspace_id, p_user_id)")
    const editable = fn('data_table_editable_by')
    // An edit grant writes (512); a view grant never does.
    expect(editable).toContain("public.entity_edit_grant_reaches('data_table', t.id, t.workspace_id, p_user_id)")
    expect(editable).not.toMatch(/entity_grant_reaches|has_entity_grant/)
    expect(fn('_data_apply')).toContain("raise exception 'only the table''s owner can archive it'")
    expect(editable).toContain("m.role <> 'guest'")
    // Each answers only for the caller themself, or for the service role.
    for (const f of [visible, editable]) expect(f).toContain('and (auth.uid() is null or auth.uid() = p_user_id)')
    const mine = fn('my_data_table_ids')
    expect(mine).toContain("public.my_entity_grant_ids('data_table')")
    expect(mine).toContain("public.has_entity_grant('data_table', t.id, t.workspace_id)")
    // The fences' batched form, with grants or (a guest's turn, 519) without.
    expect(fn('visible_data_table_ids')).toContain('case when p_grants is true then public.data_table_visible_to(t.id, p_user_id)')
    expect(fn('visible_data_table_ids')).toContain('else public.data_table_visible_ungranted(t.id, p_user_id) end;')
    expect(fn('data_table_visible_ungranted')).not.toMatch(/entity_grant|has_entity_grant/)
    expect(sql).toContain('drop function if exists public.visible_data_table_ids(uuid[], uuid);')
    expect(fn('create_data_table')).toContain("if v_role = 'guest' then")
  })

  it('makes columns custom field definitions with a table, keyed per table, written only through the functions', () => {
    expect(sql).toContain('add column if not exists table_id uuid null references public.data_table(id) on delete cascade;')
    expect(sql).toContain('add constraint custom_field_definition_table_shape check ((entity_type = \'data_row\') = (table_id is not null));')
    expect(sql).toContain('on public.custom_field_definition (workspace_id, entity_type, table_id, key) nulls not distinct;')
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(sql, verb).toMatch(new RegExp(`create policy custom_field_definition_table_\\w+ on public\\.custom_field_definition\\s+as restrictive for ${verb} to authenticated`))
    }
    expect(sql).toMatch(/as restrictive for insert to authenticated\s+with check \(table_id is null\);/)
  })

  it('opens grants to tables: the kind, the guard, who shares, and seen-only-by-grant', () => {
    expect(sql).toContain("check (entity_type in ('document', 'capture', 'contact', 'company', 'data_table'))")
    expect(fn('entity_access_guard')).toContain("when 'data_table' then exists (select 1 from public.data_table x where x.id = new.entity_id and x.workspace_id = new.workspace_id)")
    expect(fn('entity_access_can_share')).toContain('dt.owner_member_id = public.current_member_id(p_workspace)')
    expect(fn('entity_grant_only')).toContain("public.has_entity_grant('data_table', dt.id, dt.workspace_id)")
  })

  it('publishes the table row (one event per batch), not the rows', () => {
    expect(sql).toContain('alter table public.data_table replica identity full;')
    expect(sql).toContain('alter publication supabase_realtime add table public.data_table;')
    expect(sql).not.toContain('add table public.data_row')
  })

  it('carries tables through a workspace merge: columns never fold, a folded member keeps their tables and grants', () => {
    const deals = fn('_wsmerge_deals')
    expect(deals).toContain('AND f.table_id IS NULL')
    expect(deals).toContain('AND d.table_id IS NULL')
    const members = fn('_wsmerge_members')
    for (const line of [
      'UPDATE public.data_table t SET owner_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.owner_member_id = x.src;',
      'UPDATE public.entity_access t SET grantee_member_id = x.dst FROM pg_temp._wsmerge_members x WHERE t.grantee_member_id = x.src;',
      'UPDATE public.entity_access t SET granted_by = x.dst FROM pg_temp._wsmerge_members x WHERE t.granted_by = x.src;',
    ]) {
      // Before 408's no-refs check, which would otherwise refuse the merge.
      expect(members.indexOf(line), line).toBeGreaterThan(0)
      expect(members.indexOf(line), line).toBeLessThan(members.indexOf("_wsmerge_assert_no_refs('member'"))
    }
  })

  it('is re-runnable and carries no backslash', () => {
    expect(sql).not.toContain('\\')
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';")
    for (const m of sql.matchAll(/add constraint (\w+) check/g)) expect(sql, m[1]).toMatch(new RegExp(`drop constraint if exists ${m[1]};`))
    for (const m of sql.matchAll(/create policy (\w+) on (public\.\w+)/g)) expect(sql, m[1]).toContain(`drop policy if exists ${m[1]} on ${m[2]};`)
    expect(sql).toContain('drop index if exists public.custom_field_definition_key;')
  })
})
