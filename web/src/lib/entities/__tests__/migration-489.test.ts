/**
 * Migration 489, the activity log hardened: what it must keep true, read off
 * its text. Its behaviour was run on DEV inside a rolled-back transaction
 * (a member reading another member's private capture, document and DM rows
 * directly; an edge naming another member as its author; an anonymous
 * request naming an agent; a 200-row bulk update; a merge; a move; a
 * workspace delete mid-cascade); these hold the shape that made it right:
 *   - it replaces every trigger body 488 wrote, none opens a subtransaction,
 *     and each still runs as its owner with a pinned search_path;
 *   - every write first asks entity_activity_writable (not in a merge, the
 *     workspace still there);
 *   - a change of workspace re-stamps the record's history and logs nothing;
 *   - only a service-role request can name an agent;
 *   - a signed-in caller is the author of an edge or a comment;
 *   - the read policy probes exactly the kinds with a per-record rule, for
 *     the row's record and the one its detail names.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_ENTITY_TYPES, ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql = read('489_entity_activity_hardening.sql')
const sql488 = read('488_entity_activity.sql')

const triggerFns = (text: string) =>
  [...text.matchAll(/create or replace function public\.(entity_activity_[a-z_]+_(?:insert|update))\(\)[\s\S]*?\n\$\$;/g)].map((m) => ({ name: m[1], body: m[0] }))

/** Kinds every member of the workspace may read (their table's RLS is is_workspace_member alone). */
const WORKSPACE_WIDE = ['action', 'project', 'initiative', 'deal', 'flow']
/** Kinds with a per-record rule: probed through their own table. */
const PER_RECORD = ['document', 'capture', 'contact', 'company', 'team_chat_message']

