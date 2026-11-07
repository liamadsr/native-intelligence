/**
 * Migration 342 purges the knowledge Dial8 learned from mail (the owner's
 * go-ahead, 2026-10-15). It can't be run here, so the file is pinned as text:
 * what it deletes, in an order the foreign keys allow, inside one DO block,
 * never touching the stored mail itself, with no backslash anywhere.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const sql = readFileSync(path.join(process.cwd(), 'supabase/migrations/342_purge_mail_knowledge.sql'), 'utf8')
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')

/** Position of a statement in the executable SQL; fails when it's missing. */
const at = (needle: string) => {
  const i = code.indexOf(needle)
  expect(i, needle).toBeGreaterThan(-1)
  return i
}

describe('migration 342: purge the knowledge learned from mail', () => {
  it('says it is irreversible and holds no backslash', () => {
    expect(sql).toContain('IRREVERSIBLE')
    expect(sql).toContain('CANNOT BE UNDONE')
    expect(sql.includes(String.fromCharCode(92))).toBe(false)
  })

  it('runs the purge as one DO block, so it all happens or none of it does', () => {
    expect(code.match(/DO \$purge\$/g)).toHaveLength(1)
    expect(code.trim().endsWith('$purge$;')).toBe(true)
  })

  it('collects the mail claims before deleting their mail sources, then deletes in foreign-key order', () => {
    const collect = at("INTO v_mail_claims\n    FROM public.claim_source cs\n   WHERE cs.source_type = 'email';")
    const sources = at("DELETE FROM public.claim_source WHERE source_type = 'email';")
    const orphans = at('AND NOT EXISTS (SELECT 1 FROM public.claim_source cs WHERE cs.claim_id = cl.id);')
    const pins = at("DELETE FROM public.knowledge_package_item\n   WHERE entity_type = 'claim' AND entity_id = ANY (v_orphans);")
    const links = at("DELETE FROM public.entity_link\n   WHERE (source_type = 'claim' AND source_id = ANY (v_orphans))")
    const chunks = at('DELETE FROM public.claim_chunks WHERE claim_id = ANY (v_orphans);')
    const claims = at('DELETE FROM public.claim WHERE id = ANY (v_orphans);')
    const emailLinks = at("DELETE FROM public.entity_link\n   WHERE source_type = 'email' OR target_type = 'email';")
    const briefs = at('DELETE FROM public.knowledge_brief WHERE workspace_id = ANY (v_workspaces);')
    expect([collect, sources, orphans, pins, links, chunks, claims, emailLinks, briefs]).toEqual(
      [collect, sources, orphans, pins, links, chunks, claims, emailLinks, briefs].slice().sort((a, b) => a - b),
    )
  })

  it('deletes only claims that had mail and have no source left', () => {
    expect(code).toContain('WHERE cl.id = ANY (v_mail_claims)\n     AND NOT EXISTS')
    // The only claim delete is the orphan one.
    expect(code.match(/DELETE FROM public\.claim\b(?!_)/g)).toHaveLength(1)
  })

  it("deletes the Mail tone pass's lines only (its runs recorded their texts), before the runs", () => {
    const lines = at('DELETE FROM public.area_memory am')
    const runs = at("DELETE FROM public.area_memory_learning_run WHERE area = 'mail';")
    expect(lines).toBeLessThan(runs)
    const stmt = code.slice(lines, code.indexOf(';', lines))
    for (const cond of [
      "am.area = 'mail'",
      "am.scope = 'personal'",
      "am.source = 'learned'",
      'am.created_by IS NULL',
      'run.workspace_id = am.workspace_id',
      'run.user_id = am.user_id',
      "run.area = 'mail'",
      'am.text = ANY (run.proposed)',
    ]) {
      expect(stmt, cond).toContain(cond)
    }
    // The chat capture pass's learned mail lines (no run lists them) stay: no
    // other area_memory delete.
    expect(code.match(/DELETE FROM public\.area_memory\b(?!_)/g)).toHaveLength(1)
    at('DELETE FROM public.memory_learning_setting;')
  })

  it('deletes package pins on emails beside the email links', () => {
    const links = at("DELETE FROM public.entity_link\n   WHERE source_type = 'email' OR target_type = 'email';")
    const pins = at("DELETE FROM public.knowledge_package_item WHERE entity_type = 'email';")
    expect(pins).toBeGreaterThan(links)
  })

  it("hardens 341's private schema, only when it exists: no PUBLIC execute, exactly the two functions for authenticated", () => {
    const harden = at('DO $harden$')
    expect(harden).toBeLessThan(at('DO $purge$'))
    at("IF to_regnamespace('private') IS NULL THEN")
    at('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC, anon;')
    at('ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;')
    at('GRANT EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() TO authenticated, service_role;')
    at('GRANT EXECUTE ON FUNCTION private.claims_hidden_from_me() TO authenticated, service_role;')
    expect(code).not.toMatch(/GRANT EXECUTE ON ALL FUNCTIONS/)
  })

  it('never touches the stored mail (a later migration purges it)', () => {
    for (const table of ['email_message', 'email_thread_index', 'email_draft', 'email_thread']) {
      expect(code, table).not.toMatch(new RegExp(`public\\.${table}\\b`))
    }
    expect(code).not.toMatch(/\b(TRUNCATE|DROP\s+TABLE)\b/i)
  })

  it('ships its pre-check and post-check queries', () => {
    expect(sql).toContain('-- PRE-CHECK')
    expect(sql).toContain('-- POST-CHECK')
    expect(sql).toContain('AS mail_sources_left')
    expect(sql).toContain('AS claims_to_delete')
    expect(sql).toContain('AS chat_learned_mail_lines_kept')
    expect(sql).toContain('AS email_pins_left')
    expect(sql).toContain('AS claim_chunks_total')
    expect(sql).toContain("OR (el.target_type = 'claim'")
  })
})
