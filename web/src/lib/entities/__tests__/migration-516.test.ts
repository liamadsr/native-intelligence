/**
 * Migrations 516 and 517, the activity log's history backfilled: what they
 * must keep true, read off their text. Their behaviour was run on DEV inside
 * rolled-back transactions (made-up records "older than the log", a live row
 * already there, a suggested task, a synced contact, a moved task, a member
 * mention, a second run, a queued merge, the pg_cron tick to the end, and a
 * member reading another member's private document's rows); these hold the
 * shape that made it right:
 *   - every logged kind has a source and a home (its workspace now, locked);
 *   - every row is marked, has an id derived from what it records, and is
 *     written only once (the live row probed, the id's conflict ignored);
 *   - every row passes entity_activity_writable, nothing runs while a merge
 *     is queued, and each record batch holds FOR SHARE on what it stamps;
 *   - an edge writes exactly 488's rows, a comment 488's kinds;
 *   - nothing is callable by anon or authenticated;
 *   - 517 runs it from pg_cron, one batch per tick, and the tick
 *     unschedules the same job;
 *   - 518 gives Recent an index in its exact order (measured on DEV).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_ENTITY_TYPES, ENTITY_REGISTRY } from '@/lib/knowledge/entity-registry'

const read = (f: string) => readFileSync(join(process.cwd(), 'supabase/migrations', f), 'utf8')
const sql = read('516_entity_activity_backfill.sql')
const run = read('517_entity_activity_backfill_run.sql')
const sql489 = read('489_entity_activity_hardening.sql')
const recent = read('518_entity_activity_recent_index.sql')

const fn = (name: string) => new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(sql)?.[0] ?? ''
const step = fn('entity_activity_backfill_step')
const home = fn('entity_activity_backfill_home')
const tick = fn('entity_activity_backfill_tick')
const unschedule = fn('entity_activity_backfill_unschedule')

/** The step's branches, by source. */
const branches = new Map(
  [...step.matchAll(/(?:els)?if p\.source = '([a-z_]+)' then([\s\S]*?)(?=\n  (?:els)?if p\.source = |\n  end if;)/g)].map((m) => [m[1], m[2]]),
)
const RECORD_SOURCES = ACTIVITY_ENTITY_TYPES.filter((k) => k !== 'team_chat_message')
const tableOf = new Map<string, string>(ENTITY_REGISTRY.map((e) => [e.id, e.table]))

