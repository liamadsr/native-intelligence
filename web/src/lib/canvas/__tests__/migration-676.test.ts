/**
 * Migration 676: canvases (whiteboards) as a record, their items, and their
 * graph edges. It can't be run here, so the file is pinned as text. The key
 * properties:
 *   - it redefines NO pre-existing function and NO pre-existing policy (the
 *     shared entity_visible_to / entity_refs_hidden and the shared
 *     entity_link_select / _insert / _update / _delete stay untouched);
 *   - the canvas_item kind CHECK lists exactly CANVAS_ITEM_KINDS;
 *   - the graph edges are fenced by restrictive entity_link policies of the
 *     canvas's own (the way 624 fenced the Studio's and 673 teams');
 *   - it is one transaction in the house style, with no backslash.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANVAS_ITEM_KINDS } from '../types'
import { ENTITY_REGISTRY_BY_ID, LINKABLE_ENTITY_TYPES } from '@/lib/knowledge/entity-registry'
import { LINK_FENCED_KINDS, PRIVATE_GRAPH_KINDS } from '@/lib/knowledge/entity-fences'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/676_canvas.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const FN = 'public.canvas_entity_visible_to'

function policy(name: string): string {
  const i = code.indexOf(`create policy ${name} on public.entity_link`)
  expect(i, name).toBeGreaterThan(-1)
  return code.slice(i, code.indexOf(';', i) + 1)
}

/** The guard on one edge: both ends, a canvas end only through the canvas's rule, any other end passing. */
const GUARD =
  "(source_type <> 'canvas'\n     or public.canvas_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))\n" +
  "    and (target_type <> 'canvas'\n     or public.canvas_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))"

describe('migration 676: canvas record and graph, additive only', () => {
  it('is one transaction in the house style: lock timeout, schema reload, no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(sql).toMatch(/\nbegin;\n\nSET LOCAL lock_timeout = '5s';\n/)
    expect(sql.trimEnd().endsWith("commit;\n\nnotify pgrst, 'reload schema';")).toBe(true)
    expect(code).not.toMatch(/drop (table|function) /i)
  })

  it('creates the two tables', () => {
    expect(code).toMatch(/create table if not exists public\.canvas \(/)
    expect(code).toMatch(/create table if not exists public\.canvas_item \(/)
    // project_id points at the real project table (public.projects).
    expect(code).toContain('project_id uuid null references public.projects(id) on delete set null')
    expect(code).toContain('owner_member_id uuid null references public.member(id) on delete set null')
    expect(code).toContain('primary key (canvas_id, id)')
    expect(code).toContain('create index if not exists canvas_item_canvas_idx on public.canvas_item (canvas_id);')
  })

  it('the canvas_item kind CHECK lists exactly CANVAS_ITEM_KINDS, in order', () => {
    const want = `check (kind in (${CANVAS_ITEM_KINDS.map((k) => `'${k}'`).join(', ')}))`
    expect(code).toContain(want)
  })

  it('re-creates nothing shared: not entity_visible_to, not entity_refs_hidden, not a shared entity_link policy', () => {
    expect(code).not.toMatch(/function public\.entity_visible_to\(/i)
    expect(code).not.toMatch(/function public\.entity_refs_hidden\(/i)
    expect(code).not.toMatch(/function public\.data_table_visible_to\(/i)
    expect(code).not.toMatch(/function public\.entity_access_guard\(/i)
    for (const name of ['entity_link_select', 'entity_link_insert', 'entity_link_update', 'entity_link_delete']) {
      expect(code, name).not.toMatch(new RegExp(`policy ${name} on`, 'i'))
    }
    // It widens no existing CHECK (no entity_access / share / commentable touch).
    expect(code).not.toMatch(/entity_access_entity_type/i)
    expect(code).not.toMatch(/share_shareable_type_check/i)
    expect(code).not.toMatch(/commentable/i)
    // Every entity_link policy it creates is its own and restrictive.
    const created = [...code.matchAll(/create policy (\w+) on public\.entity_link\s+as (\w+)/g)].map((m) => [m[1], m[2]])
    expect(created).toEqual([
      ['entity_link_canvas_select', 'restrictive'],
      ['entity_link_canvas_insert', 'restrictive'],
      ['entity_link_canvas_update', 'restrictive'],
      ['entity_link_canvas_delete', 'restrictive'],
    ])
  })

  it('the canvas access functions are 520-shaped (security definer, no grant arm)', () => {
    for (const fn of ['canvas_visible_to', 'canvas_editable_by', 'my_canvas_ids']) {
      expect(code, fn).toContain(`create or replace function public.${fn}(`)
    }
    expect(code).toContain("m.role <> 'guest'")
    // No grant arm: no entity_grant / has_entity_grant calls anywhere.
    expect(code).not.toMatch(/entity_grant|has_entity_grant/i)
  })

  it("the canvas read rule for the graph: in that workspace, deferring to canvas_visible_to", () => {
    const fn = code.slice(code.indexOf(`create or replace function ${FN}(`), code.indexOf('$$;', code.indexOf(`create or replace function ${FN}(`)) + 3)
    expect(fn).toContain('returns boolean')
    expect(fn).toMatch(/stable\s+security definer\s+set search_path = public, pg_temp/)
    expect(fn).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain("if p_type <> 'canvas' then return false; end if;")
    expect(fn).toContain('if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;')
    expect(fn).toContain('return public.canvas_visible_to(p_id, p_user);')
    expect(code).toContain(`revoke all on function ${FN}(text, uuid, uuid, uuid) from public, anon;`)
    expect(code).toContain(`grant execute on function ${FN}(text, uuid, uuid, uuid) to authenticated, service_role;`)
  })

  it('guards both ends of every edge on every command, and an update both as it is and as it becomes', () => {
    expect(policy('entity_link_canvas_select')).toContain(`for select\n  using (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_canvas_insert')).toContain(`for insert\n  with check (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_canvas_update')).toContain(`for update\n  using (\n    ${GUARD}\n  )\n  with check (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_canvas_delete')).toContain(`for delete\n  using (\n    ${GUARD}\n  );`)
  })

  it('publishes both tables to realtime with replica identity full, guarded', () => {
    expect(code).toContain('alter table public.canvas replica identity full;')
    expect(code).toContain('alter table public.canvas_item replica identity full;')
    expect(code).toContain('alter publication supabase_realtime add table public.canvas;')
    expect(code).toContain('alter publication supabase_realtime add table public.canvas_item;')
    expect(code.match(/exception when duplicate_object then null;/g)).toHaveLength(2)
  })

  it("the app's mirror: canvas registered, linkable, fenced in the app (never by the shared entity_visible_to)", () => {
    expect(LINKABLE_ENTITY_TYPES as readonly string[]).toContain('canvas')
    expect(PRIVATE_GRAPH_KINDS as readonly string[]).toContain('canvas')
    expect(LINK_FENCED_KINDS as readonly string[]).toContain('canvas')
    const d = ENTITY_REGISTRY_BY_ID.canvas
    expect(d.table).toBe('canvas')
    expect(d.linkable).toBe(true)
    // Out of scope here, on purpose: the activity log, custom fields, citations.
    expect([d.activity, d.customFields, d.citable, d.sourceable]).toEqual([false, false, false, false])
  })
})
