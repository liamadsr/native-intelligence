/**
 * The workspace merge (402, and 707 on today's schema) re-points rows from
 * hand-written lists, so a table added later is missed unless someone adds
 * it. This test reads the schema the way a database replayed from the repo
 * has it (supabase/baseline/schema.sql, then every migration after the cut)
 * and fails on what the merge does not know about:
 *
 *   1. Every column that references public.member(id). A member who is in
 *      both workspaces folds: the source's member row is deleted, so each
 *      such column must be re-pointed by one of the merge's steps (its newest
 *      definition names the table and the column in one statement), or be
 *      listed in MEMBER_REFS_ELSEWHERE with where it is handled. Without it
 *      the merge refuses (_wsmerge_assert_no_refs, P0008) on any workspace
 *      where a folded person has such a row.
 *   2. Every unique index or constraint, and every primary key, that
 *      includes workspace_id. The
 *      generic re-stamp moves every source row to the destination, so each
 *      one is either settled before it (folded, renamed, dropped: listed in
 *      UNIQUE_SETTLED with the step) or shown not to collide (UNIQUE_SAFE,
 *      with why). Without it the merge refuses (P0008) on two workspaces
 *      that both have a row with that key.
 *
 * A column that references auth.users needs nothing: a person's user id is
 * the same in both workspaces. Where it is part of a key with workspace_id,
 * check 2 covers it.
 *
 * Adding a table: handle it in the merge (and the end-to-end,
 * scripts/merge-workspaces/e2e_body.sql), then list it here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const BASE = join(process.cwd(), 'supabase/baseline')
const CUT = Number(
  readFileSync(join(BASE, 'CUT'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#')),
)

/** The schema text in replay order: the baseline dump, then each migration after the cut. */
const SOURCES: Array<{ file: string; sql: string }> = [
  { file: 'baseline/schema.sql', sql: readFileSync(join(BASE, 'schema.sql'), 'utf8') },
  ...migrationsInOrder().filter((m) => m.num > CUT),
]

/** Lower-case, quotes and comments gone, whitespace collapsed. */
function norm(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** The body of a parenthesised list starting at `open` (the index of its '('). */
function balanced(s: string, open: number): string {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth === 0) return s.slice(open + 1, i)
    }
  }
  return s.slice(open + 1)
}

