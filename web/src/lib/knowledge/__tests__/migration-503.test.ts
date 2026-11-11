/**
 * Migration 503: mail has one name, `email_thread`. It can't be run here (it
 * was run on DEV, in a rolled-back fixture first, then for real), so the file
 * is pinned as text:
 *   - every stored `email` kind is rewritten, duplicates first, and the
 *     claim_source tombstone is left alone;
 *   - an old writer's `email` is renamed on the way into the graph tables;
 *   - every object 503 redefines (entity_visible_to, the entity_link policies
 *     that name the mail kind, claim_neighborhood) is the LATEST definition
 *     before 503, changed ONLY by the rename. The test finds that definition
 *     itself and re-derives 503's text from it, so when a later fix (501, 502)
 *     redefines one of them, this fails until 503 is regenerated from it:
 *     503 must never carry an older body forward over a newer one.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { LINK_FENCED_KINDS } from '../entity-fences'
import { LINKABLE_ENTITY_TYPES, RETIRED_ENTITY_TYPE_NAMES, canonicalEntityType } from '../entity-registry'

const dir = path.join(process.cwd(), 'supabase/migrations')
const sql = readFileSync(path.join(dir, '503_one_name_for_mail.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** Every migration numbered below 503, oldest first. */
const before503 = readdirSync(dir)
  .filter((f) => f.endsWith('.sql') && /^\d+_/.test(f) && Number.parseInt(f, 10) < 503)
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
  .map((file) => ({ file, sql: readFileSync(path.join(dir, file), 'utf8') }))

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]]/g, (c) => `${String.fromCharCode(92)}${c}`)

/** `create or replace function public.<fn>(` (any case) through the statement's semicolon. */
function fnBlock(text: string, fn: string): string | null {
  const m = new RegExp(`create or replace function public\\.${escape(fn)}\\(`, 'i').exec(text)
  if (!m) return null
  const open = text.indexOf('$$', m.index)
  const close = text.indexOf('$$', open + 2)
  return text.slice(m.index, text.indexOf(';', close + 2) + 1)
}

function policyBlock(text: string, name: string): string | null {
  const m = new RegExp(`create policy ${escape(name)} on public\\.entity_link`, 'i').exec(text)
  if (!m) return null
  return text.slice(m.index, text.indexOf(';', m.index) + 1)
}

function latest(find: (text: string) => string | null): { file: string; block: string } | null {
  for (let i = before503.length - 1; i >= 0; i--) {
    const block = find(before503[i].sql)
    if (block) return { file: before503[i].file, block }
  }
  return null
}

/** `email` in a '{a,b,...}' literal list becomes `email_thread`. */
const renameLists = (text: string) =>
  text.replace(/\{([a-z_,]+)\}/g, (_, items: string) => `{${items.split(',').map((x) => (x === 'email' ? 'email_thread' : x)).join(',')}}`)

/** The generator's rule for entity_visible_to: read the kind through entity_kind_current, mail is email_thread. */
function renameVisibleTo(block: string): string {
  const nl = block.indexOf('\n')
  const sig = block.slice(0, nl)
  let body = block.slice(nl)
  const m = /\nbegin\n/i.exec(body)
  expect(m, 'entity_visible_to has a begin line').not.toBeNull()
  body = `${body.slice(0, m!.index)}\n  v_type text := public.entity_kind_current(p_type);${body.slice(m!.index)}`
  body = body
    .replace(/\bp_type\b/g, 'v_type')
    .replace('v_type text := public.entity_kind_current(v_type);', 'v_type text := public.entity_kind_current(p_type);')
    .replaceAll("'email'", "'email_thread'")
  return sig + renameLists(body)
}

/** The generator's rule for claim_neighborhood: mail under either name. */
const renameNeighborhood = (block: string) =>
  block
    .replace(/([\w.]+) = 'email'(?!_)/g, "$1 IN ('email', 'email_thread')")
    .replace(/([\w.]+) <> 'email'(?!_)/g, "$1 NOT IN ('email', 'email_thread')")

const renamePolicy = (block: string) => renameLists(block).replaceAll("'email'", "'email_thread'")