describe('migration 516: the activity log, backfilled', () => {
  it('marks its rows, and the Inbox has a column to skip them by', () => {
    expect(sql).toContain('alter table public.entity_activity add column if not exists backfilled boolean not null default false;')
    const inserts = step.match(/insert into public\.entity_activity \(([^)]*)\)/g) ?? []
    expect(inserts).toHaveLength(branches.size)
    for (const cols of inserts) expect(cols).toMatch(/, backfilled\)$/)
    // Every select feeding an insert ends its row with `true` (the mark).
    expect(step.match(/, true\n {8}from b/g)?.length).toBe(branches.size)
  })

  it('has a source for every logged kind, plus comments and edges, each a branch of the step', () => {
    const seeded = [...sql.matchAll(/\('([a-z_]+)', (\d+)\)/g)].map((m) => m[1])
    expect(new Set(seeded)).toEqual(new Set([...RECORD_SOURCES, 'comment', 'entity_link']))
    expect(seeded.slice(-2)).toEqual(['comment', 'entity_link'])
    expect([...branches.keys()]).toEqual(seeded)
    for (const kind of RECORD_SOURCES) {
      const body = branches.get(kind) ?? ''
      expect(body, kind).toContain(`from public.${tableOf.get(kind)} x`)
      // The batch: key order past where the last one stopped, locked for its moves,
      // in a statement of its own; the write reads what it locked with a fresh snapshot.
      expect(body, kind).toMatch(/into v_ids\s+from \(select x\.id from public\.\w+ x\s+where x\.id > v_after[\s\S]*?order by x\.id\s+limit p_limit\s+for share of x\) s;\n    with b as \(/)
      expect(body, kind).toContain('where x.id = any(v_ids)')
      expect(body, kind).toContain('select count(*)::int into v_rows from ins;')
    }
    expect(step).toMatch(/v_seen := cardinality\(v_ids\);\s+v_last := v_ids\[v_seen\];/)
  })

  it('finds every logged kind’s home, locked, and never a record the log leaves out', () => {
    for (const kind of ACTIVITY_ENTITY_TYPES) {
      expect(home, kind).toMatch(new RegExp(`when '${kind}' then \\(select x\\.workspace_id from public\\.${tableOf.get(kind)} x where x\\.id = p_id[^)]* for share\\)`))
    }
    expect(home).toContain('x.is_eval is not true')
    expect(home).toContain('x.merged_into_contact_id is null')
    expect(home).toContain('x.deleted_at is null')
    expect(home).toMatch(/\nvolatile\n/)
  })

  it('writes each row once: the live row probed, the id derived, its conflict ignored', () => {
    for (const [source, body] of branches) {
      expect(body, source).toMatch(/public\.entity_activity_backfill_id\('/)
      expect(body, source).toContain('on conflict (id) do nothing')
      expect(body, source).toMatch(/not exists \(\s*select 1 from public\.entity_activity e\s+where e\.entity_type = /)
    }
    expect(fn('entity_activity_backfill_id')).toMatch(/\nimmutable\n/)
  })

  it('leaves out what the live triggers leave out', () => {
    expect(branches.get('action')).toContain("x.confirmation is distinct from 'suggested'")
    expect(branches.get('capture')).toContain('x.is_eval is not true')
    expect(branches.get('contact')).toContain("(x.source is null or x.source = 'manual')")
    expect(branches.get('contact')).toContain('x.merged_into_contact_id is null')
    expect(branches.get('company')).toContain('x.source_provider is null')
    expect(branches.get('entity_link')).toContain("l.source_type <> 'claim'")
  })

  it('credits only a record’s making to its maker (or its agent); an archive or a move is the system’s', () => {
    const maker = "case when v.action = 'created' and m.id is not null then 'member' else 'system' end, case when v.action = 'created' then m.id end"
    const agent = "case when v.action <> 'created' or m.id is null then 'system' when b.by_agent then 'agent' else 'member' end, case when v.action = 'created' then m.id end"
    for (const kind of ['document', 'capture', 'project']) expect(branches.get(kind), kind).toContain(maker)
    for (const kind of ['action', 'deal']) expect(branches.get(kind), kind).toContain(agent)
    expect(branches.get('action')).toMatch(/source_type in \('chat_suggestion', 'meeting_extraction'\) or x\.context_source in \('ai_chat', 'meeting_note'\), false\) as by_agent/)
    expect(branches.get('deal')).toContain("x.source is not distinct from 'capture' as by_agent")
    // A branch with more than 'created' never credits a member without asking which action it is.
    for (const [source, body] of branches) {
      if (/\('(archived|status_changed)'/.test(body)) expect(body, source).not.toContain("case when m.id is null then 'system' else 'member' end, m.id")
    }
    expect(branches.get('initiative')).toContain("'system', null, '{}'::jsonb, v.at, true")
  })

  it('does not call a run done when it wrote nothing while its sources hold rows', () => {
    const guard = step.slice(step.indexOf('nothing ever written'), step.indexOf('update public.entity_activity_backfill_progress'))
    expect(guard).toContain('not exists (select 1 from public.entity_activity e where e.backfilled)')
    expect(guard).toMatch(/q\.done_at is null and q\.source <> p\.source/)
    expect(guard).toContain('from pg_catalog.pg_class c')
    expect(guard).toMatch(/raise exception 'entity_activity_backfill: every source was read and nothing was written/)
    // It runs before the source is marked done.
    expect(step.indexOf('raise exception \'entity_activity_backfill: every source')).toBeLessThan(step.lastIndexOf('done_at = case when v_seen < p_limit then now() end'))
  })

  it('respects merges and moves as 489 does', () => {
    for (const [source, body] of branches) expect(body, source).toMatch(/public\.entity_activity_writable\((b|h)\.workspace_id\)/)
    expect(step).toMatch(/if exists \(select 1 from public\.workspace_merge_job j where j\.status = 'queued'\) then\s+return jsonb_build_object\('waiting', 'merge'\);/)
    // The merge check comes before any write.
    expect(step.indexOf('workspace_merge_job')).toBeLessThan(step.indexOf('insert into public.entity_activity'))
    // Comments and edges stamp the record's workspace now, through the locked home.
    expect(branches.get('comment')).toContain('public.entity_activity_backfill_home(b.entity_type, b.entity_id) as workspace_id')
    expect(branches.get('entity_link')).toContain('public.entity_activity_backfill_home(v.entity_type, v.entity_id) = b.workspace_id')
    expect(branches.get('entity_link')).toContain('public.entity_activity_backfill_home(v.other_type, v.other_id) = b.workspace_id')
  })

  it('writes an edge’s rows exactly as 488’s edge trigger, and a comment on 488’s kinds', () => {
    const kinds = (text: string) => /kinds (?:constant )?text\[\] := array\[([^\]]+)\]/.exec(text)?.[1]
    expect(kinds(step)).toBe(kinds(sql489))
    const edges = branches.get('entity_link') ?? ''
    const liveEdges = /entity_activity_entity_link_insert\(\)[\s\S]*?\n\$\$;/.exec(sql489)?.[0] ?? ''
    // The same four rows: each relation test and detail, character for character.
    for (const m of liveEdges.matchAll(/jsonb_build_object\(([^)]*)\),\s+(n\.relation [^)]*?)\),?\n/g)) {
      expect(edges).toContain(`jsonb_build_object(${m[1].replace(/\bn\./g, 'b.')})`)
      expect(edges).toContain(m[2].replace(/\bn\./g, 'b.'))
    }
    const liveComments = /entity_activity_comment_insert\(\)[\s\S]*?\n\$\$;/.exec(sql489)?.[0] ?? ''
    const commented = [...liveComments.matchAll(/when '([a-z_]+)' then \(select x\.workspace_id/g)].map((m) => m[1])
    expect(branches.get('comment')).toContain(`c.commentable_type::text in ('${commented.join("', '")}')`)
  })

  it('is callable by no client, and runs as its owner', () => {
    for (const name of ['entity_activity_backfill_step', 'entity_activity_backfill_tick']) {
      expect(fn(name), name).toMatch(/security definer\s+set search_path = public, pg_temp/)
    }
    expect(sql).toContain('revoke all on function public.entity_activity_backfill_step(integer) from public, anon, authenticated;')
    expect(sql).toContain('revoke all on function public.entity_activity_backfill_tick() from public, anon, authenticated;')
    expect(sql).toContain('revoke all on function public.entity_activity_backfill_home(text, uuid) from public, anon, authenticated;')
    expect(sql).toContain('revoke all on function public.entity_activity_backfill_id(text[]) from public, anon, authenticated;')
    expect(sql).toContain('revoke all on function public.entity_activity_backfill_unschedule() from public, anon, authenticated;')
    expect(sql).toContain('alter table public.entity_activity_backfill_run enable row level security;')
    expect(sql).toContain('revoke all on public.entity_activity_backfill_run from anon, authenticated;')
    expect(sql).toContain('alter table public.entity_activity_backfill_progress enable row level security;')
    expect(sql).toContain('revoke all on public.entity_activity_backfill_progress from anon, authenticated;')
    // No subtransaction per row: the tick's one handler is per batch.
    expect(step).not.toMatch(/\bexception when\b/)
    expect(tick.match(/exception when others/g)).toHaveLength(1)
  })

  it('is idempotent, reloads the API schema, and has no backslash', () => {
    expect(sql).toContain('create table if not exists public.entity_activity_backfill_progress')
    expect(sql).toMatch(/on conflict \(source\) do nothing;/)
    expect(sql.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    expect(sql).not.toMatch(/\\/)
  })
})

describe('migration 517: the backfill runs from pg_cron', () => {
  it('schedules one batch per tick, only while a source is left, and the tick unschedules the same job', () => {
    expect(run).toMatch(
      /if exists \(select 1 from public\.entity_activity_backfill_progress where done_at is null\) then[\s\S]*?perform cron\.schedule\('entity-activity-backfill', '2 seconds', 'select public\.entity_activity_backfill_tick\(\)'\);/,
    )
    expect(unschedule).toContain("perform cron.unschedule('entity-activity-backfill');")
    expect(tick).toContain('perform public.entity_activity_backfill_unschedule();')
    expect(tick).toContain('public.entity_activity_backfill_step(1000)')
    // 517 starts the run's clock.
    expect(run).toMatch(/insert into public\.entity_activity_backfill_run[\s\S]*on conflict \(id\) do update[\s\S]*stopped_at = null, stop_reason = null;\s+perform cron\.schedule/)
  })

  it('always stops: clearing the run log cannot fail the stop, and the tick has a deadline, a stall limit and a merge limit', () => {
    expect(unschedule).toMatch(/begin\s+delete from cron\.job_run_details[\s\S]*?exception when others then\s+raise warning/)
    expect(unschedule.indexOf('exception when others')).toBeLessThan(unschedule.indexOf('perform cron.unschedule'))
    expect(tick).toContain("now() > v_run.scheduled_at + interval '60 minutes'")
    expect(tick).toContain("now() > v_run.last_progress_at + interval '10 minutes'")
    expect(tick).toContain("v_merge_since < now() - interval '10 minutes'")
    expect(tick).toMatch(/if r \? 'source' then\s+update public\.entity_activity_backfill_run set last_progress_at = now\(\) where id;/)
    expect(tick).toContain('failures >= 30')
    // A stopped run stays stopped (its unschedule is retried, never its batches).
    expect(tick).toMatch(/if v_run\.stopped_at is not null then\s+v_stop := v_run\.stop_reason;/)
    expect(run).not.toMatch(/\\/)
  })
})

describe('migration 518: Recent reads in index order', () => {
  it('indexes exactly what the feed asks for actor=me, and drops the index it replaces', () => {
    const feed = readFileSync(join(process.cwd(), 'src/lib/entities/feed.ts'), 'utf8')
    // The feed always names the workspace, then the member, newest first.
    expect(feed).toContain(".from('entity_activity').select(ROW_SELECT).eq('workspace_id', viewer.workspaceId)")
    expect(feed).toContain(".eq('actor_member_id', viewer.memberId)")
    expect(feed).toContain(".order('created_at', { ascending: false }).order('id', { ascending: false })")
    expect(recent).toMatch(
      /create index if not exists entity_activity_actor_recent_idx\s+on public\.entity_activity \(workspace_id, actor_member_id, created_at desc, id desc\)\s+where actor_member_id is not null;/,
    )
    expect(recent).toContain('drop index if exists public.entity_activity_actor_idx;')
    expect(recent.trimEnd().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    expect(recent).not.toMatch(/\\/)
  })
})
