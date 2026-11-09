/**
 * Migration 403 (the cross-workspace drift repair that lets a workspace pass
 * the merge preflight) and its rules agree. Dry-run (rolled back) on DEV and
 * PROD with `remaining: []`, then applied to DEV. This pins the file so a
 * later edit can't widen a predicate or drop the log silently.
 */
import { describe, it, expect } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'

const MIGRATIONS = migrationsInOrder()
const FILE = MIGRATIONS.find((m) => m.file === '403_repair_cross_workspace_drift.sql')!
const BODY = FILE.sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

function newest(fn: string): { file: string; body: string } {
  const needle = new RegExp(`create or replace function public\\.${fn}\\(`, 'i')
  for (let i = MIGRATIONS.length - 1; i >= 0; i--) {
    const { file, sql } = MIGRATIONS[i]
    if (needle.test(sql)) return { file, body: sql.replace(/\s+/g, ' ') }
  }
  throw new Error(`no migration defines ${fn}`)
}

describe('migration 403: the drift repair', () => {
  it('is a function the server may run again, scoped to one workspace or all', () => {
    // 473 (deals) redefines it, unchanged but for the legacy deal guard.
    expect(['403_repair_cross_workspace_drift.sql', '473_deals_pipelines_custom_fields.sql']).toContain(newest('repair_cross_workspace_drift').file)
    expect(BODY).toContain('CREATE OR REPLACE FUNCTION public.repair_cross_workspace_drift(p_workspace uuid DEFAULT NULL)')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public.repair_cross_workspace_drift(uuid) FROM PUBLIC, anon, authenticated')
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.repair_cross_workspace_drift(uuid) TO service_role')
    // the migration runs it once for every workspace
    expect(BODY).toContain('SELECT public.repair_cross_workspace_drift(NULL) AS repair')
  })

  it('logs every changed row and reports what the sweep still flags', () => {
    expect(BODY).toContain('CREATE TABLE IF NOT EXISTS public.workspace_repair_log')
    expect(BODY).toContain('ALTER TABLE public.workspace_repair_log ENABLE ROW LEVEL SECURITY')
    // every write is a CTE whose rows land in the log
    const writes = (BODY.match(/\b(UPDATE|DELETE FROM) public\.(?!workspace_repair_log)/g) ?? []).length
    const logs = (BODY.match(/INSERT INTO public\.workspace_repair_log/g) ?? []).length
    // the four "sibling copy takes the link" / "same-named label" re-points are preparatory
    // updates whose outcome is logged by the clearing statement that follows them
    expect(logs).toBeGreaterThanOrEqual(writes - 6)
    expect(BODY).toContain("'remaining', v_remaining")
    expect(BODY).toContain('CROSS JOIN LATERAL public.workspace_integrity_sweep(w.id) s')
  })

  it('translates member references by user before clearing or dropping, in the row’s own workspace', () => {
    expect(BODY).toContain('AND x.workspace_id = t.workspace_id AND x.user_id = m.user_id')
    expect(BODY).toContain("('notification', 'recipient_id', 'delete')")
    expect(BODY).toContain("('actions', 'assignee_id', 'null')")
    // the translate statement precedes the clear/drop statement
    expect(BODY.indexOf("'member_ref.translated'")).toBeLessThan(BODY.indexOf("'member_ref.cleared'"))
  })

  it('keeps the engine’s rules: children follow parents, crossing pointers are cut, shares deactivate, mail links move to the sibling copy', () => {
    expect(BODY).toContain("('claim_source', 'claim_id', 'claim')")
    expect(BODY).toContain("('extraction_pass', 'capture_id', 'captures')")
    expect(BODY).toContain('UPDATE public.actions a SET team_id = sub.new_team')
    expect(BODY).toContain('public._wsrepair_first_team(a2.workspace_id) AS new_team')
    expect(BODY).toContain("UPDATE public.share s SET is_active = false")
    expect(BODY).not.toMatch(/DELETE FROM public\.share\b/)
    // the sibling copy is given the contact link (and that is logged) before the copy's own link is re-pointed or cleared
    const sibling = BODY.indexOf('UPDATE public.email_thread_index s SET linked_contact_id = e.linked_contact_id')
    const clear = BODY.indexOf("'mail_link.relinked_by_email'")
    expect(sibling).toBeGreaterThan(0)
    expect(clear).toBeGreaterThan(sibling)
    expect(BODY).toContain("'mail_link.sibling_took_link'")
    // shares and invites are never dropped for a foreign author: the owner takes them
    expect(BODY).toContain("('share', 'created_by', 'owner')")
    expect(BODY).toContain("('invite', 'invited_by', 'owner')")
    // children follow parents BEFORE member references are translated, so a re-stamped row is translated into its final workspace
    expect(BODY.indexOf("'child_follows_parent'")).toBeLessThan(BODY.indexOf("'member_ref.translated'"))
    // one attachment rule, the sweep's order
    expect(BODY).toContain('COALESCE(c.workspace_id, a.workspace_id, p.workspace_id) AS home')
  })

  it('never deletes a workspace, a member, a team, an action, a capture, a document or a contact', () => {
    for (const t of ['workspace', 'member', 'team', 'actions', 'captures', 'document', 'contact', 'projects', 'claim']) {
      expect(BODY, t).not.toMatch(new RegExp(`DELETE FROM public\\.${t}\\b`))
    }
  })

  it('reaches the deal tables only where they exist', () => {
    expect(BODY).toContain("IF to_regclass('public.deal') IS NOT NULL THEN")
    const guardAt = BODY.indexOf("IF to_regclass('public.deal') IS NOT NULL THEN")
    expect(BODY.indexOf('public.deal d SET team_id')).toBeGreaterThan(guardAt)
  })
})
