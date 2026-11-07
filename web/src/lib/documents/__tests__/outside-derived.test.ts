/**
 * document.outside_derived (migration 397, F3 review R2): the server marks a
 * document whose text came from outside; a client write can neither set nor
 * clear the mark; a work run's document write after an outside read is marked.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { markIfRunReadOutside, writtenDocumentId } from '../outside-derived'
import { documentContentForModel } from '@/lib/ai/tools/documents'

const SQL = readFileSync(resolve(__dirname, '../../../../supabase/migrations/397_lens_finding.sql'), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

const DOC = '33333333-3333-4333-8333-333333333333'

describe('migration 397: document.outside_derived', () => {
  it('a not-null column, default false', () => {
    expect(SQL).toContain('alter table public.document add column if not exists outside_derived boolean not null default false')
  })

  it("client writes can't set or clear it: inserts are forced false, updates keep the old value; server paths pass", () => {
    expect(SQL).toContain("if current_user not in ('authenticated', 'anon') then return new; end if;")
    expect(SQL).toContain("if tg_op = 'INSERT' then new.outside_derived := false; else new.outside_derived := old.outside_derived; end if;")
    expect(SQL).toContain('create trigger document_guard_outside_derived before insert or update on public.document for each row execute function public.document_guard_outside_derived()')
    expect(SQL).toContain('revoke execute on function public.document_guard_outside_derived() from public, anon, authenticated')
  })

  it("the RPCs pin pg_temp in their search_path, and a post card without an expiry ages out in 7 days (review nits)", () => {
    expect(SQL.match(/security definer set search_path = public, pg_temp/g)?.length).toBe(2)
    expect(SQL).toContain("coalesce(nullif(p_card ->> 'expires_at', '')::timestamptz, now() + interval '7 days')")
  })

  it('the reference ingest marks its generated pages', () => {
    const ingest = readFileSync(resolve(__dirname, '../../inngest/reference-ingest.ts'), 'utf8')
    expect(ingest).toContain('outside_derived: true,')
  })
})

describe('reading a marked document', () => {
  it('is fenced as outside text whatever its frontmatter says', () => {
    expect(documentContentForModel('text', { generated: false }, true)).toMatch(/^\[UNTRUSTED WEB CONTENT/)
    expect(documentContentForModel('text', {}, false)).toBe('text')
  })
})

describe('a work run writing a document after an outside read', () => {
  function db(outsideReads: string[]) {
    const updates: Array<Record<string, unknown>> = []
    const client = {
      from: (table: string) => {
        const c: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) c[m] = () => c
        c.maybeSingle = async () => ({ data: table === 'agent_run' ? { outside_reads: outsideReads } : null, error: null })
        c.update = (row: Record<string, unknown>) => {
          updates.push(row)
          return c
        }
        return c
      },
    }
    return { client: client as never, updates }
  }

  it('marks it; a run that read nothing outside does not', async () => {
    const read = db(['web_search'])
    expect(await markIfRunReadOutside(read.client, { workspaceId: 'ws', agentRunId: 'r', toolName: 'create_document', input: {}, output: { success: true, document_id: DOC } })).toBe(true)
    expect(read.updates).toEqual([{ outside_derived: true }])
    const clean = db([])
    expect(await markIfRunReadOutside(clean.client, { workspaceId: 'ws', agentRunId: 'r', toolName: 'create_document', input: {}, output: { success: true, document_id: DOC } })).toBe(false)
    expect(clean.updates).toEqual([])
  })

  it('only document writes, only when they succeeded', async () => {
    const read = db(['web_search'])
    expect(await markIfRunReadOutside(read.client, { workspaceId: 'ws', agentRunId: 'r', toolName: 'list_actions', input: {}, output: { document_id: DOC } })).toBe(false)
    expect(await markIfRunReadOutside(read.client, { workspaceId: 'ws', agentRunId: 'r', toolName: 'update_document', input: { document_id: DOC }, output: { success: false } })).toBe(false)
    expect(writtenDocumentId({ document_id: DOC }, { success: true })).toBe(DOC)
  })
})
