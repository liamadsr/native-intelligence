/**
 * Migration 443: the Now file follows up (Slice 2). Each check is its latest
 * version plus one value: home_turn.reason 'check_in' (435's), agent_event
 * kind 'pr.changed' (406's), agent_log kind 'pr_changed' (376's), the
 * server_helper kind 'check_in' (340's) and the notification type
 * 'agent_check_in' (407's). agent_run gains server_helper_item, the tracked
 * item a check-in's helper retries (required on that kind only, unique per
 * person). start_chat_helper is 422's, line for line, but for the 14th
 * argument, the kind list, the item's shape check, the check-in's three caps
 * (one retry per item, one per check-in, three in 24 hours) and the item in
 * the insert.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'
import { AGENT_EVENT_KINDS, AGENT_EVENT_SOURCES, KIND_SOURCE } from '@/lib/agent-events/types'
import { AGENT_LOG_KINDS } from '@/lib/log/agent-log'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { NOW_TRACK_KINDS } from '../now-file'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const SQL = read('443_now_follow_up.sql')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
/** The quoted values of the first `<name> check (<col> in (…))` in a flattened body. */
const inList = (body: string, name: string, col: string): string[] => {
  const m = new RegExp(`${name} check \\(${col} in \\(([^)]*)\\)\\)`).exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}
