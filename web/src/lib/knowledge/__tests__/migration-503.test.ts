/**
 * Migration 503: mail has one name, `email_thread`. It can't be run here (it
 * was run on DEV, in a rolled-back fixture first, then twice for real), so the
 * file is pinned as text:
 *   - every stored `email` kind is rewritten, duplicates first, and the
 *     claim_source tombstone is left alone;
 *   - an old writer's `email` is renamed on the way into the graph tables;
 *   - entity_visible_to and the entity_link SELECT policy are 500's, changed
 *     ONLY by the rename (the test re-derives them from 500 and compares), and
 *     list exactly LINK_FENCED_KINDS;
 *   - claim_neighborhood is 369's, changed only in its two mail checks.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LINK_FENCED_KINDS } from '../entity-fences'
import { LINKABLE_ENTITY_TYPES, RETIRED_ENTITY_TYPE_NAMES, canonicalEntityType } from '../entity-registry'

const dir = path.join(process.cwd(), 'supabase/migrations')
const sql = readFileSync(path.join(dir, '503_one_name_for_mail.sql'), 'utf8')
const m500 = readFileSync(path.join(dir, '500_entity_link_read_follows_endpoints.sql'), 'utf8')
const m369 = readFileSync(path.join(dir, '369_document_visibility.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** From `start` up to and including the first `end` after it. */
function slice(text: string, start: string, end: string): string {
  const i = text.indexOf(start)
  expect(i, start).toBeGreaterThan(-1)
  const j = text.indexOf(end, i + start.length)
  expect(j, end).toBeGreaterThan(-1)
  return text.slice(i, j + end.length)
}

const evt = (text: string) => slice(text, 'create or replace function public.entity_visible_to', '\n$$;')
const policy = (text: string) => slice(text, 'create policy entity_link_select', ');')
const neighborhood = (text: string) =>
  slice(text, 'CREATE OR REPLACE FUNCTION public.claim_neighborhood(', '$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;')

describe('migration 503: one name for mail', () => {
  it('names email_thread in the registry and keeps email only as a retired name', () => {
    expect(LINKABLE_ENTITY_TYPES).toContain('email_thread')
    expect(LINKABLE_ENTITY_TYPES).not.toContain('email')
    expect(RETIRED_ENTITY_TYPE_NAMES).toEqual({ email: 'email_thread' })
    expect(canonicalEntityType('email')).toBe('email_thread')
    expect(canonicalEntityType('email_thread')).toBe('email_thread')
    expect(canonicalEntityType('document')).toBe('document')
    // A name on Object.prototype is not a retired kind.
    expect(canonicalEntityType('toString')).toBe('toString')
  })

  it('holds no backslash and reloads the API schema', () => {
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
    expect(code.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('the SQL rename matches the app', () => {
    for (const [old, now] of Object.entries(RETIRED_ENTITY_TYPE_NAMES)) {
      expect(code).toContain(`select case p_type when '${old}' then '${now}' else p_type end;`)
    }
    expect(code).toMatch(/create or replace function public\.entity_kind_current\(p_type text\)\s+returns text\s+language sql\s+immutable/)
  })

  it('rewrites every graph and kind column, duplicates first', () => {
    // The graph: one update renames both ends, after the self-link and twin deletes.
    const del = code.indexOf('delete from public.entity_link l\n using ranked r')
    const upd = code.indexOf('update public.entity_link\n   set source_type = public.entity_kind_current(source_type),\n       target_type = public.entity_kind_current(target_type)')
    expect(del).toBeGreaterThan(-1)
    expect(upd).toBeGreaterThan(del)
    expect(code).toContain("where l.id = r.id and r.old_name and r.rn > 1;")
    // A twin already under the new name is the one kept.
    expect(code).toContain("order by (l.source_type = 'email' or l.target_type = 'email'), l.created_at, l.id")
    for (const table of ['knowledge_package_item', 'anchor_embedding', 'work_touch', 'entity_activity', 'attention_item']) {
      expect(code, table).toContain(`update public.${table} set entity_type = 'email_thread' where entity_type = 'email';`)
    }
    // Keyed tables drop the twin before renaming.
    for (const table of ['knowledge_package_item', 'anchor_embedding', 'work_touch']) {
      const d = code.indexOf(`delete from public.${table}`)
      const u = code.indexOf(`update public.${table} set entity_type`)
      expect(d, table).toBeGreaterThan(-1)
      expect(u, table).toBeGreaterThan(d)
    }
  })

  it('leaves claim_source alone: its `email` is a tombstone the mail fences still hide', () => {
    expect(code).not.toMatch(/claim_source/)
  })

  it('renames an old writer\'s email on the way into the graph tables', () => {
    expect(code).toContain('before insert or update of source_type, target_type on public.entity_link')
    expect(code).toContain("when (new.source_type = 'email' or new.target_type = 'email')")
    expect(code).toContain('before insert or update of entity_type on public.knowledge_package_item')
    expect(code).toContain('drop trigger if exists entity_link_current_kinds on public.entity_link;')
    expect(code).toContain('drop trigger if exists knowledge_package_item_current_kind on public.knowledge_package_item;')
  })

  it("entity_visible_to is 500's, changed only by the rename", () => {
    const derived = evt(m500)
      .replace('  v_confirmation text;\nbegin', '  v_confirmation text;\n  v_type text := public.entity_kind_current(p_type);\nbegin')
      .replace(/\bp_type\b/g, 'v_type')
      .replace('public.entity_kind_current(v_type)', 'public.entity_kind_current(p_type)')
      .replace('(v_type text,', '(p_type text,')
      .replaceAll("'email'", "'email_thread'")
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
    expect(strip(evt(sql))).toBe(strip(derived))
    const fn = evt(code)
    for (const kind of LINK_FENCED_KINDS) expect(fn, kind).toMatch(new RegExp(`'${kind}'`))
    expect(fn).not.toMatch(/'email'/)
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain('security definer')
    expect(fn).toContain('set search_path = public, pg_temp')
    expect(code).toContain('revoke all on function public.entity_visible_to(text, uuid, uuid, uuid) from public, anon;')
  })

  it("the SELECT policy is 500's under the new name, and lists exactly LINK_FENCED_KINDS", () => {
    expect(policy(sql)).toBe(policy(m500).replaceAll(',email,', ',email_thread,'))
    const lists = [...policy(code).matchAll(/<> all \('\{([a-z_,]+)\}'::text\[\]\)/g)].map((m) => m[1].split(','))
    expect(lists).toHaveLength(2)
    const expected = LINK_FENCED_KINDS.filter((k) => k !== 'claim')
    for (const list of lists) expect([...list].sort()).toEqual([...expected].sort())
    expect(code).toContain('drop policy if exists entity_link_select on public.entity_link;')
  })

  it("claim_neighborhood is 369's, hiding mail under either name", () => {
    const derived = neighborhood(m369)
      .replace("IF p_entity_type = 'email'\n", "IF p_entity_type IN ('email', 'email_thread')\n")
      .replace("AND nxt.node_type <> 'email'\n", "AND nxt.node_type NOT IN ('email', 'email_thread')\n")
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
    expect(strip(neighborhood(sql))).toBe(strip(derived))
    expect(code).toContain('GRANT EXECUTE ON FUNCTION public.claim_neighborhood(TEXT, TEXT, TEXT, INTEGER, INTEGER, UUID) TO authenticated, service_role;')
  })
})