/** Split a create-table body on its top-level commas. */
function topLevel(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')') depth--
    else if (body[i] === ',' && depth === 0) {
      out.push(body.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(body.slice(start).trim())
  return out
}

const TABLE = String.raw`(?:only )?(?:public\.)?([a-z_][a-z0-9_]*)`

interface Schema {
  columns: Map<string, Set<string>> // table -> columns
  memberRefs: Set<string> // "table.column"
  uniques: Map<string, { table: string; def: string }> // index or constraint name -> its table and key
}

function readSchema(): Schema {
  const columns = new Map<string, Set<string>>()
  const memberRefs = new Set<string>()
  const uniques = new Map<string, { table: string; def: string }>()
  const col = (t: string) => columns.get(t) ?? columns.set(t, new Set()).get(t)!
  const refsMember = (s: string) => /references (?:public\.)?member ?\( ?id ?\)/.test(s) || /references (?:public\.)?member\b(?! ?\()/.test(s)

  for (const { sql } of SOURCES) {
    const s = norm(sql)
    for (const stmt of s.split(';')) {
      const st = stmt.trim()
      let m: RegExpMatchArray | null
      if ((m = st.match(new RegExp(`^create table (?:if not exists )?${TABLE} ?\\(`)))) {
        const table = m[1]
        for (const part of topLevel(balanced(st, st.indexOf('(')))) {
          const pk = part.match(/^(?:constraint ([a-z0-9_]+) )?primary key \(([^)]*)\)/)
          if (pk) {
            if (/\bworkspace_id\b/.test(pk[2])) uniques.set(pk[1] ?? `${table}_pkey`, { table, def: pk[2] })
            continue
          }
          const u = part.match(/^(?:constraint ([a-z0-9_]+) )?unique (?:nulls not distinct )?\(([^)]*)\)/)
          if (u) {
            if (/\bworkspace_id\b/.test(u[2])) uniques.set(u[1] ?? `${table}(${u[2]})`, { table, def: u[2] })
            continue
          }
          const fk = part.match(/^(?:constraint [a-z0-9_]+ )?foreign key \(([a-z0-9_]+)\) references (?:public\.)?member ?\( ?id ?\)/)
          if (fk) {
            memberRefs.add(`${table}.${fk[1]}`)
            continue
          }
          if (/^(constraint|check|exclude)\b/.test(part)) continue
          const c = part.match(/^([a-z_][a-z0-9_]*) /)
          if (!c) continue
          col(table).add(c[1])
          if (refsMember(part)) memberRefs.add(`${table}.${c[1]}`)
          if (/\bunique\b/.test(part) && c[1] === 'workspace_id') uniques.set(`${table}(workspace_id)`, { table, def: 'workspace_id' })
          if (/\bprimary key\b/.test(part) && c[1] === 'workspace_id') uniques.set(`${table}_pkey`, { table, def: 'workspace_id' })
        }
        continue
      }
      if ((m = st.match(new RegExp(`^alter table (?:if exists )?${TABLE} (.*)$`)))) {
        const table = m[1]
        const rest = m[2]
        for (const a of rest.matchAll(/add column (?:if not exists )?([a-z_][a-z0-9_]*) ([^,]*(?:\([^)]*\)[^,]*)*)/g)) {
          col(table).add(a[1])
          if (refsMember(a[2])) memberRefs.add(`${table}.${a[1]}`)
        }
        for (const a of rest.matchAll(/drop column (?:if exists )?([a-z_][a-z0-9_]*)/g)) {
          columns.get(table)?.delete(a[1])
          memberRefs.delete(`${table}.${a[1]}`)
        }
        for (const a of rest.matchAll(/add constraint ([a-z0-9_]+) foreign key \(([a-z0-9_]+)\) references (?:public\.)?member ?\( ?id ?\)/g)) {
          memberRefs.add(`${table}.${a[2]}`)
        }
        for (const a of rest.matchAll(/add constraint ([a-z0-9_]+) (?:unique (?:nulls not distinct )?|primary key )\(([^)]*)\)/g)) {
          if (/\bworkspace_id\b/.test(a[2])) uniques.set(a[1], { table, def: a[2] })
        }
        for (const a of rest.matchAll(/drop constraint (?:if exists )?([a-z0-9_]+)/g)) uniques.delete(a[1])
        continue
      }
      if ((m = st.match(new RegExp(`^create unique index (?:concurrently )?(?:if not exists )?([a-z0-9_]+) on ${TABLE}(?: using [a-z]+)? ?\\(`)))) {
        const key = balanced(st, st.indexOf('(', st.indexOf(' on ')))
        if (/\bworkspace_id\b/.test(key)) uniques.set(m[1], { table: m[2], def: key })
        else uniques.delete(m[1])
        continue
      }
      if ((m = st.match(/^drop index (?:concurrently )?(?:if exists )?(?:public\.)?([a-z0-9_]+)/))) {
        uniques.delete(m[1])
        continue
      }
      if ((m = st.match(new RegExp(`^drop table (?:if exists )?${TABLE}`)))) {
        const table = m[1]
        columns.delete(table)
        for (const r of [...memberRefs]) if (r.startsWith(`${table}.`)) memberRefs.delete(r)
        for (const [k, v] of [...uniques]) if (v.table === table) uniques.delete(k)
      }
    }
  }
  return { columns, memberRefs, uniques }
}

const SCHEMA = readSchema()

/**
 * A function's newest definition in replay order, whatever the case of its
 * CREATE (src/test/migration-sql.ts's latestDefinition matches upper case
 * only, and a lower-case restatement must not hide from this test).
 */
const NORMALISED = SOURCES.map((s) => norm(s.sql))
const BODIES = new Map<string, string>()

function newestBody(name: string): string {
  if (!BODIES.has(name)) BODIES.set(name, findNewestBody(name))
  return BODIES.get(name)!
}

