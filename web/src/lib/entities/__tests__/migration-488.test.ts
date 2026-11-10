/**
 * Migration 488, the activity log: what it must keep true, read off its text.
 * Its behaviour was run on DEV inside BEGIN … ROLLBACK (the PR lists the
 * checks and the cost measured); these hold the shape that made it right:
 *   - every kind the registry marks `activity` has its triggers, and no
 *     other kind is logged;
 *   - inserts log once per statement (transition tables), updates only when
 *     a column that matters changed (a column list AND a WHEN clause);
 *   - a logging failure is a warning, never the write's failure;
 *   - nobody but the triggers writes the log; members read it;
 *   - churny writers stay out (mail, claims' edges, syncs and imports,
 *     evaluation captures, suggested tasks).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_ENTITY_TYPES, ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'

const sql = readFileSync(join(process.cwd(), 'supabase/migrations/488_entity_activity.sql'), 'utf8')

const triggersOn = (event: 'insert' | 'update') =>
  [...sql.matchAll(new RegExp(`create trigger entity_activity_${event}\\s+after ${event}[^;]*? on public\\.([a-z_]+)`, 'g'))].map((m) => m[1])

describe('migration 488: the activity log', () => {
  it('logs exactly the kinds the registry marks activity (plus comments and edges, which log onto them)', () => {
    const tableOf = new Map<string, string>(ENTITY_REGISTRY.map((e) => [e.table, e.id]))
    const inserted = triggersOn('insert').map((t) => tableOf.get(t) ?? t)
    expect(new Set(inserted)).toEqual(new Set([...ACTIVITY_ENTITY_TYPES, 'comment', 'entity_link']))
    // Every activity kind logs its updates too (team chat: only a new @-mention).
    const updated = triggersOn('update').map((t) => tableOf.get(t) ?? t)
    expect(new Set(updated)).toEqual(new Set(ACTIVITY_ENTITY_TYPES))
  })

  it('names the same kinds in the edge trigger’s list', () => {
    const list = /kinds text\[\] := array\[([^\]]+)\]/.exec(sql)?.[1] ?? ''
    expect(new Set(list.split(',').map((s) => s.trim().replace(/'/g, '')))).toEqual(new Set(ACTIVITY_ENTITY_TYPES))
  })

  it('logs an insert once per statement, from the transition table', () => {
    const blocks = [...sql.matchAll(/create trigger entity_activity_insert\s+after insert on public\.[a-z_]+\s+referencing new table as new_rows\s+for each statement/g)]
    expect(blocks).toHaveLength(triggersOn('insert').length)
  })

  it('logs an update only when a column that matters changed', () => {
    const updates = [...sql.matchAll(/create trigger entity_activity_update\s+after update of ([a-z_, ]+) on public\.([a-z_]+)\s+for each row\s+when \(([\s\S]*?)\)\s+execute function/g)]
    expect(updates).toHaveLength(triggersOn('update').length)
    for (const [, columns, table, when] of updates) {
      for (const col of columns.split(',').map((c) => c.trim())) {
        expect(when, `${table}.${col}`).toMatch(new RegExp(`old\\.${col}\\b|\\(old\\.${col} = `))
      }
    }
  })

  it('never fails the write it rides: every trigger function catches and warns', () => {
    const fns = [...sql.matchAll(/create or replace function public\.(entity_activity_[a-z_]+_(?:insert|update))\(\)[\s\S]*?\n\$\$;/g)]
    expect(fns.length).toBe(triggersOn('insert').length + triggersOn('update').length)
    for (const [body, name] of fns) {
      expect(body, name).toMatch(/exception when others then\s+raise warning/)
      expect(body, name).toMatch(/security definer\s+set search_path = public, pg_temp/)
      expect(sql, name).toContain(`revoke all on function public.${name}() from public, anon, authenticated;`)
    }
  })

  it('is read by members and written by nobody else', () => {
    expect(sql).toMatch(/alter table public\.entity_activity enable row level security/)
    expect(sql).toMatch(/create policy entity_activity_member_select on public\.entity_activity\s+for select using \(public\.is_workspace_member\(workspace_id\)\)/)
    expect(sql).not.toMatch(/for (insert|update|delete|all)/)
    expect(sql).toMatch(/revoke insert, update, delete on public\.entity_activity from anon, authenticated/)
  })

  it('has the four indexes the feed’s filters read', () => {
    expect(sql).toMatch(/entity_activity \(entity_type, entity_id, created_at desc\)/)
    expect(sql).toMatch(/entity_activity \(workspace_id, created_at desc, id desc\)/)
    expect(sql).toMatch(/entity_activity \(subject_member_id, created_at desc\)\s+where subject_member_id is not null/)
    expect(sql).toMatch(/entity_activity \(actor_member_id, created_at desc\)\s+where actor_member_id is not null/)
  })

  it('leaves the churny writers out', () => {
    expect(sql).not.toMatch(/on public\.(email_thread_index|claim|local_calendar_event)\b/)
    expect(sql).toMatch(/n\.source_type <> 'claim'/)
    expect(sql).toMatch(/n\.is_eval is not true/)
    expect(sql).toMatch(/n\.source is null or n\.source = 'manual'/)
    expect(sql).toMatch(/n\.source_provider is null/)
    expect(sql).toMatch(/n\.confirmation is distinct from 'suggested'/)
  })

  it('keeps titles and text out of the detail', () => {
    for (const m of sql.matchAll(/jsonb_build_object\(([^)]*)\)/g)) {
      expect(m[1]).not.toMatch(/title|name\b|body|content|full_name/)
    }
  })

  it('credits a signed-in request to its member, and only a server request to an agent', () => {
    const actor = /create or replace function public\.entity_activity_actor[\s\S]*?\n\$\$;/.exec(sql)?.[0] ?? ''
    expect(actor.indexOf('auth.uid()')).toBeLessThan(actor.indexOf("request.headers"))
    expect(actor).toMatch(/if actor_user_id is not null then\s+actor_kind := 'member';\s+return;/)
    expect(actor).toMatch(/x-activity-actor' = 'agent'/)
  })

  it('is idempotent and has no backslash', () => {
    expect(sql).toMatch(/create table if not exists public\.entity_activity/)
    for (const m of sql.matchAll(/create trigger (\w+)\s+after \w+(?: of [a-z_, ]+)? on (public\.\w+)/g)) {
      expect(sql).toContain(`drop trigger if exists ${m[1]} on ${m[2]};`)
    }
    expect(sql).not.toContain('\\')
  })
})
