/**
 * Migration 329: the agent's log (A2b). This pins the file: one templated line
 * for one person in one workspace, gone with the workspace or the user but not
 * with the membership, read only by its own person while a member, written
 * only by the server, and a backfill of the last 30 days whose dedupe keys are
 * the live writers' (src/lib/log/agent-log.ts logDedupeKey), whose clip, area
 * check, filter and templates are the live writers' too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { AREA_KEYS } from '@/lib/packs/registry'

/** The 16 page areas this migration knew; 384 adds content and marketing to the CHECKs. */
const PAGE_AREAS = AREA_KEYS.filter((a) => a !== 'content' && a !== 'marketing')
import { WORK_KINDS } from '@/lib/work/types'
import { AGENT_LOG_KINDS, LOG_HOUSEKEEPING_KINDS, LOG_LINE_MAX, LOG_SUMMARY_MAX, LOG_TITLE_MAX, logDedupeKey, logLineFor } from '../agent-log'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/329_agent_log.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 329', () => {
  it('creates agent_log idempotently, a bigint identity id (the chat cursor) and the columns the writers fill', () => {
    expect(BODY).toContain('create table if not exists public.agent_log (')
    expect(BODY).toContain('id bigint generated always as identity primary key')
    for (const col of ['at timestamptz not null default now()', 'area text,', 'ref_type text,', 'ref_id text,', 'created_at timestamptz not null default now()']) {
      expect(BODY).toContain(col)
    }
  })

  it('goes with the workspace or the user, not with the membership (a departed member keeps their log)', () => {
    expect(BODY).toContain('workspace_id uuid not null references public.workspace(id) on delete cascade')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade')
    expect(BODY).not.toMatch(/references public\.member/)
  })

  it('checks the kind against the writers’ list and the line against the 200-character cap', () => {
    const kinds = /kind in \(([^)]*)\)/.exec(BODY)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))
    // 'doc_updated', 'pr_changed', 'mail_archived', 'action_done_from_mail' and 'look_ahead' came later: migrations 376, 443, 446, 450 and 452 widen the check (pinned in their own tests).
    expect(kinds).toEqual(AGENT_LOG_KINDS.filter((k) => k !== 'doc_updated' && k !== 'pr_changed' && k !== 'mail_archived' && k !== 'action_done_from_mail' && k !== 'look_ahead'))
    expect(BODY).toContain(`check (char_length(btrim(line)) between 1 and ${LOG_LINE_MAX} and char_length(line) <= ${LOG_LINE_MAX})`)
  })

  it('has the unique dedupe index and the recent-lines index', () => {
    expect(BODY).toContain('create unique index if not exists agent_log_dedupe_idx on public.agent_log (workspace_id, user_id, dedupe_key);')
    expect(BODY).toContain('create index if not exists agent_log_recent_idx on public.agent_log (workspace_id, user_id, at desc);')
  })

  it('lets each person read only their own lines, while a member, and nobody write from a client', () => {
    expect(BODY).toContain('alter table public.agent_log enable row level security;')
    expect(BODY).toContain('drop policy if exists "agent_log_select" on public.agent_log;')
    expect(BODY).toContain(
      'for select to authenticated using (user_id = (select auth.uid()) and public.is_workspace_member(workspace_id));',
    )
    expect(BODY).not.toMatch(/for (insert|update|delete|all) to/)
    expect(BODY).toContain('revoke all on table public.agent_log from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.agent_log to authenticated;')
  })

  it('backfills 30 days from tracked_job (owner member → user) and processed captures (their owner), re-runnable', () => {
    expect(BODY).toContain("now() - interval '30 days'")
    expect(BODY).toContain('join public.member m on m.id = tj.member_id and m.workspace_id = tj.workspace_id')
    expect(BODY).toContain("tj.status <> 'skipped'")
    expect(BODY).toContain('from public.captures c where c.user_id is not null')
    expect(BODY).toContain("coalesce(c.metadata ->> 'demo', '') <> 'true'")
    // Both inserts skip a line already there.
    expect(BODY.match(/on conflict \(workspace_id, user_id, dedupe_key\) do nothing;/g)).toHaveLength(2)
    // Clipped as the live templates clip.
    expect(BODY).toContain(`pg_temp.agent_log_clip(tj.title, ${LOG_TITLE_MAX})`)
    expect(BODY).toContain(`pg_temp.agent_log_clip(tj.result_summary, ${LOG_SUMMARY_MAX})`)
    expect(BODY).toContain(`pg_temp.agent_log_clip(c.title, ${LOG_TITLE_MAX})`)
    expect(BODY).toContain('drop function if exists pg_temp.agent_log_clip(text, int);')
  })

  it('uses the live writers’ dedupe keys, so a live line never doubles a backfilled one', () => {
    const id = 'ID'
    const shapes: Array<[string, string]> = [
      [logDedupeKey.workStarted(id), "'work:' || id || ':started'"],
      [logDedupeKey.workNeedsReview(id), "'work:' || id || ':needs_review'"],
      [logDedupeKey.workDone(id), "'work:' || id || ':done'"],
      [logDedupeKey.workFailed(id), "'work:' || id || ':failed'"],
      [logDedupeKey.workCanceled(id), "'work:' || id || ':canceled'"],
      [logDedupeKey.workSettled(id), "'work:' || id || ':settled'"],
      [logDedupeKey.captureProcessed(id), "'capture:' || c.id || ':processed'"],
    ]
    for (const [key, sql] of shapes) {
      expect(key.replace('ID', '')).toBe(sql.replace(/'/g, '').replace(/ \|\| (c\.)?id \|\| /, ''))
      expect(BODY).toContain(sql)
    }
    // A question is keyed by the instant of its move, in epoch milliseconds.
    expect(logDedupeKey.workNeedsInput(id, '2026-10-14T09:12:03.456Z')).toBe('work:ID:needs_input:1791969123456')
    expect(BODY).toContain("'work:' || id || ':needs_input:' || floor(extract(epoch from last_beat_at) * 1000)::bigint")
  })

  it('keys a settle the live writer’s way, and says an expired review as the live template does', () => {
    expect(BODY).toContain("'work:' || id || ':settled'")
    const expired = logLineFor({ type: 'work_settled', title: 'T', outcome: 'expired' })!
    expect(expired).toEqual({ kind: 'work_canceled', line: 'Expired unreviewed: T' })
    expect(BODY).toContain("when review = 'expired' then 'Expired unreviewed: ' || title")
    expect(BODY).toContain("case when review in ('dismissed', 'expired') then 'work_canceled' else 'work_finished' end")
    for (const [outcome, phrase] of [
      ['dismissed', "'Dismissed: ' || title"],
      ['reviewed', "'Reviewed: ' || title"],
      ['resolved', "'Done: ' || title || ' (acted on)'"],
    ] as const) {
      expect(logLineFor({ type: 'work_settled', title: 'T', outcome })!.line).toBe(phrase.replace(/' \|\| title( \|\| ')?/, 'T').replace(/'/g, ''))
      expect(BODY).toContain(phrase)
    }
  })

  it('clips with exactly the live writer’s character class (JS \\p{Cc}, \\p{Cf} and \\s), code point for code point', () => {
    // The class is built in SQL from decimal code point ranges with chr(), so
    // the file holds no escape sequence a transport could decode.
    expect(BODY).toContain('pg_temp.agent_log_space_class(),')
    expect(BODY).toContain("select '[' || string_agg(chr(lo) || case when hi > lo then '-' || chr(hi) else '' end, '' order by lo) || ']+'")
    const block = /create or replace function pg_temp\.agent_log_space_class\(\)([\s\S]*?)\$\$;/.exec(SQL)?.[1] ?? ''
    const ranges = [...block.matchAll(/\((\d+), (\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])] as const)
    expect(ranges.length).toBeGreaterThan(10)
    const inClass = (cp: number) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi)
    const live = /[\p{Cc}\p{Cf}\s]/u
    const mismatched: string[] = []
    // From U+0001: a Postgres text value can't hold U+0000 (chr(0) fails). Surrogates aren't characters.
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      if (inClass(cp) !== live.test(String.fromCodePoint(cp))) mismatched.push(cp.toString(16))
    }
    expect(mismatched).toEqual([])
    // No character a bracket expression treats specially sits in a range: ] - ^ backslash [.
    for (const special of [']', '-', '^', '[', String.fromCharCode(92)]) expect(inClass(special.codePointAt(0)!)).toBe(false)
  })

  it('holds no backslash at all (a JSON transport decoded escapes once, so the applied SQL differed from the file)', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
  })

  it('grants a person only reads: Supabase defaults revoked, select granted, re-runnable', () => {
    expect(BODY).toContain('revoke all on table public.agent_log from anon, authenticated;')
    expect(BODY).toContain('grant select on table public.agent_log to authenticated;')
    expect(BODY).not.toMatch(/grant (insert|update|delete|truncate|all)[^;]* on table public\.agent_log/)
  })

  it('writes an area only when it is a registered one (registry.ts AREA_KEYS), as appendLogLine does', () => {
    const keys = /when tj\.area in \(([^)]*)\) then tj\.area end as area/.exec(BODY)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))
    // The page areas of its day: this backfill ran once, before the Studio (620) had an area of its own.
    expect(keys).toEqual(PAGE_AREAS.filter((area) => area !== 'studio'))
  })

  it('leaves out what the live filter leaves out: quiet rows, children, housekeeping kinds, the drafts pass but for drafts made', () => {
    expect(BODY).toContain("and coalesce(tj.source ->> 'quiet', '') <> 'true'")
    expect(BODY).toContain('and tj.parent_id is null and coalesce(tj.depth, 0) = 0')
    const kinds = /and tj\.kind not in \(([^)]*)\)/.exec(BODY)?.[1].split(',').map((k) => k.trim().replace(/'/g, ''))
    expect(kinds).toEqual([...LOG_HOUSEKEEPING_KINDS])
    expect(BODY).toContain(`kind <> '${WORK_KINDS.emailDrafts}'`)
    expect(BODY).toContain(`and (kind <> '${WORK_KINDS.emailDrafts}' or delivered > 0)`)
  })

  it('writes no Started for a row the live writer logged only where it landed (a one-shot, or one written waiting on review)', () => {
    expect(BODY).toContain(
      "(tj.started_at is not null and tj.finished_at is not null and tj.started_at = tj.finished_at and tj.started_at <= tj.created_at + interval '2 seconds') as one_shot",
    )
    expect(BODY).toContain("(tj.finished_at is null and (tj.status = 'needs_review' or tj.reviewed_at is not null)) as born_waiting")
    expect(BODY).toContain("where not one_shot and not born_waiting and kind <> 'email_drafts'")
  })

  it('leaves out archived and demo captures, as the live consumer does', () => {
    expect(BODY).toContain("and coalesce(c.status, '') <> 'archived'")
    expect(BODY).toContain("and coalesce(c.metadata ->> 'demo', '') <> 'true'")
  })
})