function findNewestBody(name: string): string {
  const head = `create or replace function public.${name}(`
  for (let i = NORMALISED.length - 1; i >= 0; i--) {
    const s = NORMALISED[i]
    const start = s.lastIndexOf(head)
    if (start === -1) continue
    const tag = s.slice(start).match(/ as (\$[a-z_]*\$)/)
    if (!tag) return s.slice(start)
    const open = start + s.slice(start).indexOf(tag[1])
    const close = s.indexOf(tag[1], open + tag[1].length)
    return s.slice(start, close === -1 ? undefined : close)
  }
  return ''
}

/** Every merge step's newest definition, one statement per entry. */
const MERGE_STATEMENTS: string[] = (() => {
  const all = NORMALISED.join(';')
  const names = new Set([...all.matchAll(/create or replace function public\.(_wsmerge_[a-z0-9_]+|merge_workspace)\(/g)].map((m) => m[1]))
  return [...names].flatMap((n) => newestBody(n).split(';'))
})()

function mergeRepoints(table: string, column: string): boolean {
  const t = new RegExp(`public\\.${table}\\b`)
  const c = new RegExp(`\\b${column}\\b`)
  return MERGE_STATEMENTS.some((s) => t.test(s) && c.test(s))
}

/** Member columns handled other than by name in a merge step, and how. */
const MEMBER_REFS_ELSEWHERE: Record<string, string> = {
  'member.id': 'the member row itself',
}

/**
 * Keys with workspace_id that the merge settles before the generic re-stamp,
 * by the step that does it.
 */
const UNIQUE_SETTLED: Record<string, string> = {
  actions_identifier_workspace_idx: '_wsmerge_actions: identifiers re-prefixed or renumbered',
  agent_event_dedupe_idx: '_wsmerge_singletons drops the source duplicate',
  agent_log_dedupe_idx: '_wsmerge_singletons drops the source duplicate',
  agent_run_check_in_item_idx: '_wsmerge_agents_flows renames the check-in item',
  ai_team_member_workspace_system_key_uidx: '_wsmerge_system_teammates folds by system key',
  chat_conversations_home_uidx: '_wsmerge_chat demotes the source home thread',
  uidx_chat_conversations_home: '_wsmerge_chat demotes the source home thread',
  uidx_chat_conversations_slack_thread: '_wsmerge_chat',
  company_one_workspace_company_idx: '_wsmerge_companies demotes the source workspace company',
  company_workspace_id_domain_key: '_wsmerge_companies folds by domain',
  company_hubspot_id_key: '_wsmerge_integrations clears the provider id of a severed CRM',
  company_stage_name_key: '_wsmerge_companies folds stages by name (707)',
  connected_account_workspace_account_id_workspace_id_key: '_wsmerge_mail dedupes the account link',
  contact_workspace_id_email_key: '_wsmerge_contacts folds by email',
  contact_hubspot_id_key: '_wsmerge_integrations clears the provider id of a severed CRM',
  custom_field_definition_key: '_wsmerge_custom_fields_begin and _wsmerge_deals (528)',
  data_table_one_default_pipeline: '_wsmerge_deals folds pipelines',
  document_workspace_canon_key_shared_idx: '_wsmerge_documents demotes the source canon',
  document_workspace_slug_idx: '_wsmerge_documents re-slugs',
  document_now_one_per_member_idx: '_wsmerge_documents archives the source now file',
  document_workspace_canon_key_personal_idx: '_wsmerge_documents',
  email_auto_archive_day_key: '_wsmerge_one_per_owner joins the day (707)',
  email_thread_index_account_thread_key: '_wsmerge_mail folds thread copies',
  email_thread_team_private_key: '_wsmerge_one_per_owner drops the duplicate (707)',
  entity_link_workspace_id_source_type_source_id_target_type__key: '_wsmerge_repoint_entity dedupes edges',
  environment_default_one: '_wsmerge_environments drops the source duplicate',
  eval_candidate_dedupe_idx: '_wsmerge_singletons drops the source duplicate',
  idx_flow_workspace_seed_key: '_wsmerge_agents_flows folds seeded flows',
  knowledge_brief_workspace_id_scope_type_scope_id_key: '_wsmerge_knowledge drops the source brief',
  knowledge_package_workspace_id_slug_key: '_wsmerge_knowledge re-slugs',
  label_workspace_name_shared: '_wsmerge_labels folds shared labels by name (700)',
  label_workspace_owner_name: '_wsmerge_labels folds personal labels by owner and name (700)',
  snippet_shared_shortcut_key: '_wsmerge_one_per_owner folds the same text, else suffixes the shortcut (707)',
  snippet_personal_shortcut_key: '_wsmerge_one_per_owner folds the same text, else suffixes the shortcut (707)',
  workspace_github_repo_unique: 'workspace_github_repo_merge_fold (694): during a merge the destination duplicate gives way',
  inbox_hold_pkey: '_wsmerge_one_per_owner joins the hold, the later end (707)',
  drive_file_open_pkey: '_wsmerge_one_per_owner keeps one open, the later (707)',
  crm_source_link_pkey: '_wsmerge_one_per_owner keeps the destination link (707)',
  business_profile_pkey: '_wsmerge_front_door_check refuses two (707)',
  stripe_connect_account_pkey: '_wsmerge_front_door_check refuses two live; _wsmerge_one_per_owner drops a turned-off source one (707)',
  studio_blob_pkey: '_wsmerge_front_door_check refuses any source Studio media (707)',
  studio_asset_pkey: '_wsmerge_front_door_check refuses any source Studio media (707)',
  studio_record_pkey: '_wsmerge_front_door_check refuses the same record in both (707)',
  workspace_join_settings_pkey: '_wsmerge_generic_restamp deletes the source rows first (645)',
  workspace_join_domain_pkey: '_wsmerge_generic_restamp deletes the source rows first (645)',
  workspace_join_link_pkey: '_wsmerge_generic_restamp deletes the source rows first (645)',
  mail_review_activity_pkey: '_wsmerge_mail drops the source duplicate',
  area_memory_learning_run_pkey: '_wsmerge_singletons drops the source runs',
  anchor_embedding_pkey: '_wsmerge_knowledge dedupes anchor embeddings',
  demo_workspace_pkey: '_wsmerge_front_door_check refuses a demo workspace on either side (707)',
  meeting_goal_meeting_key: '_wsmerge_singletons drops the source duplicate',
  member_user_id_workspace_id_key: '_wsmerge_members folds a person in both',
  outreach_suppression_workspace_email_idx: '_wsmerge_singletons dedupes suppressions',
  uidx_suppression_workspace_email: '_wsmerge_singletons dedupes suppressions',
  prospect_list_workspace_name_idx: '_wsmerge_singletons renames',
  recipe_workspace_slug_idx: '_wsmerge_agents_flows re-slugs',
  recipe_slug_namespace_idx: '_wsmerge_agents_flows re-slugs',
  sequence_enrollment_one_active_per_contact: '_wsmerge_singletons ends the source enrollment',
  uidx_enrollment_one_active_per_contact: '_wsmerge_singletons ends the source enrollment',
  uidx_enrollment_one_active_per_email: '_wsmerge_singletons ends the source enrollment',
  team_workspace_id_issue_prefix_key: '_wsmerge_teams_begin re-prefixes or folds',
  team_workspace_id_slug_key: '_wsmerge_teams_begin renames or folds',
  team_chat_channel_name_key: '_wsmerge_team_chat suffixes the source channel (707)',
  team_chat_channel_dm_key: '_wsmerge_team_chat re-keys or folds the direct message (707)',
  view_workspace_id_slug_key: '_wsmerge_views re-slugs',
  vocabulary_term_key: '_wsmerge_one_per_owner drops the duplicate word (707)',
  voice_contact_trust_workspace_id_contact_id_key: '_wsmerge_contacts drops the source trust',
  booking_profile_person_key: '_wsmerge_one_per_owner folds the profile (707)',
  booking_profile_workspace_key: '_wsmerge_one_per_owner folds the profile (707)',
  booking_link_job_key: '_wsmerge_front_door_check refuses two live ones; _wsmerge_one_per_owner drops a turned-off source one (707)',
  business_phone_number_live_workspace_key: '_wsmerge_front_door_check refuses (707)',
  website_site_live_key: '_wsmerge_front_door_check refuses (707)',
  quote_intake_key_live_key: '_wsmerge_front_door_check refuses (707)',
  agent_guest_customer_phone_key: '_wsmerge_front_door_check refuses (707)',
  customer_booking_live_slot_key: '_wsmerge_front_door_check refuses (707)',
  customer_quote_external_key: '_wsmerge_front_door_check refuses (707)',
}

/** Keys with workspace_id that cannot collide in a merge, and why. */
const UNIQUE_SAFE: Record<string, string> = {
  captures_live_event_per_user: 'live captures make the source busy (P0007)',
  uidx_captures_live_event_per_user: 'live captures make the source busy (P0007)',
  entity_access_unique: 'a grant names a record of its own workspace, and the grantee ids are re-pointed with dedupe',
  customer_reminder_subject_key: 'its subject is a record of the source, an id the destination cannot hold',
  review_request_workspace_id_contact_id_job_type_job_id_key: 'its job is a record of the source, an id the destination cannot hold',
  cloud_browser_pkey: 'never re-stamped (421): the generic re-stamp skips cloud_browser',
}

describe('the workspace merge knows every table it moves', () => {
  it('reads the schema (a sanity check on the parser)', () => {
    expect(SCHEMA.memberRefs.size).toBeGreaterThan(50)
    expect(SCHEMA.memberRefs.has('actions.assignee_id')).toBe(true)
    expect(SCHEMA.memberRefs.has('team_chat_message.author_member_id')).toBe(true)
    expect(SCHEMA.uniques.has('company_stage_name_key')).toBe(true)
    expect(SCHEMA.uniques.has('label_workspace_name_shared')).toBe(true)
    expect(SCHEMA.uniques.has('inbox_hold_pkey')).toBe(true)
  })

  it('re-points every column that references a member', () => {
    const missed = [...SCHEMA.memberRefs]
      .filter((r) => !MEMBER_REFS_ELSEWHERE[r])
      .filter((r) => {
        const [table, column] = r.split('.')
        return !mergeRepoints(table, column)
      })
      .sort()
    expect(missed, 'member columns no merge step re-points: add them to _wsmerge_members').toEqual([])
  })

  it('settles or rules out every unique key with workspace_id', () => {
    const unknown = [...SCHEMA.uniques.entries()]
      .filter(([name]) => !UNIQUE_SETTLED[name] && !UNIQUE_SAFE[name])
      .map(([name, u]) => `${name} on ${u.table} (${u.def})`)
      .sort()
    expect(unknown, 'unique keys the merge does not settle: fold, rename or refuse them, then list them here').toEqual([])
  })

  it('names, for each settled key, a step that touches its table', () => {
    const wrong = Object.entries(UNIQUE_SETTLED)
      .filter(([name]) => SCHEMA.uniques.has(name))
      .filter(([name, how]) => {
        const table = SCHEMA.uniques.get(name)!.table
        // the steps named: merge functions, or another function the reason names (a table's own merge trigger)
        const steps = [...how.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b_wsmerge_[a-z0-9_]+\b/g)].map((m) => m[0]).filter((s) => newestBody(s) !== '')
        return !steps.some((s) => new RegExp(`public\\.${table}\\b`).test(newestBody(s)))
      })
      .map(([name, how]) => `${name}: ${how}`)
    expect(wrong).toEqual([])
    // and every entry names at least one function that exists
    const unnamed = Object.entries(UNIQUE_SETTLED).filter(([, how]) => ![...how.matchAll(/\b[a-z_][a-z0-9_]*\b/g)].some((m) => m[0].includes('_') && newestBody(m[0]) !== ''))
    expect(unnamed.map(([k]) => k)).toEqual([])
  })

  it('lists no key or column that no longer exists', () => {
    const gone = [...Object.keys(UNIQUE_SETTLED), ...Object.keys(UNIQUE_SAFE)].filter((k) => !SCHEMA.uniques.has(k))
    // A few names are listed under both of their spellings (index and constraint); one of each pair exists.
    const pairs = [
      ['chat_conversations_home_uidx', 'uidx_chat_conversations_home'],
      ['outreach_suppression_workspace_email_idx', 'uidx_suppression_workspace_email'],
      ['sequence_enrollment_one_active_per_contact', 'uidx_enrollment_one_active_per_contact'],
      ['captures_live_event_per_user', 'uidx_captures_live_event_per_user'],
    ]
    const stale = gone.filter((k) => !pairs.some((p) => p.includes(k) && p.some((x) => SCHEMA.uniques.has(x))))
    expect(stale).toEqual([])
  })
})
