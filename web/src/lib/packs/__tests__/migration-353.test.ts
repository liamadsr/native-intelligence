/**
 * Migration 353: learning on by default (Liam, 2026-10-17). Pins the file:
 * the mail-learning opt-in table goes; personal learned proposals go live
 * (workspace ones keep waiting); a chat-sourced claim is visible only to the
 * person whose conversation it is, in claim_visible_to, the RLS hidden set,
 * hybrid_search's provenance and claim_neighborhood; and it holds no
 * backslash, deletes no row, and is safe to run twice.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { latestDefinition } from '@/test/migration-sql'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/353_learn_by_default.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

describe('migration 353', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('drops the mail-learning opt-in, and deletes no rows', () => {
    expect(BODY).toContain('DROP TABLE IF EXISTS public.memory_learning_setting;')
    expect(BODY.match(/DROP TABLE/g)).toHaveLength(1)
    expect(BODY).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO)\b/i)
  })

  it('backfills only personal learned area lines; learned profile facts and workspace proposals keep waiting', () => {
    expect(BODY).toContain("UPDATE public.area_memory SET status = 'active' WHERE scope = 'personal' AND status = 'proposed' AND source = 'learned';")
    // A waiting learned fact may be the replacement of a live one it contradicts
    // (capture-pass keeps those as proposals): the person settles each.
    expect(BODY.match(/\bUPDATE public\.\w+/g)).toEqual(['UPDATE public.area_memory'])
  })

  it('is the latest definition of the functions it redefines (hybrid_search: or 365, which changes only its document branch)', () => {
    // 365 and 369 (documents phase 1, private documents) carry 353's bodies
    // forward, adding only document terms (their own migration tests pin that).
    for (const fn of ['claim_visible_to', 'claim_neighborhood', 'hybrid_search']) {
      expect(['353_learn_by_default.sql', '365_document_search_everywhere.sql', '369_document_visibility.sql'], fn).toContain(latestDefinition(fn).file)
    }
  })

  it('claim_visible_to: a chat source only for its owner, every earlier rule kept', () => {
    const [body] = latestDefinition('claim_visible_to').blocks
    const flat = body.replace(/\s+/g, ' ')
    expect(flat).toContain("WHEN 'conversation' THEN EXISTS ( SELECT 1 FROM public.chat_conversations cc WHERE cc.id = cs.source_id AND p_user_id IS NOT NULL AND cc.user_id = p_user_id )")
    expect(flat).toContain("AND cs.source_type = 'email'")
    expect(flat).toContain("WHEN 'email' THEN FALSE")
    expect(flat).toContain('NOT c.is_eval')
    expect(flat).toContain("WHEN 'attachment' THEN EXISTS")
    expect(flat).toContain('SECURITY DEFINER STABLE SET search_path = public, pg_temp')
    expect(BODY).toContain('REVOKE EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) FROM PUBLIC, anon;')
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION public.claim_visible_to(UUID, UUID) TO authenticated, service_role;')
  })

  it('the RLS hidden set adds other people\'s chat sources, caller-scoped, on an index', () => {
    const start = BODY.indexOf('CREATE OR REPLACE FUNCTION private.claim_sources_hidden_from_me()')
    const fn = BODY.slice(start, BODY.indexOf('REVOKE EXECUTE ON FUNCTION private.claim_sources_hidden_from_me()', start))
    expect(fn).toContain('WHERE m.user_id = auth.uid()')
    expect(fn).toContain("WHERE cs.source_type = 'conversation' AND NOT EXISTS ( SELECT 1 FROM public.chat_conversations cc WHERE cc.id = cs.source_id AND cc.user_id = auth.uid() )")
    // 341's branches travel whole.
    expect(fn).toContain("WHERE cs.source_type = 'email'")
    expect(fn).toContain("ON cs.source_type = 'capture' AND cs.source_id = hc.id")
    expect(fn).toContain("ON cs.source_type = 'attachment' AND cs.source_id = a.id")
    expect(fn).toContain('SECURITY DEFINER STABLE ROWS 50 SET search_path = public, pg_temp')
    expect(BODY).toContain("CREATE INDEX IF NOT EXISTS idx_claim_source_conversation ON public.claim_source (workspace_id, source_id) WHERE source_type = 'conversation';")
    expect(BODY).toContain('GRANT EXECUTE ON FUNCTION private.claim_sources_hidden_from_me() TO authenticated, service_role;')
  })

  it('hybrid_search never shows someone else\'s chat as a claim\'s provenance', () => {
    const [hybrid] = latestDefinition('hybrid_search').blocks
    const flat = hybrid.replace(/\s+/g, ' ')
    expect(flat).toContain("WHEN 'conversation' THEN EXISTS ( SELECT 1 FROM public.chat_conversations cc2 WHERE cc2.id = cs.source_id AND v_requester IS NOT NULL AND cc2.user_id = v_requester )")
    expect(flat).toContain("WHEN 'email' THEN FALSE")
    expect(flat).toContain('public._resolve_visibility_requester(p_requesting_user_id)')
  })

  it('claim_neighborhood: someone else\'s chat is no centre, no step and no label', () => {
    const [hood] = latestDefinition('claim_neighborhood').blocks
    const flat = hood.replace(/\s+/g, ' ')
    expect(flat).toContain("OR (p_entity_type = 'conversation' AND NOT EXISTS ( SELECT 1 FROM public.chat_conversations cc WHERE cc.id = v_center_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))")
    expect(flat).toContain("AND (nxt.node_type <> 'conversation' OR EXISTS ( SELECT 1 FROM public.chat_conversations cc WHERE cc.id = nxt.node_id AND v_requester IS NOT NULL AND cc.user_id = v_requester))")
    expect(flat).toContain("conv.workspace_id = v_workspace_id AND v_requester IS NOT NULL AND conv.user_id = v_requester")
    expect(flat).toContain("AND nxt.node_type <> 'email'")
  })
})
