/**
 * Migration 408 (merge workspaces: the engine review's fixes) replaces nine of
 * 402's step functions with the fix inserted and adds the guard. Verified on
 * DEV by scripts/merge-workspaces/e2e_body.sql (rolled back; against 402 alone
 * it fails on both rules), then applied to DEV and run again. This pins the
 * two rules, the guard and where each step calls it, that the guard is no
 * client's to call, and that nothing else about 402's steps moved.
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '408_merge_workspaces_review_fixes.sql')!
const FILE_402 = MIGRATIONS.find((m) => m.file === '402_merge_workspaces.sql')!

/** A migration's SQL without comment lines, whitespace collapsed. */
function flat(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
}
const BODY = flat(FILE.sql)

/** The newest migration defining `public.<fn>`, and its body. */
function newest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    if (needle.test(sql)) return { file, body: sql.replace(/\s+/g, ' ') }
  }
  throw new Error(`no migration defines ${fn}`)
}

/** One function's definition out of a flattened migration. */
function definition(flatSql: string, fn: string): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(.*?\\$\\$;`).exec(flatSql)
  if (!m) throw new Error(`${fn} not defined`)
  return m[0]
}

/** Each replaced step, its guard call and the delete the guard stands before. */
const GUARDED: Array<[string, string, string]> = [
  ['_wsmerge_members', "PERFORM public._wsmerge_assert_no_refs('member', (SELECT array_agg(src) FROM pg_temp._wsmerge_members), '{}')", 'DELETE FROM public.member m USING pg_temp._wsmerge_members x WHERE m.id = x.src'],
  ['_wsmerge_labels', "PERFORM public._wsmerge_assert_no_refs('label', (SELECT array_agg(src) FROM pg_temp._wsmerge_labels), '{}')", 'DELETE FROM public.label l USING pg_temp._wsmerge_labels m WHERE l.id = m.src'],
  ['_wsmerge_teams_finish', "PERFORM public._wsmerge_assert_no_refs('team', ARRAY[tm.src], ARRAY['workflow_state'])", 'DELETE FROM public.team WHERE id = tm.src'],
  ['_wsmerge_system_teammates', "PERFORM public._wsmerge_assert_no_refs('ai_team_member', (SELECT array_agg(src) FROM pg_temp._wsmerge_teammates), '{}')", 'DELETE FROM public.ai_team_member a USING pg_temp._wsmerge_teammates t WHERE a.id = t.src'],
  ['_wsmerge_companies', "PERFORM public._wsmerge_assert_no_refs('company', ARRAY[r.src], '{}')", 'DELETE FROM public.company WHERE id = r.src'],
  ['_wsmerge_agents_flows', "PERFORM public._wsmerge_assert_no_refs('flow', (SELECT array_agg(src) FROM pg_temp._wsmerge_flows), '{}')", 'DELETE FROM public.flow f USING pg_temp._wsmerge_flows m WHERE f.id = m.src'],
  ['_wsmerge_default_projects', "PERFORM public._wsmerge_assert_no_refs('projects', ARRAY[r.src], '{}')", 'DELETE FROM public.projects WHERE id = r.src'],
  ['_wsmerge_mail', "PERFORM public._wsmerge_assert_no_refs('email_thread_index', (SELECT array_agg(sid) FROM pg_temp._wsmerge_threads), ARRAY['email_thread_label'])", 'DELETE FROM public.email_thread_index s USING pg_temp._wsmerge_threads t WHERE s.id = t.sid'],
]
const REPLACED = [...GUARDED.map(([fn]) => fn), '_wsmerge_contacts']

describe('migration 408: the engine review’s fixes', () => {
  it('exists once, and is the newest word on the guard and every step it replaces', () => {
    expect(FILE).toBeDefined()
    expect(MIGRATIONS.filter((m) => m.num === 408)).toHaveLength(1)
    expect(FILE.sql).not.toMatch(/DRAFT/)
    for (const fn of ['_wsmerge_assert_no_refs', ...REPLACED]) {
      expect(newest(fn).file, fn).toBe('408_merge_workspaces_review_fixes.sql')
    }
  })

  it('moves nothing else: every statement of 402’s steps is still there, bar the label scopes it fixes', () => {
    const before = flat(FILE_402.sql)
    for (const fn of REPLACED) {
      const now = definition(BODY, fn)
      const statements = definition(before, fn)
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !s.includes('SET scopes'))
      for (const s of statements) expect(now, `${fn}: ${s.slice(0, 80)}`).toContain(s)
    }
  })

  it('the guard walks every single-column foreign key onto the table and refuses with P0008, naming the column', () => {
    const guard = newest('_wsmerge_assert_no_refs').body
    expect(guard).toContain('_wsmerge_assert_no_refs(p_table text, p_ids uuid[], p_except text[] DEFAULT \'{}\')')
    expect(guard).toContain('IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RETURN; END IF;')
    expect(guard).toContain("WHERE c.contype = 'f' AND c.confrelid = ('public.' || quote_ident(p_table))::regclass AND array_length(c.conkey, 1) = 1")
    expect(guard).toContain('AND NOT (cl.relname = ANY (p_except))')
    // identifiers quoted, the ids bound: nothing from a row reaches the SQL text
    expect(guard).toContain("EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = ANY($1)', r.child, r.col) INTO n USING p_ids;")
    expect(guard).toContain("v_hits := concat_ws(', ', v_hits, r.child || '.' || r.col || '=' || n);")
    expect(guard).toContain("RAISE EXCEPTION 'rows still reference % rows the merge is about to delete: %', p_table, v_hits USING ERRCODE = 'P0008';")
    // like 402's helpers, no client role may call it
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public._wsmerge_assert_no_refs(text, uuid[], text[]) FROM PUBLIC, anon, authenticated;')
  })

  it('every step that deletes source rows asks the guard first, excepting only the children it deletes on purpose', () => {
    for (const [fn, call, del] of GUARDED) {
      const body = definition(BODY, fn)
      const callAt = body.indexOf(call)
      const deleteAt = body.indexOf(del)
      expect(callAt, fn).toBeGreaterThan(-1)
      expect(deleteAt, fn).toBeGreaterThan(callAt)
      // nothing is translated between the guard and the delete it guards
      expect(body.slice(callAt + call.length, deleteAt).trim(), fn).toBe(';')
    }
    // the only exceptions: a folded team's own states, a folded thread copy's labels (unioned above it)
    const exceptions = GUARDED.map(([, call]) => /ARRAY\['([a-z_]+)'\]\)$/.exec(call)?.[1]).filter(Boolean)
    expect(exceptions).toEqual(['workflow_state', 'email_thread_label'])
  })

  it('a folded contact keeps its sequence enrollments: they re-point before merge_contacts can end them', () => {
    const contacts = definition(BODY, '_wsmerge_contacts')
    const repointAt = contacts.indexOf('UPDATE public.sequence_enrollment SET contact_id = r.dst WHERE contact_id = r.src;')
    const emailNulledAt = contacts.indexOf('email = NULL WHERE id = r.src')
    const mergeAt = contacts.indexOf("PERFORM public.merge_contacts(r.dst, r.src, 'workspace_merge', NULL")
    expect(repointAt).toBeGreaterThan(-1)
    expect(mergeAt).toBeGreaterThan(emailNulledAt)
    expect(repointAt).toBeLessThan(mergeAt)
    // the contacts step ends none itself: a collision is ended and counted once, by the singletons step,
    // with the same rule the preflight's sequence_enrollments_exited counts
    expect(contacts).not.toContain("status = 'exited'")
    const singletons = newest('_wsmerge_singletons')
    expect(singletons.file).toBe('402_merge_workspaces.sql')
    expect(singletons.body).toContain(
      "UPDATE public.sequence_enrollment s SET status = 'exited', exit_reason = 'removed', next_send_at = NULL WHERE s.workspace_id = p_source AND s.status = 'active' AND EXISTS (SELECT 1 FROM public.sequence_enrollment d WHERE d.workspace_id = p_dest AND d.status = 'active' AND (d.contact_id = s.contact_id OR lower(d.contact_email) = lower(s.contact_email)));",
    )
    expect(singletons.body).toContain("jsonb_build_object('sequence_enrollments_exited', n)")
    expect(newest('merge_workspace').body).toMatch(/_wsmerge_contacts\(p_source, p_destination\).*_wsmerge_singletons\(p_source, p_destination\)/)
  })

  it('a universal label stays universal when it folds (NULL scopes = everywhere)', () => {
    const labels = definition(BODY, '_wsmerge_labels')
    expect(labels).toContain(
      'SET scopes = CASE WHEN d.scopes IS NULL OR s.scopes IS NULL THEN NULL ELSE (SELECT array_agg(DISTINCT e) FROM unnest(d.scopes || s.scopes) e) END,',
    )
  })

  it('a folded team’s projects follow it only where projects.team_id still exists (019 dropped it)', () => {
    const finish = definition(BODY, '_wsmerge_teams_finish')
    expect(finish).toContain(
      "IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'projects' AND column_name = 'team_id') THEN EXECUTE 'UPDATE public.projects SET team_id = $2 WHERE team_id = $1' USING tm.src, tm.dst; END IF;",
    )
  })
})