const notificationTypes = (body: string): string[] => {
  const m = /notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(body)
  return m ? m[1].split(',').map((v) => v.trim().replace(/'/g, '')) : []
}
const fnOf = (body: string) => {
  const start = body.indexOf('create or replace function public.start_chat_helper(')
  expect(start).toBeGreaterThanOrEqual(0)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const FN = fnOf(BODY)
const mergeFnOf = (body: string) => {
  const start = body.indexOf('create or replace function public._wsmerge_documents(')
  expect(start).toBeGreaterThanOrEqual(0)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const MERGE_FN = mergeFnOf(BODY)
const SIG_13 = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text)'
const SIG_14 = 'public.start_chat_helper(uuid,uuid,uuid,text,text,uuid,text,jsonb,jsonb,jsonb,text[],text[],text,text)'
const ITEM_RE = "'^(work|action|pr|ask):[a-za-z0-9][a-za-z0-9._#/-]{0,199}$'"

describe('migration 443', () => {
  it('has no backslash, takes a short lock and is safe to run twice', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY.startsWith("set local lock_timeout = '5s';")).toBe(true)
    for (const [table, check] of [
      ['home_turn', 'home_turn_reason_check'],
      ['agent_event', 'agent_event_kind_check'],
      ['agent_log', 'agent_log_kind_check'],
      ['agent_run', 'agent_run_server_helper_shape'],
      ['agent_run', 'agent_run_server_helper_item_shape'],
      ['notification', 'notification_type_check'],
    ]) {
      expect(BODY).toContain(`alter table public.${table} drop constraint if exists ${check};`)
    }
    expect(BODY).toContain('alter table public.agent_run add column if not exists server_helper_item text null;')
    expect(BODY).toContain('create unique index if not exists agent_run_check_in_item_idx')
    expect(BODY).toContain(`drop function if exists ${SIG_13};`)
    expect(BODY).not.toMatch(/create function /)
    // No data changes of its own: the merge step's updates run only inside a merge.
    expect(BODY.replace(MERGE_FN, '')).not.toMatch(/create table|drop table|delete from|update public/)
  })

  it("home_turn.reason is 435's list plus check_in, and 445's approval so either order keeps both", () => {
    const listed = inList(BODY, 'home_turn_reason_check', 'reason')
    expect(listed).toEqual([...inList(flat(read('435_agent_links.sql')), 'home_turn_reason_check', 'reason'), 'check_in', 'approval'])
    // Every reason the app writes; 'check_in' lands in HOME_TURN_REASONS with the check-in, either may come first. 456 adds 'call', 474 'team_chat'.
    for (const r of HOME_TURN_REASONS.filter((r) => r !== 'call' && r !== 'team_chat')) expect(listed).toContain(r)
  })

  it("agent_event.kind is 406's list plus pr.changed, exactly the app's kinds, filed under work", () => {
    const listed = inList(BODY, 'agent_event_kind_check', 'kind')
    expect(listed).toEqual([...inList(flat(read('406_email_arrived.sql')), 'agent_event_kind_check', 'kind'), 'pr.changed'])
    // Kinds added after this file (each pinned by its own migration's test):
    // connection.needs_reconnect (451), quote.received (458) and job.paid (459).
    expect(listed).toEqual(AGENT_EVENT_KINDS.filter((k) => k !== 'connection.needs_reconnect' && k !== 'quote.received' && k !== 'job.paid'))
    expect(KIND_SOURCE['pr.changed']).toBe('work')
    expect(AGENT_EVENT_SOURCES).toContain('work')
  })

  it("agent_log.kind is 376's list plus pr_changed, and 446's mail_archived so either order keeps both: the app's kinds but 450's", () => {
    const listed = inList(BODY, 'agent_log_kind_check', 'kind')
    expect(listed).toEqual([...inList(flat(read('376_document_edit_meta.sql')), 'agent_log_kind_check', 'kind'), 'pr_changed', 'mail_archived'])
    expect(inList(flat(read('446_email_auto_archive.sql')), 'agent_log_kind_check', 'kind')).toEqual(listed)
    expect(listed).toEqual(AGENT_LOG_KINDS.filter((k) => k !== 'action_done_from_mail' && k !== 'look_ahead' && k !== 'kept_up_to_date'))
  })

  it("the notification types are 407's plus agent_check_in (452 adds agent_look_ahead and 454 agent_message after it)", () => {
    const listed = notificationTypes(BODY)
    expect(listed).toEqual([...notificationTypes(flat(read('407_merge_workspaces_phase2.sql'))), 'agent_check_in'])
    // 'agent_check_in' lands in NOTIFICATION_TYPES with the check-in's notice, either may come first.
    expect(listed).toEqual([...NOTIFICATION_TYPES.filter((t: string) => t !== 'agent_check_in' && t !== 'agent_look_ahead' && t !== 'agent_message' && t !== 'team_chat_message' && t !== 'meeting_waiting'), 'agent_check_in'])
  })

  it('server_helper gains check_in, on chat work only; its item is required there and nowhere else, and unique per person', () => {
    expect(BODY).toContain("check (server_helper is null or (server_helper in ('meeting_prep', 'home_turn', 'check_in') and origin = 'chat'))")
    expect(BODY).toContain(
      `check ( (server_helper_item is null and server_helper is distinct from 'check_in') or (server_helper = 'check_in' and server_helper_item is not null and server_helper_item ~ ${ITEM_RE}) );`,
    )
    expect(BODY).toContain(
      'create unique index if not exists agent_run_check_in_item_idx on public.agent_run (workspace_id, triggered_by, server_helper_item) where server_helper_item is not null;',
    )
    // The item is a Now file track: its kinds are the tracks' kinds.
    expect(ITEM_RE).toContain(`(${NOW_TRACK_KINDS.join('|')})`)
  })

  it('start_chat_helper takes the item, refuses it on any other start, and names it on the run', () => {
    expect(FN).toContain('p_server_helper text default null, p_server_helper_item text default null ) returns jsonb')
    expect(FN).toContain('language plpgsql security definer set search_path = public')
    expect(FN).toContain("p_server_helper not in ('meeting_prep', 'home_turn', 'check_in') or p_teammate_id is not null")
    expect(FN).toContain(
      `if (p_server_helper = 'check_in' and (p_server_helper_item is null or p_server_helper_item !~ ${ITEM_RE})) or (p_server_helper is distinct from 'check_in' and p_server_helper_item is not null) then return jsonb_build_object('code', 'invalid_brief'); end if;`,
    )
    expect(FN).toContain('helper_areas, server_helper, server_helper_item) values')
    expect(FN).toContain('p_areas, p_server_helper, p_server_helper_item) returning * into v_run;')
    expect(BODY).toContain(`revoke all on function ${SIG_14} from public, anon, authenticated;`)
    expect(BODY).toContain(`grant execute on function ${SIG_14} to service_role;`)
    expect(BODY).toContain("notify pgrst, 'reload schema';")
  })

  it("a check-in's helper: one retry per item, one per check-in, three in 24 hours, after the one-working rule", () => {
    const block = FN.slice(FN.indexOf("if p_server_helper = 'check_in' then"), FN.indexOf("if p_server_helper <> 'meeting_prep'"))
    expect(FN.indexOf("return jsonb_build_object('code', 'server_live')")).toBeLessThan(FN.indexOf("if p_server_helper = 'check_in' then"))
    expect(FN).toContain('v_check_in_daily integer := 3;')
    expect(block).toContain(
      "if exists (select 1 from public.agent_run where workspace_id = p_workspace_id and triggered_by = p_user_id and server_helper_item = p_server_helper_item) then return jsonb_build_object('code', 'server_item_retried'); end if;",
    )
    expect(block).toContain(
      "if exists (select 1 from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = 'check_in' and created_at > now() - interval '1 day' and starts_with(fire_key, 'chat-helper:' || p_conversation_id::text || ':session:' || split_part(p_turn_id, ':', 1) || ':turn:' || split_part(p_turn_id, ':', 2) || ':call:')) then return jsonb_build_object('code', 'server_turn_budget'); end if;",
    )
    expect(block).toContain(
      "if (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = 'check_in' and created_at > now() - interval '24 hours') >= v_check_in_daily then return jsonb_build_object('code', 'server_day_budget'); end if;",
    )
    // The prefix it counts is the key's own, up to the call id.
    expect(FN).toContain(
      "v_key := 'chat-helper:' || p_conversation_id::text || ':session:' || split_part(p_turn_id, ':', 1) || ':turn:' || split_part(p_turn_id, ':', 2) || ':call:' || p_call_id;",
    )
    // home_turn keeps its 6 a UTC day and meeting_prep stays uncapped (355), each counted per kind.
    expect(FN).toContain('v_server_daily integer := 6;')
    expect(FN).toContain("if p_server_helper <> 'meeting_prep' and (select count(*) from public.agent_run where workspace_id = p_workspace_id and origin = 'chat' and triggered_by = p_user_id and server_helper = p_server_helper")
  })

  it("a workspace merge keeps one live Now file per person and one retry per item, and is 402's step otherwise", () => {
    const archive =
      "update public.document s set status = 'archived' where s.workspace_id = p_source and s.kind = 'now' and s.status <> 'archived' and exists (select 1 from public.document d where d.workspace_id = p_dest and d.kind = 'now' and d.status <> 'archived' and d.created_by is not distinct from s.created_by); get diagnostics v_now_archived = row_count; "
    const rename =
      "update public.agent_run s set server_helper_item = left(s.server_helper_item, 180) || '#merged-' || left(replace(s.id::text, '-', ''), 8) where s.workspace_id = p_source and s.server_helper_item is not null and exists (select 1 from public.agent_run d where d.workspace_id = p_dest and d.triggered_by = s.triggered_by and d.server_helper_item = s.server_helper_item); get diagnostics v_items_renamed = row_count; "
    expect(MERGE_FN).toContain(archive)
    expect(MERGE_FN).toContain(rename)
    // Both run before the documents move (the members step has already remapped created_by).
    expect(MERGE_FN.indexOf(rename)).toBeLessThan(MERGE_FN.indexOf('update public.document d set workspace_id = p_dest'))
    // The suffixed item still fits the shape: 180 + '#merged-' + 8 characters.
    expect(180 + '#merged-'.length + 8).toBeLessThanOrEqual(200)
    const strip = (t: string) =>
      t
        .replace(archive, '')
        .replace(rename, '')
        .replace(' v_now_archived int := 0; v_items_renamed int := 0;', '')
        .replace(", 'now_files_archived', v_now_archived, 'check_in_items_renamed', v_items_renamed", '')
    expect(strip(MERGE_FN)).toBe(mergeFnOf(flat(read('402_merge_workspaces.sql'))))
    // Nothing between 402 and this file redefines the step.
    const redefines = migrationsInOrder().filter((m) => /function public\._wsmerge_documents\(/i.test(m.sql)).map((m) => m.file)
    expect(redefines).toEqual(['402_merge_workspaces.sql', '443_now_follow_up.sql'])
  })

  it("start_chat_helper is 422's otherwise, line for line", () => {
    const strip = (t: string) =>
      t
        .replace(', p_server_helper_item text default null', '')
        .replace('v_check_in_daily integer := 3; ', '')
        .replace("('meeting_prep', 'home_turn', 'check_in')", "('meeting_prep', 'home_turn')")
        .replace(/if \(p_server_helper = 'check_in' and \(p_server_helper_item is null .*?invalid_brief'\); end if; /, '')
        // Its three caps, then its own end if.
        .replace(/if p_server_helper = 'check_in' then (?:.*?end if; ){4}/, '')
        .replace('server_helper, server_helper_item)', 'server_helper)')
        .replace('p_server_helper, p_server_helper_item)', 'p_server_helper)')
    expect(strip(FN)).toBe(fnOf(flat(read('422_chat_helper_on_chatgpt_plan.sql'))))
  })
})
