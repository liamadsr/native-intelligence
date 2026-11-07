/**
 * Migration 402 (merge workspaces, docs/plans/merge-workspaces.md) and the
 * rules it states agree. The SQL was verified on DEV: a rolled-back synthetic
 * end-to-end with every collision class, then a committed scratch merge
 * through PostgREST as service_role. This pins the file so a later edit can't
 * drop a rule silently: the three guard exemptions (and nothing else about
 * those guards), the setting that scopes them to one transaction, the
 * all-or-nothing assertions, the record with no foreign keys, and who may
 * call the entry points.
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '402_merge_workspaces.sql')!
const BODY = FILE.sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

/** The newest migration defining `public.<fn>`, and its body. */
function newest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    if (needle.test(sql)) return { file, body: sql.replace(/\s+/g, ' ') }
  }
  throw new Error(`no migration defines ${fn}`)
}

describe('migration 402: the merge', () => {
  it('is the newest word on the three guards it exempts, and each keeps its own refusal', () => {
    for (const fn of ['reminder_freeze_identity', 'ai_team_member_protect_system', 'flow_check_ai_team_member']) {
      const { file, body } = newest(fn)
      expect(file, fn).toBe('402_merge_workspaces.sql')
      expect(body, fn).toContain('_wsmerge_active()')
    }
    // 224: a reminder's identity is immutable (outside a merge).
    expect(newest('reminder_freeze_identity').body).toContain(
      "RAISE EXCEPTION 'reminder identity (workspace_id, user_id, entity_type, entity_id) is immutable'",
    )
    // 283: no deleting a system teammate while its workspace and team exist; is_system, system_key and the agent are fixed.
    const protect = newest('ai_team_member_protect_system').body
    expect(protect).toContain("raise exception 'system teammates cannot be deleted (ai_team_member %)'")
    expect(protect).toContain('old.is_system and not public._wsmerge_active() and exists (select 1 from public.workspace w where w.id = old.workspace_id)')
    expect(protect).toContain("is_system, system_key and a system teammate''s agent are fixed at insert")
    // 302/318: a loop's bot is one of its workspace's teammates; only Captures fronts loops; private teams are checked.
    const flow = newest('flow_check_ai_team_member').body
    expect(flow).toContain('if new.ai_team_member_id is null then return new; end if; if public._wsmerge_active() then return new; end if;')
    expect(flow).toContain("a loop''s bot must be one of its own workspace''s teammates")
    expect(flow).toContain("system_key not in ('captures')")
    expect(flow).toContain('tm.member_id = v_run_as')
  })

  it('scopes the exemption to the merge transaction', () => {
    expect(newest('_wsmerge_active').body).toContain("current_setting('dial8.workspace_merge', true)")
    expect(newest('merge_workspace').body).toContain("set_config('dial8.workspace_merge', v_id::text, true)")
    // Readable by every role: the reminder guard runs as the caller.
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public._wsmerge_active() TO PUBLIC')
  })

  it('keeps history: the record has no foreign keys and move history no longer cascades', () => {
    const table = /CREATE TABLE IF NOT EXISTS public\.workspace_merge \(([^;]*)\);/.exec(BODY)?.[1] ?? ''
    expect(table).toContain('source_workspace_id uuid NOT NULL')
    expect(table).toContain('destination_workspace_id uuid NOT NULL')
    expect(table).not.toMatch(/REFERENCES/i)
    expect(BODY).toContain('DROP CONSTRAINT IF EXISTS workspace_move_log_source_workspace_id_fkey')
    expect(BODY).toContain('DROP CONSTRAINT IF EXISTS workspace_move_log_destination_workspace_id_fkey')
  })

  it('belongs to the server: entry points for service_role, helpers for no client role', () => {
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.merge_workspace(uuid, uuid, uuid, jsonb) TO service_role')
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.merge_workspace_preflight(uuid, uuid, uuid, jsonb) TO service_role')
    expect(BODY).toContain("REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated")
    // Owner of both workspaces, the same person; no membership reads as not found.
    const gate = newest('_wsmerge_gate').body
    expect(gate).toContain("IF v_src_role <> 'owner' OR v_dst_role <> 'owner' THEN")
    expect(gate).toContain("RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'")
  })

  it('refuses a busy source and drift on either side, and asserts before the source row goes', () => {
    const merge = newest('merge_workspace').body
    expect(merge).toContain("USING ERRCODE = 'P0007'")
    expect(merge).toContain("the source workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009'")
    expect(merge).toContain("the destination workspace fails the integrity sweep: %', v_drift USING ERRCODE = 'P0009'")
    // Assertions come after every step and before the delete.
    const assertAt = merge.indexOf('PERFORM public._wsmerge_assert(p_source, p_destination)')
    const deleteAt = merge.indexOf('DELETE FROM public.workspace WHERE id = p_source')
    const lastStepAt = merge.indexOf('_wsmerge_pointers(p_source, p_destination)')
    expect(assertAt).toBeGreaterThan(lastStepAt)
    expect(deleteAt).toBeGreaterThan(assertAt)
    // The assertion covers every table with a workspace_id column, by catalogue.
    const assertion = newest('_wsmerge_assert').body
    expect(assertion).toContain("c.column_name = 'workspace_id'")
    expect(assertion).toContain("'merge left rows under the source workspace: %'")
    expect(assertion).toContain('public.workspace_integrity_sweep(p_dest)')
  })

  it('keeps what the move engine severs: shares, PR links, agent runs and claims re-stamp whole', () => {
    // No step deactivates a share, deletes a PR link or an agent run, or partitions claims by evidence.
    expect(BODY).not.toMatch(/UPDATE public\.share[^;]*is_active = false/i)
    expect(BODY).not.toMatch(/DELETE FROM public\.action_github_pr/i)
    expect(BODY).not.toMatch(/DELETE FROM public\.agent_run\b/i)
    expect(newest('_wsmerge_knowledge').body).toContain('UPDATE public.claim SET workspace_id = p_dest WHERE workspace_id = p_source')
    // External task links are severed only for a provider both sides have, URL kept (221's shape).
    const integrations = newest('_wsmerge_integrations').body
    expect(integrations).toContain("USING pg_temp._wsmerge_shared_providers sp WHERE sp.kind = 'tasks'")
    expect(integrations).toContain("jsonb_build_object('url', external_url, 'title', COALESCE(external_title, initcap(provider) || ' task'))")
  })

  it('folds a contact through merge_contacts, so unmerge still works', () => {
    const contacts = newest('_wsmerge_contacts').body
    expect(contacts).toContain("PERFORM public.merge_contacts(r.dst, r.src, 'workspace_merge', NULL")
    expect(contacts).toContain('email = NULL WHERE id = r.src')
  })

  it('exports without vectors or credential material', () => {
    const rows = newest('export_workspace_rows').body
    expect(rows).toContain("c.udt_name NOT IN ('vector', 'halfvec', 'tsvector')")
    expect(rows).toContain("c.table_name = 'cloud_environment' AND c.column_name = 'env_vars'")
    expect(rows).toContain("c.column_name IN ('access_token_encrypted', 'refresh_token_encrypted')")
    expect(rows).toContain("c.table_name = 'task_sync_state' AND c.column_name = 'webhook_secret'")
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.export_workspace_rows(uuid, text, int, int) TO service_role')
  })
})