const ENTITY_LINK_POLICIES = ['entity_link_select', 'entity_link_insert', 'entity_link_update', 'entity_link_delete']

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
    expect(code).toContain('where l.id = r.id and r.old_name and r.rn > 1;')
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

  it("renames an old writer's email on the way into the graph tables", () => {
    expect(code).toContain('before insert or update of source_type, target_type on public.entity_link')
    expect(code).toContain("when (new.source_type = 'email' or new.target_type = 'email')")
    expect(code).toContain('before insert or update of entity_type on public.knowledge_package_item')
    expect(code).toContain('drop trigger if exists entity_link_current_kinds on public.entity_link;')
    expect(code).toContain('drop trigger if exists knowledge_package_item_current_kind on public.knowledge_package_item;')
  })

  it('restates no grant on what it redefines (create or replace keeps the source\'s)', () => {
    for (const fn of ['entity_visible_to', 'claim_neighborhood']) {
      expect(code, fn).not.toMatch(new RegExp(`(grant|revoke)[^;]*function public\\.${fn}\\(`, 'i'))
    }
  })

  it('entity_visible_to is the latest definition before 503, changed only by the rename', () => {
    const src = latest((t) => fnBlock(t, 'entity_visible_to'))
    expect(src).not.toBeNull()
    expect(sql).toContain(`-- entity_visible_to, from ${src!.file}:`)
    expect(fnBlock(sql, 'entity_visible_to')).toBe(renameVisibleTo(src!.block))
    const fn = fnBlock(code, 'entity_visible_to')!
    // Tables and their rows joined later (522, ./migration-522.test.ts).
    for (const kind of LINK_FENCED_KINDS.filter((k) => k !== 'data_table' && k !== 'data_row')) expect(fn, kind).toMatch(new RegExp(`'${kind}'`))
    expect(fn).not.toMatch(/'email'/)
    expect(fn).toContain('if auth.uid() is not null and p_user is distinct from auth.uid() then return false; end if;')
    expect(fn).toContain('security definer')
    expect(fn).toContain('set search_path = public, pg_temp')
  })

  it('carries every entity_link policy that names mail, as its latest definition renamed, and no other', () => {
    let carried = 0
    for (const name of ENTITY_LINK_POLICIES) {
      const src = latest((t) => policyBlock(t, name))
      const names = !!src && /[{,]email[,}]|'email'/.test(src.block)
      const here = policyBlock(sql, name)
      if (!names) {
        expect(here, name).toBeNull()
        continue
      }
      carried++
      expect(sql, name).toContain(`-- From ${src!.file}.\ndrop policy if exists ${name} on public.entity_link;\n`)
      expect(here, name).toBe(renamePolicy(src!.block))
      expect(here, name).not.toMatch(/[{,]email[,}]|'email'/)
    }
    expect(carried).toBeGreaterThan(0)
    // 501: writing an edge asks exactly the read rule, still true after the rename.
    const select = policyBlock(code, 'entity_link_select')
    const insert = policyBlock(code, 'entity_link_insert')
    if (select && insert) {
      expect(insert.slice(insert.indexOf('with check ('))).toBe(select.slice(select.indexOf('using (')).replace('using (', 'with check ('))
    }
    // Every fenced list in the policies 503 states names mail by its current
    // name and only fenced kinds (a kind fenced through its own hidden set,
    // claims and since 501 companies, is not in the lists; migration-500/501
    // tests pin which).
    expect(policyBlock(code, 'entity_link_select')).not.toBeNull()
    for (const name of ENTITY_LINK_POLICIES) {
      const block = policyBlock(code, name)
      if (!block) continue
      const lists = [...block.matchAll(/<> all \('\{([a-z_,]+)\}'::text\[\]\)/g)].map((m) => m[1].split(','))
      expect(lists.length, name).toBeGreaterThanOrEqual(2)
      for (const list of lists) {
        expect(list, name).toContain('email_thread')
        expect(list, name).not.toContain('email')
        for (const kind of list) expect(LINK_FENCED_KINDS as readonly string[], `${name}: ${kind}`).toContain(kind)
      }
    }
  })

  it('claim_neighborhood is the latest definition before 503, hiding mail under either name', () => {
    const src = latest((t) => fnBlock(t, 'claim_neighborhood'))
    expect(src).not.toBeNull()
    expect(sql).toContain(`-- claim_neighborhood, from ${src!.file}:`)
    const here = fnBlock(sql, 'claim_neighborhood')!
    expect(here).toBe(renameNeighborhood(src!.block))
    // Nothing in it names mail by the old name alone.
    expect(here.replaceAll("'email', 'email_thread'", '')).not.toMatch(/'email'/)
    expect(here).toMatch(/IN \('email', 'email_thread'\)/)
    expect(here).toMatch(/NOT IN \('email', 'email_thread'\)/)
  })
})
