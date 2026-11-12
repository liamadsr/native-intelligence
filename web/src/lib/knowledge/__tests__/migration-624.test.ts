/**
 * Migration 624: Studio videos and Studio projects join the knowledge graph.
 * It can't be run here, so the file is pinned as text. It adds only objects of
 * the Studio's own (another branch in flight adds its kinds to the shared
 * entity_visible_to and entity_link policies): one read-rule function, and
 * restrictive entity_link policies that AND with whatever permissive ones
 * exist. It never re-creates a shared function or policy. The app's mirror
 * (entity-fences.ts) fences both kinds itself, never through entity_visible_to.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_FENCED_KINDS, PRIVATE_GRAPH_KINDS } from '../entity-fences'
import { ENTITY_REGISTRY_BY_ID, LINKABLE_ENTITY_TYPES } from '../entity-registry'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/624_studio_entities.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

const STUDIO = ['studio_video', 'studio_project'] as const
const FN = 'public.studio_entity_visible_to'

function policy(name: string): string {
  const i = code.indexOf(`create policy ${name} on public.entity_link`)
  expect(i, name).toBeGreaterThan(-1)
  return code.slice(i, code.indexOf(';', i) + 1)
}

/** The guard on one edge: both ends, a Studio end only through the Studio's rule, any other end passing. */
const GUARD =
  "(source_type not in ('studio_video', 'studio_project')\n     or public.studio_entity_visible_to(source_type, source_id, workspace_id, (select auth.uid())))\n" +
  "    and (target_type not in ('studio_video', 'studio_project')\n     or public.studio_entity_visible_to(target_type, target_id, workspace_id, (select auth.uid())))"

describe('migration 624: the Studio in the graph, additive only', () => {
  it('is one transaction in the house style: lock timeout, schema reload, no backslash', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(sql).toMatch(/\nbegin;\n\nSET LOCAL lock_timeout = '5s';\n/)
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;")).toBe(true)
    expect(code).not.toMatch(/drop (table|function)/i)
  })

  it('re-creates nothing shared: not entity_visible_to, not entity_refs_hidden, not a shared entity_link policy', () => {
    expect(code).not.toMatch(/function public\.entity_visible_to\(/i)
    expect(code).not.toMatch(/function public\.entity_refs_hidden\(/i)
    for (const name of ['entity_link_select', 'entity_link_insert', 'entity_link_update', 'entity_link_delete']) {
      expect(code, name).not.toMatch(new RegExp(`policy ${name} on`, 'i'))
    }
    // Every policy it creates is its own and restrictive.
    const created = [...code.matchAll(/create policy (\w+) on public\.(\w+)\s+as (\w+)/g)].map((m) => [m[1], m[2], m[3]])
    expect(created).toEqual([
      ['entity_link_studio_select', 'entity_link', 'restrictive'],
      ['entity_link_studio_insert', 'entity_link', 'restrictive'],
      ['entity_link_studio_update', 'entity_link', 'restrictive'],
      ['entity_link_studio_delete', 'entity_link', 'restrictive'],
    ])
    expect(code.match(/create policy/g)).toHaveLength(4)
    for (const [name] of created) expect(code).toContain(`drop policy if exists ${name} on public.entity_link;\ncreate policy ${name} on public.entity_link`)
  })

  it("the Studio's read rule: not in the trash, in that workspace, a member who is not a guest, nobody without a user", () => {
    const fn = code.slice(code.indexOf(`create or replace function ${FN}(`), code.indexOf('$$;') + 3)
    expect(fn).toContain('returns boolean')
    expect(fn).toMatch(/stable\s+security definer\s+set search_path = public, pg_temp/)
    expect(fn).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain('select sv.workspace_id into v_ws from public.studio_video sv where sv.id = p_id and sv.archived_at is null;')
    expect(fn).toContain('select sp.workspace_id into v_ws from public.studio_project sp where sp.id = p_id and sp.archived_at is null;')
    expect(fn).toContain('if v_ws is null or (p_workspace is not null and v_ws <> p_workspace) then return false; end if;')
    expect(fn).toContain("m.workspace_id = v_ws and m.user_id = p_user and m.role is distinct from 'guest'")
    // Any other kind is never the Studio's to answer.
    expect(fn).toMatch(/else\s+return false;\s+end if;/)
    expect(code).toContain(`revoke all on function ${FN}(text, uuid, uuid, uuid) from public, anon;`)
    expect(code).toContain(`grant execute on function ${FN}(text, uuid, uuid, uuid) to authenticated, service_role;`)
  })

  it('guards both ends of every edge on every command, and an update both as it is and as it becomes', () => {
    expect(policy('entity_link_studio_select')).toContain(`for select\n  using (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_studio_insert')).toContain(`for insert\n  with check (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_studio_update')).toContain(`for update\n  using (\n    ${GUARD}\n  )\n  with check (\n    ${GUARD}\n  );`)
    expect(policy('entity_link_studio_delete')).toContain(`for delete\n  using (\n    ${GUARD}\n  );`)
  })

  it("the app's mirror: both kinds registered, linkable, and fenced in the app (never by entity_visible_to)", () => {
    for (const kind of STUDIO) {
      expect(LINKABLE_ENTITY_TYPES as readonly string[], kind).toContain(kind)
      // A private graph kind: hiddenGraphRefs and the mention fence ask entity-fences.ts's studioFence, not the RPC.
      expect(PRIVATE_GRAPH_KINDS as readonly string[], kind).toContain(kind)
      expect(LINK_FENCED_KINDS as readonly string[], kind).toContain(kind)
      const d = ENTITY_REGISTRY_BY_ID[kind]
      expect(d.table).toBe(kind)
      // Out of scope, on purpose: realtime, activity, custom fields, citations.
      expect([d.realtime, d.activity, d.customFields, d.citable, d.sourceable]).toEqual([false, false, false, false, false])
    }
    // The kinds the SQL guards are exactly the Studio's private kinds.
    expect(PRIVATE_GRAPH_KINDS.filter((k) => k.startsWith('studio_'))).toEqual([...STUDIO])
  })
})