describe('migration 489: the activity log, hardened', () => {
  it('replaces every trigger body 488 wrote, none with a subtransaction', () => {
    const before = triggerFns(sql488).map((f) => f.name)
    const after = triggerFns(sql)
    expect(new Set(after.map((f) => f.name))).toEqual(new Set(before))
    for (const { name, body } of after) {
      expect(body, name).not.toMatch(/\bexception\b/i)
      expect(body, name).toMatch(/security definer\s+set search_path = public, pg_temp/)
      expect(sql, name).toContain(`revoke all on function public.${name}() from public, anon, authenticated;`)
    }
    expect(sql).not.toMatch(/\bexception when\b/i)
  })

  it('writes only when not in a merge and the workspace is still there', () => {
    const writable = /create or replace function public\.entity_activity_writable[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? ''
    expect(writable).toMatch(/current_setting\('dial8\.workspace_merge', true\), ''\) = ''/)
    expect(writable).toMatch(/exists \(select 1 from public\.workspace w where w\.id = p_workspace\)/)
    for (const { name, body } of triggerFns(sql)) {
      const inserts = body.match(/insert into public\.entity_activity/g) ?? []
      expect(inserts.length, name).toBe(1)
      expect(body, name).toMatch(/public\.entity_activity_writable\((n|new|w)\.workspace_id\)/)
    }
  })

  it('carries a moved record’s history instead of logging the move’s remaps', () => {
    const updates = [...sql.matchAll(/create trigger entity_activity_update\s+after update of ([a-z_, ]+) on public\.([a-z_]+)\s+for each row\s+when \(([\s\S]*?)\)\s+execute function public\.(\w+)\(\)/g)]
    const tableOf = new Map<string, string>(ENTITY_REGISTRY.map((e) => [e.table, e.id]))
    // Every logged kind but team chat (a message never changes workspace).
    expect(new Set(updates.map((m) => tableOf.get(m[2])))).toEqual(new Set(ACTIVITY_ENTITY_TYPES.filter((k) => k !== 'team_chat_message')))
    const bodies = new Map(triggerFns(sql).map((f) => [f.name, f.body]))
    for (const [, columns, table, when, fn] of updates) {
      const cols = columns.split(',').map((c) => c.trim())
      expect(cols, table).toContain('workspace_id')
      for (const col of cols) expect(when, `${table}.${col}`).toMatch(new RegExp(`old\\.${col}\\b|\\(old\\.${col} = `))
      const body = bodies.get(fn) ?? ''
      const type = tableOf.get(table)
      expect(body, fn).toMatch(
        new RegExp(`if old\\.workspace_id is distinct from new\\.workspace_id then\\s+perform public\\.entity_activity_follow\\('${type}', new\\.id, old\\.workspace_id, new\\.workspace_id\\);\\s+return null;`),
      )
    }
  })

  it('lets only a service-role request name an agent', () => {
    const actor = /create or replace function public\.entity_activity_actor[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? ''
    const roleCheck = actor.indexOf("if jwt_role is distinct from 'service_role' then")
    expect(roleCheck).toBeGreaterThan(actor.indexOf('auth.uid()'))
    expect(roleCheck).toBeLessThan(actor.indexOf("current_setting('request.headers'"))
    expect(actor).toMatch(/pg_input_is_valid\(raw, 'jsonb'\)/)
    expect(actor).toMatch(/pg_input_is_valid\(u, 'uuid'\)/)
  })

  it('credits a signed-in caller, not the row’s created_by or author_id', () => {
    const edges = triggerFns(sql).find((f) => f.name === 'entity_activity_entity_link_insert')?.body ?? ''
    expect(edges).toMatch(/case when a\.actor_kind = 'system' then n\.created_by else m\.id end/)
    const comments = triggerFns(sql).find((f) => f.name === 'entity_activity_comment_insert')?.body ?? ''
    expect(comments).toMatch(/case when a\.actor_kind = 'system' then n\.author_id else m\.id end/)
  })

  it('reads a row only when its record, and the record its detail names, can be read', () => {
    const policy = /create policy entity_activity_member_select on public\.entity_activity\s+for select using \(([\s\S]*?)\n  \);/.exec(sql)?.[1] ?? ''
    expect(policy).toMatch(/^\s*public\.is_workspace_member\(workspace_id\)/)
    // The kinds split exactly into the probed and the workspace-wide.
    expect(new Set([...PER_RECORD, ...WORKSPACE_WIDE])).toEqual(new Set(ACTIVITY_ENTITY_TYPES))
    const tableOf = new Map<string, string>(ENTITY_REGISTRY.map((e) => [e.id, e.table]))
    for (const kind of PER_RECORD) {
      expect(policy, kind).toContain(`when '${kind}' then exists (select 1 from public.${tableOf.get(kind)} x where x.id = entity_activity.entity_id offset 0)`)
      expect(policy, `${kind} as the other`).toMatch(
        new RegExp(`= '${kind}'\\s+then exists \\(select 1 from public\\.${tableOf.get(kind)} x where x\\.id = coalesce\\(detail ->> 'source_id', detail ->> 'other_id'\\)::uuid offset 0\\)`),
      )
    }
    for (const kind of WORKSPACE_WIDE) expect(policy, kind).toContain(`when '${kind}' then true`)
    expect(policy).toContain(`in ('${WORKSPACE_WIDE.join("', '")}') then true`)
    // An unknown kind, or a malformed id, is never readable.
    expect(policy.match(/else false/g)).toHaveLength(2)
    expect(policy).toMatch(/when not pg_catalog\.pg_input_is_valid\([^)]*\), 'uuid'\) then false/)
    // Every probe stays a per-row key lookup (no hashed subplan over the whole table).
    const probes = policy.split('\n').filter((l) => l.includes('exists (select 1 from'))
    expect(probes).toHaveLength(PER_RECORD.length * 2)
    for (const line of probes) expect(line).toMatch(/ offset 0\)$/)
  })

  it('is idempotent and has no backslash', () => {
    for (const m of sql.matchAll(/create trigger (\w+)\s+after \w+(?: of [a-z_, ]+)? on (public\.\w+)/g)) {
      expect(sql).toContain(`drop trigger if exists ${m[1]} on ${m[2]};`)
    }
    expect(sql).toContain('drop policy if exists entity_activity_member_select on public.entity_activity;')
    expect(sql).not.toContain('\\')
  })
})
