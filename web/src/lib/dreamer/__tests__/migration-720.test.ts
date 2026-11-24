/**
 * Migration 720: the Dreamer (docs/plans/dreamer.md). TEXT CHECKS of the SQL
 * file (no Postgres engine is a dependency of this repository): its two
 * tables (agent_note, dreamer_report) with their shapes, RLS (one owner
 * SELECT policy each) and grants; the server kind 'dreamer'; start_chat_helper
 * as 443's, line for line, but for the kind and the Dreamer's longer task;
 * home_turn.reason as 474's plus 'dreamer'; and the merge fold trigger.
 *
 * The SQL was also applied twice on PGlite (a real Postgres engine, in a
 * scratch install outside this repository) over stand-ins for the tables it
 * touches, holding a row from before, on 2026-11-24, with these asserted
 * there: both widened checks end validated, and an old row that breaks one
 * stops the file at its VALIDATE, naming it; RLS on and one SELECT
 * policy per table, anon nothing, authenticated SELECT only, both functions
 * definers with a pinned search_path and start_chat_helper the service role's
 * alone; the path rules (`..`, `//`, a trailing `/`, outside /agent_notes/, a
 * space, 240 after the root), the body and report caps, uniqueness per
 * person, workspace and path, byte order (collate "C"); the owner reads their
 * notes, cannot write one, and nobody else reads them; a merge keeps both
 * notes at one path (the moving one suffixed) and outside a merge the key
 * holds; the admission starts a Dreamer with a 20,000-character task, the
 * same slot is the same run, one working per person (SERVER_LIVE), six a
 * UTC day (SERVER_DAY_BUDGET), a meeting prep still capped at 10,000, a
 * Dreamer past 24,000 and an unknown kind refused (INVALID_BRIEF), a
 * dreamer run chat-origin only; one report per run, an empty one refused,
 * reflection false by default; home_turn takes 'dreamer' and refuses an
 * unknown reason.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'
import { AGENT_NOTE_MAX_CHARS, AGENT_NOTE_PATH_RE, DREAMER_REPORT_MAX_CHARS } from '../notes'
import { dreamerTaskPrompt, dreamerRunContext } from '../run'

const DIR = join(process.cwd(), 'supabase/migrations')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const SQL = read('720_dreamer.sql')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
const fnOf = (body: string) => {
  const start = body.indexOf('create or replace function public.start_chat_helper(')
  expect(start).toBeGreaterThanOrEqual(0)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const FN = fnOf(BODY)
const inList = (body: string, name: string, col: string): string[] => {
  const m = new RegExp(`${name} check \\(${col} in \\(([^)]*)\\)\\)`).exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}
const SIG_14 = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text,text)'

describe('migration 720', () => {
  it('is the only 720, holds no backslash, takes a short lock and is safe to run twice', () => {
    expect(readdirSync(DIR).filter((f) => f.startsWith('720_'))).toEqual(['720_dreamer.sql'])
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY.startsWith("set local lock_timeout = '5s';")).toBe(true)
    expect(BODY).toContain('create table if not exists public.agent_note (')
    expect(BODY).toContain('create table if not exists public.dreamer_report (')
    for (const [table, check] of [
      ['agent_note', 'agent_note_path_shape'],
      ['agent_note', 'agent_note_body_length'],
      ['dreamer_report', 'dreamer_report_prompt_length'],
      ['agent_run', 'agent_run_server_helper_shape'],
      ['home_turn', 'home_turn_reason_check'],
    ]) {
      expect(BODY).toContain(`alter table public.${table} drop constraint if exists ${check};`)
    }
    expect(BODY).not.toMatch(/create function |drop table|delete from|truncate|update public\./)
    expect(SQL).toContain('Re-list main')
    expect(BODY).toContain("notify pgrst, 'reload schema';")
  })

  it('agent_note: one row per file, its path rules and body cap the notes tools use, unique per person and workspace', () => {
    expect(BODY).toContain('path text collate "c" not null,')
    expect(BODY).toContain('size integer generated always as (char_length(body)) stored,')
    expect(BODY).toContain(
      "check (path ~ '^/agent_notes/[a-za-z0-9._/-]{1,240}$' and position('..' in path) = 0 and position('//' in path) = 0 and right(path, 1) <> '/');",
    )
    // The same rule as the tools' (lower-cased here, as the body is).
    expect(AGENT_NOTE_PATH_RE.source.toLowerCase().replace(/\\\//g, '/')).toBe('^/agent_notes/[a-za-z0-9._/-]{1,240}$')
    expect(BODY).toContain(`check (char_length(body) <= ${AGENT_NOTE_MAX_CHARS});`)
    expect(BODY).toContain('create unique index if not exists agent_note_owner_path_key on public.agent_note (workspace_id, user_id, path);')
    expect(BODY).toContain('user_id uuid not null references auth.users(id) on delete cascade,')
  })

  it('dreamer_report: one per run, its cap, reflection, and where it was delivered', () => {
    expect(BODY).toContain('agent_run_id uuid not null references public.agent_run(id) on delete cascade,')
    expect(BODY).toContain('reflection boolean not null default false,')
    expect(BODY).toContain('delivered_at timestamptz null,')
    expect(BODY).toContain('home_turn_id uuid null references public.home_turn(id) on delete set null')
    expect(BODY).toContain(`check (char_length(prompt) between 1 and ${DREAMER_REPORT_MAX_CHARS});`)
    expect(BODY).toContain('create unique index if not exists dreamer_report_agent_run_key on public.dreamer_report (agent_run_id);')
    expect(BODY).toContain('create index if not exists dreamer_report_undelivered_idx on public.dreamer_report (workspace_id, user_id, created_at) where delivered_at is null;')
  })

  it('both tables: RLS on, the owner reads their own, writes the service role alone', () => {
    for (const table of ['agent_note', 'dreamer_report']) {
      expect(BODY).toContain(`alter table public.${table} enable row level security;`)
      expect(BODY).toContain(`drop policy if exists ${table}_select_own on public.${table};`)
      expect(BODY).toContain(
        `create policy ${table}_select_own on public.${table} for select to authenticated using (user_id = auth.uid() and public.is_workspace_member(workspace_id));`,
      )
      expect(BODY).toContain(`revoke all on table public.${table} from public, anon, authenticated;`)
      expect(BODY).toContain(`grant select on table public.${table} to authenticated;`)
      expect(BODY).toContain(`grant all on table public.${table} to service_role;`)
    }
    // Select policies only.
    expect([...BODY.matchAll(/create policy [a-z_]+ on public\.[a-z_]+ for ([a-z]+)/g)].map((m) => m[1])).toEqual(['select', 'select'])
  })

  it('a workspace merge moves a note at a taken path with a suffix, only during a merge, within the path shape', () => {
    expect(BODY).toContain('if new.workspace_id is distinct from old.workspace_id and public._wsmerge_active() then')
    expect(BODY).toContain("new.path := left(new.path, 230) || '-merged-' || left(replace(old.id::text, '-', ''), 8);")
    expect(BODY).toContain('create trigger agent_note_merge_fold before update of workspace_id on public.agent_note for each row execute function public.agent_note_merge_fold();')
    expect(BODY).toContain('revoke all on function public.agent_note_merge_fold() from public, anon, authenticated;')
    expect(230 + '-merged-'.length + 8).toBeLessThanOrEqual('/agent_notes/'.length + 240)
  })

  it('the widened checks on existing tables are added NOT VALID and validated in statements of their own, after the swaps', () => {
    expect(BODY).toContain("and origin = 'chat')) not valid;")
    expect(BODY).toContain("'team_chat', 'dreamer')) not valid;")
    const validateRun = BODY.indexOf('alter table public.agent_run validate constraint agent_run_server_helper_shape;')
    const validateTurn = BODY.indexOf('alter table public.home_turn validate constraint home_turn_reason_check;')
    expect(validateRun).toBeGreaterThan(BODY.indexOf('add constraint agent_run_server_helper_shape'))
    expect(validateTurn).toBeGreaterThan(BODY.indexOf('add constraint home_turn_reason_check'))
    // Last but the schema reload: nothing after them but the notify.
    expect(BODY.slice(validateTurn).replace('alter table public.home_turn validate constraint home_turn_reason_check;', '').trim()).toBe("notify pgrst, 'reload schema';")
  })

  it("server_helper gains 'dreamer', on chat work only", () => {
    expect(BODY).toContain("check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn', 'check_in', 'dreamer') and origin = 'chat'))")
    // 443's shape, plus the one kind.
    expect(flat(read('443_now_follow_up.sql'))).toContain("check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn', 'check_in') and origin = 'chat'))")
  })

  it("start_chat_helper takes the kind and the Dreamer's longer task, and is 443's otherwise, line for line", () => {
    expect(FN).toContain("p_server_helper not in ('meeting_prep', 'home_turn', 'check_in', 'dreamer') or p_teammate_id is not null")
    expect(FN).toContain("length(trim(p_task_prompt)) not between 1 and (case when p_server_helper = 'dreamer' then 24000 else 10000 end)")
    // 443's caps, unchanged: one working per kind, six a UTC day for every kind but meeting_prep.
    expect(FN).toContain('v_server_live integer := 1;')
    expect(FN).toContain('v_server_daily integer := 6;')
    expect(FN).toContain("if p_server_helper <> 'meeting_prep' and (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper")
    const strip = (t: string) =>
      t
        .replace("('meeting_prep', 'home_turn', 'check_in', 'dreamer')", "('meeting_prep', 'home_turn', 'check_in')")
        .replace("not between 1 and (case when p_server_helper = 'dreamer' then 24000 else 10000 end)", 'not between 1 and 10000')
    expect(strip(FN)).toBe(fnOf(flat(read('443_now_follow_up.sql'))))
    expect(BODY).toContain(`revoke all on function ${SIG_14} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${SIG_14} to service_role;`)
  })

  it("the Dreamer's task fits the admission's 24,000 (its role and the run's instructions)", () => {
    const task = dreamerTaskPrompt(dreamerRunContext({ localDate: '2026-11-24', hour: 7, timeZone: 'America/Los_Angeles' }))
    expect(task.length).toBeGreaterThan(10_000)
    expect(task.trim().length).toBeLessThanOrEqual(24_000)
  })

  it("home_turn.reason is 474's list plus dreamer, exactly the app's reasons", () => {
    const listed = inList(BODY, 'home_turn_reason_check', 'reason')
    expect(listed).toEqual([...inList(flat(read('474_team_chat.sql')), 'home_turn_reason_check', 'reason'), 'dreamer'])
    expect(listed).toEqual([...HOME_TURN_REASONS])
  })
})
