/**
 * 708: semantic search over a file's text reads files as the attachments
 * table does (attachment_readable_by, every parent kind: a capture's rule, a
 * table row's readers only, an action's and a project's every member's).
 * supabase/tests/708_attachment_search_fence.sql runs the SQL as several
 * people; this pins the text, and follows each search function FORWARD: a
 * later migration that restates hybrid_search_attachments or
 * attachment_rag_search without the helper fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestDefinition, migrationsInOrder } from '@/test/migration-sql'

const FILE = '708_attachment_search_fence.sql'
const ALL = migrationsInOrder()
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const before708 = ALL.slice(0, ALL.findIndex((m) => m.file === FILE))

/** The newest definition of the helper, in any letter case (latestDefinition looks for upper case). */
function newestHelper(): { file: string; body: string } {
  const re = /create or replace function public\.attachment_readable_by\(p_attachment_id uuid, p_user_id uuid\)[\s\S]*?\$\$[\s\S]*?\$\$;/i
  for (let i = ALL.length - 1; i >= 0; i--) {
    const m = re.exec(ALL[i].sql)
    if (m) return { file: ALL[i].file, body: m[0] }
  }
  return { file: '(none)', body: '' }
}

describe('migration 708: the search functions ask the helper', () => {
  const FENCED = [
    { fn: 'hybrid_search_attachments', source: '275_requester_identity_search_rpcs.sql', call: 'public.attachment_readable_by(a.id, v_requester)', cut: 'LIMIT p_candidate_k' },
    { fn: 'attachment_rag_search', source: '223_capture_visibility.sql', call: 'public.attachment_readable_by(a.id, v_user_id)', cut: 'LIMIT p_limit' },
  ] as const

  for (const { fn, source, call, cut } of FENCED) {
    describe(fn, () => {
      const { file, blocks } = latestDefinition(fn, ALL)

      it(`was restated from its newest definition before 708 (${source})`, () => {
        expect(latestDefinition(fn, before708).file).toBe(source)
        expect(sql).toContain(`-- ${fn}, from ${source}`)
      })

      it(`its newest definition (${file}) fences every hit with the helper, before the candidate cut`, () => {
        expect(blocks.length, `no migration defines public.${fn}`).toBe(1)
        const b = blocks[0]
        expect(b, `${fn} in ${file} no longer asks attachment_readable_by: a private table's files reach every member`).toContain(call)
        expect(b.indexOf(call)).toBeLessThan(b.indexOf(cut))
        expect(b).toContain('SECURITY DEFINER')
        expect(b).toContain('SET search_path = public, pg_temp')
      })
    })
  }

  it('find keeps 252’s eval fence and 275’s requester resolution', () => {
    const b = latestDefinition('hybrid_search_attachments', ALL).blocks[0] ?? ''
    expect(b).toContain('NOT c.is_eval')
    expect(b).toContain('public._resolve_visibility_requester(p_requesting_user_id)')
    expect(b).toMatch(/IF v_requester IS NOT NULL AND NOT public\._is_member_of\(v_requester, p_workspace_id\) THEN/)
  })

  it('deep_search keeps its caller guard and chunk keying', () => {
    const b = latestDefinition('attachment_rag_search', ALL).blocks[0] ?? ''
    expect(b).toContain('IF auth.uid() IS NOT NULL AND auth.uid() <> v_user_id THEN')
    expect(b).toContain('WHERE ac.user_id = v_user_id')
  })
})

describe('migration 708: attachment_readable_by', () => {
  const { file, body } = newestHelper()

  it('exists, STABLE and SECURITY DEFINER with a pinned search_path', () => {
    expect(body, 'no migration defines public.attachment_readable_by').not.toBe('')
    expect(body).toMatch(/language sql\s+stable\s+security definer\s+set search_path = public, pg_temp/i)
  })

  it(`answers each of the table's read policies (${file})`, () => {
    // restrictive attachments_row_select (663): a row's file is its table's readers'.
    expect(body).toMatch(/a\.data_row_id is null\s+or \(p_user_id is not null and exists \(/)
    expect(body).toContain('public.data_table_visible_to(r.table_id, p_user_id)')
    // attachments_user_select: the uploader's own.
    expect(body).toContain('a.user_id = p_user_id')
    // attachments_workspace_select (493): a member, through the capture, grants included.
    expect(body).toContain('from public.member m where m.workspace_id = a.workspace_id and m.user_id = p_user_id')
    expect(body).toContain("c.visibility = 'workspace'")
    expect(body).toContain('c.user_id = p_user_id')
    expect(body).toContain("public.entity_grant_reaches('capture', c.id, c.workspace_id, p_user_id)")
  })

  it('lets a signed-in caller ask only about themself, and fails closed on a missing file', () => {
    expect(body).toContain('(auth.uid() is null or p_user_id is not distinct from auth.uid())')
    expect(body).toMatch(/coalesce\(\([\s\S]*\), false\)/)
  })

  it('is not granted to anon', () => {
    expect(code).toContain('revoke all on function public.attachment_readable_by(uuid, uuid) from public, anon;')
    expect(code).toContain('grant execute on function public.attachment_readable_by(uuid, uuid) to authenticated, service_role;')
    expect(code).not.toMatch(/grant [^;]*attachment_readable_by[^;]* to [^;]*anon/i)
  })
})

describe('migration 708: the file', () => {
  it('runs after 663, has no begin/commit or backslash of its own, and reloads the schema', () => {
    const files = ALL.map((m) => m.file)
    expect(files.indexOf(FILE)).toBeGreaterThan(files.findIndex((f) => f.startsWith('663_')))
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(code.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
    expect(sql.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
    expect(sql).not.toContain('\\')
    expect(sql).toMatch(/No begin\/commit of its own/)
  })

  it('drops nothing and changes no signature', () => {
    expect(code).not.toMatch(/drop (function|policy|table)/i)
  })
})
